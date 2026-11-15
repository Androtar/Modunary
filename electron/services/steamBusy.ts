import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectGameVersion, readSteamBetaBranch } from './discovery'
import {
  findBannerlordInstall,
  findSteamAppManifest,
  findSteamLibraries,
  STEAM_APP_ID,
} from './paths'

const execFileAsync = promisify(execFile)

export type SteamBusyStatus = {
  busy: boolean
  detail: string
  betaKey: string | null
  detectedVersion: string | null
  /** Human reason for UI tooltips when busy. */
  userMessage: string | null
  /** Explicit reasons checked (for UI / diagnostics). */
  reasons: string[]
  /** True when only empty leftover download dirs were seen (not busy). */
  ignoredEmptyDownloadDir?: boolean
}

function readManifestField(text: string, key: string): string | null {
  const m = text.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function dirHasFiles(root: string, maxDepth = 4): boolean {
  const walk = (dir: string, depth: number): boolean => {
    if (depth > maxDepth) return false
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (e.isFile()) return true
      if (e.isDirectory() && walk(path.join(dir, e.name), depth + 1)) return true
    }
    return false
  }
  return walk(root, 0)
}

/**
 * Steam often leaves empty `steamapps/downloading/<appid>` folders after verify.
 * Only treat as busy when the folder actually contains files.
 */
function downloadingBusy(steamapps: string): {
  reason: string | null
  emptyLeftover: boolean
} {
  const direct = path.join(steamapps, 'downloading', STEAM_APP_ID)
  if (fs.existsSync(direct)) {
    if (dirHasFiles(direct)) {
      return { reason: 'Steam download cache has files for Bannerlord (261550)', emptyLeftover: false }
    }
    return { reason: null, emptyLeftover: true }
  }
  const downloadingRoot = path.join(steamapps, 'downloading')
  if (!fs.existsSync(downloadingRoot)) return { reason: null, emptyLeftover: false }
  try {
    for (const name of fs.readdirSync(downloadingRoot)) {
      if (name === STEAM_APP_ID || name.startsWith(`${STEAM_APP_ID}_`)) {
        const full = path.join(downloadingRoot, name)
        if (dirHasFiles(full)) {
          return { reason: `Steam download/patch folder has files: ${name}`, emptyLeftover: false }
        }
        return { reason: null, emptyLeftover: true }
      }
    }
  } catch {
    // ignore
  }
  return { reason: null, emptyLeftover: false }
}

function tempBusy(steamapps: string): {
  reason: string | null
  emptyLeftover: boolean
} {
  let emptyLeftover = false
  for (const rel of ['temp', 'workshop\\downloads']) {
    const root = path.join(steamapps, ...rel.split('\\'))
    if (!fs.existsSync(root)) continue
    try {
      for (const name of fs.readdirSync(root)) {
        if (!(name.includes(STEAM_APP_ID) || name.toLowerCase().includes('bannerlord'))) {
          continue
        }
        const full = path.join(root, name)
        try {
          const st = fs.statSync(full)
          if (st.isFile() && st.size > 0) {
            return {
              reason: `Steam temp/workshop download activity (${rel}/${name})`,
              emptyLeftover: false,
            }
          }
          if (st.isDirectory()) {
            if (dirHasFiles(full)) {
              return {
                reason: `Steam temp/workshop download activity (${rel}/${name})`,
                emptyLeftover: false,
              }
            }
            // Steam leaves empty temp/261550 dirs after validate — not busy.
            emptyLeftover = true
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return { reason: null, emptyLeftover }
}

/**
 * Steam StateFlags (observed):
 * - 4 = Fully Installed (idle) — never busy by itself
 * - Updating / validating usually set additional bits (1026, 1042, …) AND often
 *   BytesToDownload > 0 or a non-empty downloading folder
 *
 * IMPORTANT: Never treat StateFlags alone as busy. Steam often leaves stale
 * updating/queued flags after a finished validate/update, which previously made
 * Modunary sit on "Waiting for Steam…" forever.
 */
function stateFlagsBusy(flags: number, corroborated: boolean): string | null {
  if (!Number.isFinite(flags) || flags === 0 || flags === 4) return null
  if (!corroborated) return null
  const knownUpdating = new Set([6, 1026, 1030, 1042, 1062, 1538, 1542])
  if (knownUpdating.has(flags)) {
    return `Steam StateFlags=${flags} (updating/validating/queued, with download activity)`
  }
  if ((flags & ~4) !== 0) {
    return `Steam StateFlags=${flags} (with download activity)`
  }
  return null
}

/**
 * List Steam process command lines, then filter in JS.
 * IMPORTANT: do not embed download/validate needles in the PowerShell -Command string —
 * that permanently self-matched and kept Activate/Launch locked after every poll.
 */
async function bannerlordProcessHint(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(steam|steamwebhelper|steamerrorreporter)\\.exe$' -and $_.CommandLine } | Select-Object -ExpandProperty CommandLine",
      ],
      { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
    )
    const appId = STEAM_APP_ID
    const needles = [
      `steam://validate/${appId}`,
      `validate/${appId}`,
      `downloading\\${appId}`,
      `downloading/${appId}`,
    ]
    for (const line of stdout.split(/\r?\n/)) {
      const cmd = line.trim()
      if (!cmd) continue
      // Never treat our own probe / node / electron as evidence.
      if (/powershell|modunary|BannerlordModApp|electron\.exe/i.test(cmd)) continue
      if (needles.some((n) => cmd.toLowerCase().includes(n.toLowerCase()))) {
        return `Steam process actively validating/updating Bannerlord (${appId})`
      }
    }
  } catch {
    // ignore — detection is best-effort
  }
  return null
}

export function getSteamBusyStatus(installPath?: string | null): SteamBusyStatus {
  const install = findBannerlordInstall(installPath ?? null)
  let manifest = findSteamAppManifest(install)
  if (!manifest) {
    for (const lib of findSteamLibraries()) {
      const acf = path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`)
      if (fs.existsSync(acf)) {
        manifest = acf
        break
      }
    }
  }

  const betaKey = readSteamBetaBranch(manifest)
  const detectedVersion = detectGameVersion(install)

  if (!manifest || !fs.existsSync(manifest)) {
    return {
      busy: false,
      detail: 'appmanifest missing',
      betaKey,
      detectedVersion,
      userMessage: null,
      reasons: [],
    }
  }

  const steamapps = path.dirname(manifest)
  const reasons: string[] = []
  let emptyLeftover = false

  const dl = downloadingBusy(steamapps)
  if (dl.reason) reasons.push(dl.reason)
  if (dl.emptyLeftover) emptyLeftover = true

  const tmp = tempBusy(steamapps)
  if (tmp.reason) reasons.push(tmp.reason)
  if (tmp.emptyLeftover) emptyLeftover = true

  let bytesDownloading = false
  let flags = 4
  try {
    const text = fs.readFileSync(manifest, 'utf8')
    flags = Number.parseInt(readManifestField(text, 'StateFlags') || '0', 10)

    const bytesTo = Number.parseInt(readManifestField(text, 'BytesToDownload') || '0', 10)
    const bytesDone = Number.parseInt(readManifestField(text, 'BytesDownloaded') || '0', 10)
    if (Number.isFinite(bytesTo) && bytesTo > 0 && bytesDone < bytesTo) {
      bytesDownloading = true
      reasons.push(`Steam downloading Bannerlord (${bytesDone}/${bytesTo} bytes)`)
    }

    const staged = readManifestField(text, 'ScheduledAutoUpdate')
    if (staged && staged !== '0') {
      reasons.push(`Steam ScheduledAutoUpdate pending (${staged})`)
    }

    const targetBuild = readManifestField(text, 'TargetBuildID')
    const build = readManifestField(text, 'buildid')
    if (targetBuild && build && targetBuild !== '0' && targetBuild !== build) {
      reasons.push(`Steam TargetBuildID ${targetBuild} ≠ buildid ${build}`)
    }

    const corroborated = reasons.length > 0 || bytesDownloading
    const flagReason = stateFlagsBusy(flags, corroborated)
    if (flagReason) reasons.push(flagReason)
  } catch {
    // ignore
  }

  const busy = reasons.length > 0
  const detailParts = [
    busy ? reasons.join('; ') : 'Steam idle',
    `StateFlags=${flags}`,
    emptyLeftover ? 'empty Steam download/temp leftover ignored' : null,
  ].filter(Boolean)
  return {
    busy,
    detail: detailParts.join(' · '),
    betaKey,
    detectedVersion,
    userMessage: busy
      ? 'Steam is installing/validating/updating Bannerlord'
      : null,
    reasons,
    ignoredEmptyDownloadDir: emptyLeftover,
  }
}

/** Async variant that also checks process command lines (best-effort). */
export async function getSteamBusyStatusAsync(
  installPath?: string | null,
): Promise<SteamBusyStatus> {
  const base = getSteamBusyStatus(installPath)
  if (base.busy) return base
  const proc = await bannerlordProcessHint()
  if (!proc) return base
  return {
    ...base,
    busy: true,
    detail: proc,
    reasons: [proc],
    userMessage: 'Steam is installing/validating/updating Bannerlord',
  }
}

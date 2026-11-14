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
}

function readManifestField(text: string, key: string): string | null {
  const m = text.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function downloadingBusy(steamapps: string): string | null {
  const direct = path.join(steamapps, 'downloading', STEAM_APP_ID)
  if (fs.existsSync(direct)) {
    return 'Steam download cache present for Bannerlord'
  }
  const downloadingRoot = path.join(steamapps, 'downloading')
  if (!fs.existsSync(downloadingRoot)) return null
  try {
    for (const name of fs.readdirSync(downloadingRoot)) {
      if (name === STEAM_APP_ID || name.startsWith(`${STEAM_APP_ID}_`) || name.includes(STEAM_APP_ID)) {
        return `Steam download/patch folder: ${name}`
      }
    }
  } catch {
    // ignore
  }
  return null
}

function tempBusy(steamapps: string): string | null {
  for (const rel of ['temp', 'workshop\\downloads']) {
    const root = path.join(steamapps, ...rel.split('\\'))
    if (!fs.existsSync(root)) continue
    try {
      const hit = fs.readdirSync(root).some(
        (n) => n.includes(STEAM_APP_ID) || n.toLowerCase().includes('bannerlord'),
      )
      if (hit) return `Steam temp/workshop download activity (${rel})`
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * Steam StateFlags cheat-sheet (bits vary by client build):
 * - 4 = Fully Installed (idle)
 * - Update Required / Updating / Validating set additional bits (e.g. 6, 1026, 1042…)
 * Treat anything other than Fully Installed (4) or missing as potentially busy when
 * combined with download bytes or a downloading folder.
 */
function stateFlagsBusy(flags: number): string | null {
  if (!Number.isFinite(flags) || flags === 0) return null
  if (flags === 4) return null
  // Common update/validate-ish values seen in the wild
  const knownUpdating = new Set([6, 1026, 1030, 1042, 1062, 1538, 1542])
  if (knownUpdating.has(flags) || (flags & ~4) !== 0) {
    return `Steam StateFlags=${flags} (updating/validating/queued)`
  }
  return null
}

async function bannerlordProcessHint(): Promise<string | null> {
  // If Steam is rewriting files, Bannerlord usually isn't running — but steam.exe
  // holding an update for 261550 is hard to see. Look for steam install workers.
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'steam|Bannerlord' -and $_.CommandLine -match '261550|Bannerlord|validate|update' } | Select-Object -First 3 -ExpandProperty CommandLine",
      ],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
    )
    const line = stdout.trim().split(/\r?\n/).find(Boolean)
    if (line) return 'Steam/Bannerlord update-related process detected'
  } catch {
    // ignore — detection is best-effort
  }
  return null
}

export function getSteamBusyStatus(installPath?: string | null): SteamBusyStatus {
  const install = findBannerlordInstall(installPath ?? null)
  let manifest = findSteamAppManifest(install)
  if (!manifest) {
    // Fall back: any library’s Bannerlord manifest
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
    }
  }

  const steamapps = path.dirname(manifest)
  const reasons: string[] = []

  const dl = downloadingBusy(steamapps)
  if (dl) reasons.push(dl)
  const tmp = tempBusy(steamapps)
  if (tmp) reasons.push(tmp)

  try {
    const text = fs.readFileSync(manifest, 'utf8')
    const flags = Number.parseInt(readManifestField(text, 'StateFlags') || '0', 10)
    const flagReason = stateFlagsBusy(flags)
    if (flagReason) reasons.push(flagReason)

    const bytesTo = Number.parseInt(readManifestField(text, 'BytesToDownload') || '0', 10)
    const bytesDone = Number.parseInt(readManifestField(text, 'BytesDownloaded') || '0', 10)
    if (Number.isFinite(bytesTo) && bytesTo > 0 && bytesDone < bytesTo) {
      reasons.push(`Steam downloading Bannerlord (${bytesDone}/${bytesTo} bytes)`)
    }

    const staged = readManifestField(text, 'ScheduledAutoUpdate')
    if (staged && staged !== '0') {
      reasons.push('Steam ScheduledAutoUpdate pending for Bannerlord')
    }

    const targetBuild = readManifestField(text, 'TargetBuildID')
    const build = readManifestField(text, 'buildid')
    if (targetBuild && build && targetBuild !== build) {
      reasons.push(`Steam TargetBuildID ${targetBuild} ≠ buildid ${build}`)
    }
  } catch {
    // ignore
  }

  const busy = reasons.length > 0
  const detail = busy ? reasons.join('; ') : 'Steam idle'
  return {
    busy,
    detail,
    betaKey,
    detectedVersion,
    userMessage: busy
      ? 'Steam is installing/validating/updating Bannerlord'
      : null,
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
    userMessage: 'Steam is installing/validating/updating Bannerlord',
  }
}

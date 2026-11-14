import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SteamVersionOption } from '../types'
import { detectGameVersion, readSteamBetaBranch } from './discovery'
import {
  findBannerlordInstall,
  findSteamAppManifest,
  getBackupsPath,
  getStorePath,
  STEAM_APP_ID,
} from './paths'

const execFileAsync = promisify(execFile)

export type { SteamVersionOption }

/**
 * TaleWorlds commonly publishes Bannerlord Steam betas as version-named branches
 * (e.g. "v1.4.8") plus named branches like "beta" / "public".
 * Steam does **not** expose a consumer Web API to list betas; publisher GetAppBetas
 * requires a Steamworks publisher key. We merge: current install, public/beta,
 * BetaKeys from backups/profiles, optional steamcmd app_info, and a curated list.
 *
 * Labels always lead with a concrete version number, e.g. "1.5.7 (Public)".
 * Options sort newest-first by release date, then by semver.
 */
type KnownBranch = {
  branch: string
  version: string
  /** ISO date for sort when steamcmd timeupdated is unavailable. */
  releasedAt?: string
  channel?: 'public' | 'beta' | 'playtest' | 'version'
}

/** Curated branches with approximate release dates (newest first in source). */
const KNOWN_BANNERLORD_BRANCHES: KnownBranch[] = [
  { branch: '', version: '1.5.7', releasedAt: '2026-11-11', channel: 'public' },
  { branch: 'beta', version: '1.5.7', releasedAt: '2026-11-10', channel: 'beta' },
  { branch: 'v1.4.8', version: '1.4.8', releasedAt: '2026-08-10', channel: 'version' },
  { branch: 'v1.4.7', version: '1.4.7', releasedAt: '2026-07-09', channel: 'version' },
  { branch: 'v1.4.6', version: '1.4.6', releasedAt: '2026-06-11', channel: 'version' },
  { branch: 'v1.4.5', version: '1.4.5', releasedAt: '2026-05-21', channel: 'version' },
  { branch: 'v1.3.15', version: '1.3.15', releasedAt: '2026-03-02', channel: 'version' },
  { branch: 'v1.3.14', version: '1.3.14', releasedAt: '2026-02-03', channel: 'version' },
  { branch: 'v1.3.13', version: '1.3.13', releasedAt: '2025-12-30', channel: 'version' },
  { branch: 'v1.3.12', version: '1.3.12', releasedAt: '2025-12-15', channel: 'version' },
  { branch: 'v1.3.11', version: '1.3.11', releasedAt: '2025-12-19', channel: 'version' },
  { branch: 'v1.3.10', version: '1.3.10', releasedAt: '2025-12-10', channel: 'version' },
  { branch: 'v1.3.9', version: '1.3.9', releasedAt: '2025-12-04', channel: 'version' },
  { branch: 'v1.3.8', version: '1.3.8', releasedAt: '2025-12-01', channel: 'version' },
  { branch: 'v1.3.7', version: '1.3.7', releasedAt: '2025-11-28', channel: 'version' },
  { branch: 'v1.3.6', version: '1.3.6', releasedAt: '2025-11-27', channel: 'version' },
  { branch: 'v1.3.5', version: '1.3.5', releasedAt: '2025-11-26', channel: 'version' },
  { branch: 'v1.3.4', version: '1.3.4', releasedAt: '2025-11-26', channel: 'version' },
  { branch: 'v1.3.3', version: '1.3.3', releasedAt: '2025-11-20', channel: 'version' },
  { branch: 'v1.3.2', version: '1.3.2', releasedAt: '2025-11-15', channel: 'version' },
  { branch: 'v1.3.1', version: '1.3.1', releasedAt: '2025-11-10', channel: 'version' },
  { branch: 'v1.3.0', version: '1.3.0', releasedAt: '2025-11-01', channel: 'version' },
  { branch: 'v1.2.12', version: '1.2.12', releasedAt: '2025-06-17', channel: 'version' },
  { branch: 'v1.2.11', version: '1.2.11', releasedAt: '2024-08-09', channel: 'version' },
  { branch: 'v1.2.10', version: '1.2.10', releasedAt: '2024-07-24', channel: 'version' },
  { branch: 'v1.2.9', version: '1.2.9', releasedAt: '2024-04-26', channel: 'version' },
  { branch: 'v1.2.8', version: '1.2.8', releasedAt: '2023-12-21', channel: 'version' },
  { branch: 'playtest', version: 'playtest', releasedAt: '2023-01-01', channel: 'playtest' },
]

const KNOWN_BY_BRANCH = new Map(KNOWN_BANNERLORD_BRANCHES.map((k) => [k.branch.toLowerCase(), k]))

function normalizeBranch(branch: string): string {
  const b = (branch || '').trim()
  if (!b || b === 'public' || b === 'none' || b === 'default') return ''
  return b
}

function branchToVersion(branch: string): string {
  const b = normalizeBranch(branch)
  if (!b) return ''
  const known = KNOWN_BY_BRANCH.get(b.toLowerCase())
  if (known?.version && known.version !== 'playtest' && known.version !== 'beta') {
    return known.version
  }
  if (/^v?\d+(\.\d+)+/i.test(b)) return b.replace(/^v/i, '')
  const descMatch = b.match(/v?(\d+\.\d+\.\d+)/i)
  if (descMatch) return descMatch[1]
  return b.replace(/^v/i, '')
}

function parseVersionParts(version: string): number[] | null {
  const cleaned = version.replace(/^v/i, '').trim()
  if (!/^\d+(\.\d+)*/.test(cleaned)) return null
  return cleaned.split('.').map((p) => {
    const n = Number.parseInt(p, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** Higher = newer. Non-semver sorts to the bottom. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  if (!pa && !pb) return b.localeCompare(a)
  if (!pa) return 1
  if (!pb) return -1
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return db - da
  }
  return 0
}

function channelSuffix(branch: string, channel?: KnownBranch['channel']): string {
  const b = normalizeBranch(branch)
  if (!b) return 'Public'
  if (channel === 'beta' || b.toLowerCase() === 'beta') return 'beta'
  if (channel === 'playtest' || b.toLowerCase() === 'playtest') return 'playtest'
  if (b.toLowerCase().startsWith('v') || /^\d/.test(b)) return b.startsWith('v') ? b : `v${b}`
  return b
}

function formatPrimaryLabel(version: string, branch: string, channel?: KnownBranch['channel']): string {
  const ver = (version || '').replace(/^v/i, '').trim() || 'unknown'
  const suffix = channelSuffix(branch, channel)
  // Version-named branches: "1.4.8" is enough when branch is v1.4.8
  if (channel === 'version' || (/^v?\d+(\.\d+)+$/i.test(normalizeBranch(branch)) && suffix.replace(/^v/i, '') === ver)) {
    return ver
  }
  return `${ver} (${suffix})`
}

function formatReleasedAtLabel(iso?: string): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso.includes('T') ? iso : `${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function isConcreteVersion(version: string): boolean {
  return Boolean(parseVersionParts(version))
}

function upsert(map: Map<string, SteamVersionOption>, opt: SteamVersionOption): void {
  const key = normalizeBranch(opt.steamBetaBranch).toLowerCase()
  const existing = map.get(key)
  if (!existing) {
    map.set(key, opt)
    return
  }
  const sourceRank = (s: SteamVersionOption['source']) =>
    ({ current: 0, steamcmd: 1, public: 2, 'manifest-history': 3, 'profile-history': 4, known: 5 })[s]
  const merged: SteamVersionOption = {
    ...existing,
    note: opt.note || existing.note,
    secondaryLabel: opt.secondaryLabel || existing.secondaryLabel,
    releasedAt: opt.releasedAt || existing.releasedAt,
    gameVersion: isConcreteVersion(opt.gameVersion)
      ? opt.gameVersion
      : isConcreteVersion(existing.gameVersion)
        ? existing.gameVersion
        : opt.gameVersion || existing.gameVersion,
    steamBetaBranch: opt.steamBetaBranch || existing.steamBetaBranch,
    source: sourceRank(opt.source) < sourceRank(existing.source) ? opt.source : existing.source,
  }
  // Prefer steamcmd/current labels when they already lead with a concrete version.
  const preferOptLabel =
    opt.source === 'current' ||
    (isConcreteVersion(opt.gameVersion) && !isConcreteVersion(existing.gameVersion)) ||
    (opt.source === 'steamcmd' && existing.source === 'known') ||
    (opt.source === 'public' && existing.source === 'known')
  merged.label = preferOptLabel ? opt.label : existing.label || opt.label
  if (opt.source === 'current') {
    merged.source = 'current'
    merged.label = opt.label
    merged.note = opt.note || merged.note
  }
  map.set(key, merged)
}

function collectBetaKeysFromBackups(): string[] {
  const dir = getBackupsPath()
  if (!fs.existsSync(dir)) return []
  const keys = new Set<string>()
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('appmanifest_') || !name.endsWith('.acf')) continue
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const m of text.matchAll(/"BetaKey"\s+"([^"]*)"/g)) {
        keys.add(m[1])
      }
    } catch {
      // ignore
    }
  }
  return [...keys]
}

function collectFromProfiles(): Array<{ version: string; branch: string }> {
  try {
    const storePath = getStorePath()
    if (!fs.existsSync(storePath)) return []
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      profiles?: Array<{ gameVersion?: string; steamBetaBranch?: string }>
    }
    return (raw.profiles || [])
      .filter((p) => p.gameVersion || p.steamBetaBranch)
      .map((p) => ({
        version: p.gameVersion || branchToVersion(p.steamBetaBranch || ''),
        branch: normalizeBranch(p.steamBetaBranch || ''),
      }))
  } catch {
    return []
  }
}

type SteamCmdBranch = {
  branch: string
  buildid?: string
  timeupdated?: string
  description?: string
}

async function trySteamCmdBranches(): Promise<SteamCmdBranch[]> {
  const candidates = [
    'steamcmd',
    path.join('C:\\steamcmd', 'steamcmd.exe'),
    path.join('D:\\steamcmd', 'steamcmd.exe'),
    path.join('E:\\steamcmd', 'steamcmd.exe'),
  ]
  let bin: string | null = null
  for (const c of candidates) {
    try {
      if (c === 'steamcmd') {
        await execFileAsync('where', ['steamcmd'], { windowsHide: true })
        bin = 'steamcmd'
        break
      }
      if (fs.existsSync(c)) {
        bin = c
        break
      }
    } catch {
      // continue
    }
  }
  if (!bin) return []

  try {
    const { stdout } = await execFileAsync(
      bin,
      ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', STEAM_APP_ID, '+quit'],
      { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    )
    const branches: SteamCmdBranch[] = []
    const branchBlock = stdout.match(/"branches"\s*\{([\s\S]*?)\n\t\}/)
    const body = branchBlock?.[1] || stdout
    // Match each "name" { ... } under branches
    for (const m of body.matchAll(/"([^"]+)"\s*\{([^}]*)\}/g)) {
      const name = m[1]
      const block = m[2]
      if (!/"buildid"\s+"/.test(block) && !/"timeupdated"\s+"/.test(block)) continue
      const buildid = block.match(/"buildid"\s+"(\d+)"/)?.[1]
      const timeupdated = block.match(/"timeupdated"\s+"(\d+)"/)?.[1]
      const description = block.match(/"description"\s+"([^"]*)"/)?.[1]
      branches.push({
        branch: name === 'public' ? '' : name,
        buildid,
        timeupdated,
        description,
      })
    }
    return branches
  } catch {
    return []
  }
}

function versionFromDescription(description?: string): string | null {
  if (!description) return null
  const m = description.match(/v?(\d+\.\d+\.\d+)/i)
  return m ? m[1] : null
}

function unixToIso(unix?: string): string | undefined {
  if (!unix) return undefined
  const n = Number.parseInt(unix, 10)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n * 1000).toISOString()
}

function buildOption(input: {
  branch: string
  version: string
  source: SteamVersionOption['source']
  channel?: KnownBranch['channel']
  releasedAt?: string
  note?: string
  description?: string
}): SteamVersionOption {
  const branch = normalizeBranch(input.branch)
  let version = (input.version || '').replace(/^v/i, '').trim()
  if (!version || version === 'public' || version === 'beta' || version === 'playtest') {
    version =
      versionFromDescription(input.description) ||
      branchToVersion(branch) ||
      KNOWN_BY_BRANCH.get(branch.toLowerCase())?.version ||
      (branch ? branch.replace(/^v/i, '') : 'unknown')
  }
  if (version === 'public' || version === 'beta') {
    version = KNOWN_BY_BRANCH.get(branch.toLowerCase())?.version || version
  }
  const channel =
    input.channel ||
    KNOWN_BY_BRANCH.get(branch.toLowerCase())?.channel ||
    (!branch ? 'public' : branch.toLowerCase() === 'beta' ? 'beta' : 'version')
  const releasedAt =
    input.releasedAt || KNOWN_BY_BRANCH.get(branch.toLowerCase())?.releasedAt
  const label = formatPrimaryLabel(version, branch, channel)
  const dateLabel = formatReleasedAtLabel(releasedAt)
  return {
    label,
    gameVersion: version,
    steamBetaBranch: branch,
    source: input.source,
    note: input.note || input.description || undefined,
    releasedAt,
    secondaryLabel: [
      channel === 'public'
        ? 'Steam public / live branch'
        : channel === 'beta'
          ? `Steam beta branch${input.description ? ` — ${input.description}` : ''}`
          : branch
            ? `Steam branch ${branch}`
            : undefined,
      dateLabel ? `Released ${dateLabel}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

export async function listSteamBannerlordVersions(
  gameInstallOverride?: string | null,
): Promise<{ options: SteamVersionOption[]; notes: string[] }> {
  const notes: string[] = [
    'Steam does not provide a consumer API to list Bannerlord beta branches. Publisher GetAppBetas requires a Steamworks publisher key.',
    'Modunary merges: current install, public/beta, BetaKeys from backups & profiles, optional steamcmd app_info, and known TaleWorlds branches. Sorted newest-first.',
  ]
  const map = new Map<string, SteamVersionOption>()

  const install = findBannerlordInstall(gameInstallOverride ?? null)
  const manifest = findSteamAppManifest(install)
  const detected = detectGameVersion(install)
  const currentBeta = normalizeBranch(readSteamBetaBranch(manifest) || '')
  const publicKnown = KNOWN_BY_BRANCH.get('')

  // Public live
  upsert(
    map,
    buildOption({
      branch: '',
      version: !currentBeta && detected ? detected : publicKnown?.version || detected || '1.5.7',
      source: 'public',
      channel: 'public',
      releasedAt: publicKnown?.releasedAt,
      note: 'Clears BetaKey so Steam uses the live branch.',
    }),
  )

  // Enrich the matching branch with current-install metadata (keep concrete primary label).
  if (detected || currentBeta) {
    const channel: KnownBranch['channel'] = !currentBeta
      ? 'public'
      : currentBeta.toLowerCase() === 'beta'
        ? 'beta'
        : 'version'
    upsert(
      map,
      buildOption({
        branch: currentBeta,
        version: detected || branchToVersion(currentBeta) || 'unknown',
        source: 'current',
        channel,
        note: manifest ? `Current install · ${manifest}` : 'Current install',
      }),
    )
    const key = normalizeBranch(currentBeta).toLowerCase()
    const cur = map.get(key)
    if (cur) {
      cur.source = 'current'
      cur.secondaryLabel = [
        'Current install',
        cur.secondaryLabel,
        manifest ? path.basename(manifest) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      // Ensure primary stays version-led, e.g. "1.5.7 (Public)"
      cur.label = formatPrimaryLabel(cur.gameVersion, cur.steamBetaBranch, channel)
      map.set(key, cur)
    }
  }

  for (const key of collectBetaKeysFromBackups()) {
    const branch = normalizeBranch(key)
    if (!branch) continue
    upsert(
      map,
      buildOption({
        branch,
        version: branchToVersion(branch),
        source: 'manifest-history',
        note: 'Seen in activation backup BetaKey.',
      }),
    )
  }

  for (const p of collectFromProfiles()) {
    upsert(
      map,
      buildOption({
        branch: p.branch,
        version: p.version,
        source: 'profile-history',
        note: 'From an existing Modunary profile.',
      }),
    )
  }

  const cmdBranches = await trySteamCmdBranches()
  if (cmdBranches.length) {
    notes.push(`steamcmd returned ${cmdBranches.length} branch entr(y/ies).`)
    for (const b of cmdBranches) {
      // Skip junk / local content server branches that aren't version picks
      const name = normalizeBranch(b.branch)
      if (name.toLowerCase() === 'local' || name.toLowerCase().includes('perf_test')) continue
      const fromDesc = versionFromDescription(b.description)
      const known = KNOWN_BY_BRANCH.get(name.toLowerCase())
      upsert(
        map,
        buildOption({
          branch: name,
          version: fromDesc || branchToVersion(name) || known?.version || name || 'unknown',
          source: 'steamcmd',
          channel: !name ? 'public' : name.toLowerCase() === 'beta' ? 'beta' : known?.channel || 'version',
          releasedAt: unixToIso(b.timeupdated) || known?.releasedAt,
          description: b.description,
          note: b.buildid ? `steamcmd build ${b.buildid}` : 'From steamcmd app_info',
        }),
      )
    }
  } else {
    notes.push('steamcmd not found or app_info failed — using known branch list + local history.')
  }

  for (const k of KNOWN_BANNERLORD_BRANCHES) {
    upsert(
      map,
      buildOption({
        branch: k.branch,
        version: k.version,
        source: k.channel === 'public' ? 'public' : 'known',
        channel: k.channel,
        releasedAt: k.releasedAt,
        note: 'Curated TaleWorlds-style branch; may not exist for every account/region.',
      }),
    )
  }

  const options = [...map.values()].sort((a, b) => {
    const ta = a.releasedAt ? Date.parse(a.releasedAt) : 0
    const tb = b.releasedAt ? Date.parse(b.releasedAt) : 0
    if (ta !== tb) return tb - ta
    const ver = compareVersionsDesc(a.gameVersion, b.gameVersion)
    if (ver !== 0) return ver
    // Prefer current, then public, then others for equal versions
    const rank = (s: SteamVersionOption['source']) =>
      ({ current: 0, public: 1, steamcmd: 2, 'manifest-history': 3, 'profile-history': 4, known: 5 })[s]
    return rank(a.source) - rank(b.source)
  })

  return { options, notes }
}

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
 * (e.g. "v1.3.15"). Steam does **not** expose a consumer Web API to list betas;
 * publisher GetAppBetas requires a Steamworks publisher key. We therefore merge:
 * current install, public, BetaKeys seen in our backups/profiles, optional
 * steamcmd app_info, and a curated known-branch list.
 */
const KNOWN_BANNERLORD_BRANCHES: Array<{ branch: string; version: string }> = [
  { branch: '', version: 'public' },
  { branch: 'v1.2.12', version: '1.2.12' },
  { branch: 'v1.2.11', version: '1.2.11' },
  { branch: 'v1.2.9', version: '1.2.9' },
  { branch: 'v1.2.8', version: '1.2.8' },
  { branch: 'v1.3.15', version: '1.3.15' },
  { branch: 'v1.3.14', version: '1.3.14' },
  { branch: 'v1.3.13', version: '1.3.13' },
  { branch: 'v1.3.12', version: '1.3.12' },
  { branch: 'v1.3.11', version: '1.3.11' },
  { branch: 'v1.3.10', version: '1.3.10' },
  { branch: 'v1.3.9', version: '1.3.9' },
  { branch: 'v1.3.8', version: '1.3.8' },
  { branch: 'v1.3.7', version: '1.3.7' },
  { branch: 'v1.3.6', version: '1.3.6' },
  { branch: 'v1.3.5', version: '1.3.5' },
  { branch: 'v1.3.4', version: '1.3.4' },
  { branch: 'v1.3.3', version: '1.3.3' },
  { branch: 'v1.3.2', version: '1.3.2' },
  { branch: 'v1.3.1', version: '1.3.1' },
  { branch: 'v1.3.0', version: '1.3.0' },
  { branch: 'beta', version: 'beta' },
  { branch: 'playtest', version: 'playtest' },
]

function branchToVersion(branch: string): string {
  if (!branch || branch === 'public' || branch === 'none' || branch === 'default') {
    return 'public'
  }
  return branch.replace(/^v/i, '')
}

function upsert(
  map: Map<string, SteamVersionOption>,
  opt: SteamVersionOption,
): void {
  const key = `${opt.steamBetaBranch.toLowerCase()}|${opt.gameVersion.toLowerCase()}`
  if (!map.has(key)) map.set(key, opt)
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
        branch: p.steamBetaBranch || '',
      }))
  } catch {
    return []
  }
}

async function trySteamCmdBranches(): Promise<Array<{ branch: string; buildid?: string }>> {
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
    const branches: Array<{ branch: string; buildid?: string }> = []
    // Rough parse of "branches" { "public" { "buildid" "..." } "v1.3.15" { ... } }
    const branchBlock = stdout.match(/"branches"\s*\{([\s\S]*?)\n\t\}/)
    const body = branchBlock?.[1] || stdout
    for (const m of body.matchAll(/"([^"]+)"\s*\{\s*"buildid"\s+"(\d+)"/g)) {
      branches.push({ branch: m[1] === 'public' ? '' : m[1], buildid: m[2] })
    }
    return branches
  } catch {
    return []
  }
}

export async function listSteamBannerlordVersions(
  gameInstallOverride?: string | null,
): Promise<{ options: SteamVersionOption[]; notes: string[] }> {
  const notes: string[] = [
    'Steam does not provide a consumer API to list Bannerlord beta branches. Publisher GetAppBetas requires a Steamworks publisher key.',
    'Modunary merges: current install, public branch, BetaKeys from activation backups & profiles, optional steamcmd app_info, and known TaleWorlds version-named branches.',
  ]
  const map = new Map<string, SteamVersionOption>()

  const install = findBannerlordInstall(gameInstallOverride ?? null)
  const manifest = findSteamAppManifest(install)
  const detected = detectGameVersion(install)
  const currentBeta = readSteamBetaBranch(manifest)

  upsert(map, {
    label: detected
      ? `Current install — ${detected}${currentBeta ? ` (BetaKey ${currentBeta})` : ' (public)'}`
      : `Current install${currentBeta ? ` (BetaKey ${currentBeta})` : ''}`,
    gameVersion: detected || branchToVersion(currentBeta || ''),
    steamBetaBranch: currentBeta && !['public', 'none', 'default'].includes(currentBeta)
      ? currentBeta
      : currentBeta === 'public'
        ? ''
        : currentBeta || '',
    source: 'current',
    note: manifest || undefined,
  })

  upsert(map, {
    label: 'Steam public (default / live)',
    gameVersion: 'public',
    steamBetaBranch: '',
    source: 'public',
    note: 'Clears BetaKey so Steam uses the live branch.',
  })

  for (const key of collectBetaKeysFromBackups()) {
    if (!key || key === 'public' || key === 'none' || key === 'default') continue
    upsert(map, {
      label: `From backup — ${key}`,
      gameVersion: branchToVersion(key),
      steamBetaBranch: key,
      source: 'manifest-history',
    })
  }

  for (const p of collectFromProfiles()) {
    upsert(map, {
      label: `From profile history — ${p.branch || p.version}`,
      gameVersion: p.version,
      steamBetaBranch: p.branch,
      source: 'profile-history',
    })
  }

  const cmdBranches = await trySteamCmdBranches()
  if (cmdBranches.length) {
    notes.push(`steamcmd returned ${cmdBranches.length} branch entr(y/ies).`)
    for (const b of cmdBranches) {
      upsert(map, {
        label: `steamcmd — ${b.branch || 'public'}${b.buildid ? ` (build ${b.buildid})` : ''}`,
        gameVersion: branchToVersion(b.branch),
        steamBetaBranch: b.branch,
        source: 'steamcmd',
      })
    }
  } else {
    notes.push('steamcmd not found or app_info failed — using known branch list + local history.')
  }

  for (const k of KNOWN_BANNERLORD_BRANCHES) {
    if (!k.branch) continue
    upsert(map, {
      label: `Known Steam beta — ${k.branch}`,
      gameVersion: k.version,
      steamBetaBranch: k.branch,
      source: 'known',
      note: 'Curated TaleWorlds-style version branch; may not exist for every account/region.',
    })
  }

  // Prefer current / public / steamcmd first in the UI.
  const rank = (s: SteamVersionOption['source']) =>
    ({ current: 0, public: 1, steamcmd: 2, 'manifest-history': 3, 'profile-history': 4, known: 5 })[s]
  const options = [...map.values()].sort((a, b) => {
    const r = rank(a.source) - rank(b.source)
    if (r !== 0) return r
    return a.label.localeCompare(b.label)
  })

  return { options, notes }
}

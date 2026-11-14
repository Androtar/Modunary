import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ActivateResult, ModProfile } from '../types'
import { discoverGame } from './discovery'
import {
  backupLauncherData,
  writeLauncherData,
} from './launcherData'
import { getBackupsPath, STEAM_APP_ID } from './paths'
import { loadStore, saveStore } from './profiles'

const execFileAsync = promisify(execFile)

function compareLooseVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/^v/i, '').split('.').slice(0, 3).join('.')
  return norm(a) === norm(b)
}

async function tryOpenSteamBetas(): Promise<string> {
  try {
    await execFileAsync('cmd', ['/c', `start steam://open/games`], { windowsHide: true })
    return 'Opened Steam. Use Properties → Betas to switch Bannerlord branches if needed.'
  } catch {
    return 'Could not open Steam automatically. Switch Bannerlord beta/version manually in Steam.'
  }
}

/**
 * Best-effort version handling.
 * Bannerlord versions are Steam depot/build based. Writing LauncherData cannot
 * change the binary version. We compare detected vs desired and guide the user.
 * Optionally we can attempt to set BetaKey in appmanifest (Steam may overwrite
 * it; Steam client must be restarted / verify). We do NOT rewrite the manifest
 * by default — too unsafe without explicit user opt-in.
 */
export async function activateProfile(profileId: string): Promise<ActivateResult> {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === profileId)
  if (!profile) throw new Error('Profile not found.')

  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  const warnings: string[] = []
  const versionNotes: string[] = []

  if (!discovery.launcherDataPath) {
    throw new Error('Documents path / LauncherData.xml location is unknown.')
  }

  // Warn about missing module folders
  const installedIds = new Set(discovery.mods.map((m) => m.id))
  for (const mod of profile.mods.filter((m) => m.enabled)) {
    if (!installedIds.has(mod.id)) {
      warnings.push(`Enabled mod "${mod.name}" (${mod.id}) is not present under Modules.`)
    }
  }

  let backupPath: string | null = null
  if (profile.settings.autoBackupLauncherData !== false) {
    backupPath = backupLauncherData(
      discovery.launcherDataPath,
      getBackupsPath(),
      profile.name,
    )
  }

  // Deploy order + enabled flags via official launcher file.
  writeLauncherData(discovery.launcherDataPath, profile.mods)

  // Also mirror into Documents/Configs/ModProfiles/<name>/ for familiarity with
  // existing manual profile folders on this machine.
  if (discovery.documentsPath) {
    const mirrorDir = path.join(discovery.documentsPath, 'Configs', 'ModProfiles', profile.name)
    fs.mkdirSync(mirrorDir, { recursive: true })
    fs.copyFileSync(
      discovery.launcherDataPath,
      path.join(mirrorDir, 'LauncherData.xml'),
    )
  }

  const detected = discovery.detectedGameVersion
  if (profile.gameVersion && profile.gameVersion !== 'unknown') {
    if (!detected) {
      versionNotes.push(
        `Profile wants Bannerlord ${profile.gameVersion}, but current install version could not be detected.`,
      )
    } else if (!compareLooseVersion(detected, profile.gameVersion)) {
      versionNotes.push(
        `Profile wants Bannerlord ${profile.gameVersion}; install currently reports ${detected}.`,
      )
      versionNotes.push(
        'Steam controls game binaries. Switch version via Steam → Bannerlord → Properties → Betas (or install the matching build), then re-activate if needed.',
      )
      if (profile.steamBetaBranch) {
        versionNotes.push(`Suggested Steam beta branch: "${profile.steamBetaBranch}".`)
      }
      versionNotes.push(await tryOpenSteamBetas())
    } else {
      versionNotes.push(`Game version matches profile (${detected}).`)
    }
  } else {
    versionNotes.push(
      detected
        ? `No specific version pinned on profile. Current install: ${detected}.`
        : 'No game version detected or pinned.',
    )
  }

  store.activeProfileId = profile.id
  store.lastActivatedAt = new Date().toISOString()
  store.lastActivationNotes = [...versionNotes, ...warnings]
  saveStore(store)

  return {
    ok: warnings.length === 0,
    profileId: profile.id,
    backupPath,
    launcherDataPath: discovery.launcherDataPath,
    versionNotes,
    warnings,
  }
}

export function describeVersionStrategy(profile: ModProfile): string[] {
  return [
    `Profile "${profile.name}" targets Bannerlord ${profile.gameVersion || 'unknown'}.`,
    'Activation writes Documents/.../Configs/LauncherData.xml (mod order + enabled flags).',
    'Game binary/version switching is owned by Steam (or GOG/Xbox). This app remembers the desired version and warns on mismatch.',
    'Safe default: do not rewrite Steam appmanifest BetaKey automatically.',
    `Steam app id: ${STEAM_APP_ID}.`,
  ]
}

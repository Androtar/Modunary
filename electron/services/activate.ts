import fs from 'node:fs'
import path from 'node:path'
import type { ActivateOptions, ActivateResult, ModProfile } from '../types'
import { discoverGame } from './discovery'
import { backupLauncherData, writeLauncherData } from './launcherData'
import { getBackupsPath } from './paths'
import { createProfile, loadStore, saveStore } from './profiles'
import {
  attemptSteamVersionSwitch,
  compareLooseVersion,
  resolveDesiredBetaKey,
} from './steamVersion'
import { deployProfileVault, importModulesIntoVault } from './vault'

function versionMismatch(
  profile: ModProfile,
  detected: string | null,
  currentBeta: string | null,
): boolean {
  const desiredBeta = resolveDesiredBetaKey(profile.gameVersion, profile.steamBetaBranch)
  if (desiredBeta && currentBeta) {
    return desiredBeta.toLowerCase() !== currentBeta.toLowerCase()
  }
  if (desiredBeta && !currentBeta) {
    // Profile wants a beta branch; install is on public / unknown.
    return true
  }
  if (!profile.gameVersion || profile.gameVersion === 'unknown') return false
  if (!detected) return Boolean(desiredBeta)
  return !compareLooseVersion(detected, profile.gameVersion)
}

/**
 * Activate a profile: optional version-switch gate, vault deploy, LauncherData write.
 */
export async function activateProfile(
  profileId: string,
  options: ActivateOptions = {},
): Promise<ActivateResult> {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === profileId)
  if (!profile) throw new Error('Profile not found.')

  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  const warnings: string[] = []
  const versionNotes: string[] = []
  const vaultNotes: string[] = []

  if (!discovery.launcherDataPath) {
    throw new Error('Documents path / LauncherData.xml location is unknown.')
  }
  if (!discovery.modulesPath) {
    throw new Error('Modules path unknown. Set the game install path.')
  }

  const mismatch = versionMismatch(
    profile,
    discovery.detectedGameVersion,
    discovery.steamBetaBranch,
  )

  // Gate: require explicit Continue from the version-switch modal.
  if (mismatch && !options.confirmVersionSwitch) {
    return {
      ok: false,
      profileId: profile.id,
      backupPath: null,
      launcherDataPath: discovery.launcherDataPath,
      versionNotes: [
        `This profile requires Bannerlord ${profile.gameVersion}; install currently reports ${discovery.detectedGameVersion ?? 'unknown'}.`,
      ],
      warnings: [],
      vaultNotes: [],
      needsVersionSwitchConfirm: true,
      requiredVersion: profile.gameVersion,
      currentVersion: discovery.detectedGameVersion,
    }
  }

  // Continue path: optionally save unsaved current profile as a copy first.
  if (options.saveUnsavedAs?.trim()) {
    const name = options.saveUnsavedAs.trim()
    const currentId = store.activeProfileId
    if (currentId && currentId !== profile.id) {
      const current = store.profiles.find((p) => p.id === currentId)
      if (current) {
        createProfile({
          name,
          captureCurrent: true,
          gameVersion: discovery.detectedGameVersion || current.gameVersion,
        })
        versionNotes.push(`Saved current loadout as new profile "${name}" before switching.`)
      }
    }
  }

  // Reload after possible createProfile so we don't clobber the new profile on save.
  const storeLive = loadStore()
  const profileLive = storeLive.profiles.find((p) => p.id === profileId)
  if (!profileLive) throw new Error('Profile not found after save-as.')

  // Attempt Steam version switch only after Continue + opt-in.
  let steamVersionSwitchAttempted = false
  let steamVersionSwitchOk = false
  if (
    mismatch &&
    options.confirmVersionSwitch &&
    options.attemptSteamVersionSwitch !== false &&
    store.allowSteamBetaKeyWrite !== false
  ) {
    const betaKey = resolveDesiredBetaKey(profile.gameVersion, profile.steamBetaBranch)
    const switchResult = await attemptSteamVersionSwitch(discovery.installPath, betaKey)
    steamVersionSwitchAttempted = switchResult.attempted
    steamVersionSwitchOk = switchResult.ok
    versionNotes.push(...switchResult.notes)
  } else if (mismatch && options.confirmVersionSwitch) {
    versionNotes.push(
      'Version switch confirmed, but Steam BetaKey write is disabled in settings. Switch Betas manually in Steam.',
    )
  } else if (!mismatch) {
    versionNotes.push(
      discovery.detectedGameVersion
        ? `Game version matches profile (${discovery.detectedGameVersion}).`
        : 'No game version detected; proceeding with vault + launcher deploy.',
    )
  }

  // Ensure current Modules community mods are vaulted before we park/redeploy.
  if (discovery.modulesPath) {
    const imported = importModulesIntoVault(discovery.modulesPath)
    if (imported.imported.length) {
      vaultNotes.push(`Imported ${imported.imported.length} module folder(s) into vault before deploy.`)
    }
  }

  const vault = deployProfileVault(discovery.modulesPath, profileLive)
  vaultNotes.push(...vault.notes)
  warnings.push(...vault.warnings)

  // Refresh discovery after vault deploy for presence checks
  const after = discoverGame(storeLive.gameInstallPath, storeLive.documentsPath)
  const installedIds = new Set(after.mods.map((m) => m.id))
  for (const mod of profileLive.mods.filter((m) => m.enabled)) {
    if (!installedIds.has(mod.id)) {
      warnings.push(
        `Enabled mod "${mod.name}" (${mod.id}) is not present under Modules after vault deploy.`,
      )
    }
  }

  let backupPath: string | null = null
  if (profileLive.settings.autoBackupLauncherData !== false) {
    backupPath = backupLauncherData(
      discovery.launcherDataPath,
      getBackupsPath(),
      profileLive.name,
    )
  }

  writeLauncherData(discovery.launcherDataPath, profileLive.mods)

  if (discovery.documentsPath) {
    const mirrorDir = path.join(
      discovery.documentsPath,
      'Configs',
      'ModProfiles',
      profileLive.name,
    )
    fs.mkdirSync(mirrorDir, { recursive: true })
    fs.copyFileSync(
      discovery.launcherDataPath,
      path.join(mirrorDir, 'LauncherData.xml'),
    )
  }

  // Mark previous active as inactive by setting the new one.
  storeLive.activeProfileId = profileLive.id
  storeLive.lastActivatedAt = new Date().toISOString()
  storeLive.lastActivationNotes = [...versionNotes, ...vaultNotes, ...warnings]
  const target = storeLive.profiles.find((p) => p.id === profileLive.id)
  if (target) target.dirty = false
  saveStore(storeLive)

  return {
    ok: warnings.length === 0,
    profileId: profileLive.id,
    backupPath,
    launcherDataPath: discovery.launcherDataPath,
    versionNotes,
    warnings,
    vaultNotes,
    steamVersionSwitchAttempted,
    steamVersionSwitchOk,
  }
}

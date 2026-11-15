import fs from 'node:fs'
import path from 'node:path'
import type {
  ActivateOptions,
  ActivateProgressEvent,
  ActivateResult,
  ModProfile,
} from '../types'
import {
  beginActivateLock,
  endActivateLock,
  reportActivateLockProgress,
  assertOperationAllowed,
} from './activateLock'
import { discoverGame } from './discovery'
import { backupLauncherData, writeLauncherData } from './launcherData'
import { getBackupsPath } from './paths'
import { createProfile, loadStore, saveStore } from './profiles'
import {
  attemptSteamVersionSwitch,
  compareLooseVersion,
  resolveDesiredBetaKey,
} from './steamVersion'
import { waitForSteamVersionSettle } from './steamUpdateWait'
import { getSteamBusyStatus } from './steamBusy'
import { deployProfileVault, importModulesIntoVault } from './vault'

export type ActivateProgressReporter = (event: ActivateProgressEvent) => void

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
    return true
  }
  if (!profile.gameVersion || profile.gameVersion === 'unknown') return false
  if (!detected) return Boolean(desiredBeta)
  return !compareLooseVersion(detected, profile.gameVersion)
}

function report(
  onProgress: ActivateProgressReporter | undefined,
  event: ActivateProgressEvent,
) {
  try {
    reportActivateLockProgress(event)
    onProgress?.(event)
  } catch {
    // UI progress must never break activate.
  }
}

/**
 * Activate a profile: optional version-switch gate, vault deploy, LauncherData write.
 * Holds a global lock for the whole mutating path (incl. Steam settle).
 */
export async function activateProfile(
  profileId: string,
  options: ActivateOptions = {},
  onProgress?: ActivateProgressReporter,
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

  // Gate only — no lock, no disk mutation.
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

  // Refuse if Steam is mid-update unless this Continue path will drive/wait on the switch.
  const allowSteamBusy = Boolean(mismatch && options.confirmVersionSwitch)
  assertOperationAllowed('activate', { allowSteamBusy })

  beginActivateLock({
    profileId: profile.id,
    profileName: profile.name,
    message: `Activating “${profile.name}”…`,
  })

  try {
    if (options.saveUnsavedAs?.trim()) {
      report(onProgress, {
        phase: 'saving',
        message: 'Saving current profile…',
      })
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

    const storeLive = loadStore()
    const profileLive = storeLive.profiles.find((p) => p.id === profileId)
    if (!profileLive) throw new Error('Profile not found after save-as.')

    let steamVersionSwitchAttempted = false
    let steamVersionSwitchOk = false
    if (
      mismatch &&
      options.confirmVersionSwitch &&
      options.attemptSteamVersionSwitch !== false &&
      store.allowSteamBetaKeyWrite !== false
    ) {
      const betaKey = resolveDesiredBetaKey(profile.gameVersion, profile.steamBetaBranch)
      const versionLabel =
        profile.gameVersion && profile.gameVersion !== 'unknown'
          ? profile.gameVersion.replace(/^v/i, '')
          : betaKey || 'requested'
      report(onProgress, {
        phase: 'installing-version',
        message: `Installing version ${versionLabel}…`,
      })
      const switchResult = await attemptSteamVersionSwitch(discovery.installPath, betaKey)
      steamVersionSwitchAttempted = switchResult.attempted
      steamVersionSwitchOk = switchResult.ok
      versionNotes.push(...switchResult.notes)

      if (switchResult.attempted) {
        report(onProgress, {
          phase: 'waiting-steam',
          message: `Waiting for Steam to finish installing version ${versionLabel}…`,
        })
        const settle = await waitForSteamVersionSettle({
          installPath: discovery.installPath,
          desiredBetaKey: betaKey,
          desiredGameVersion: profile.gameVersion,
          versionLabel,
          onProgress: (message) =>
            report(onProgress, { phase: 'waiting-steam', message }),
        })
        versionNotes.push(...settle.notes)
        if (!settle.ok) {
          throw new Error(
            `Steam did not finish installing version ${versionLabel}. Activate aborted before touching Modules — let Steam finish (or cancel) the update, then Activate again when Steam is idle.`,
          )
        }
        steamVersionSwitchOk = steamVersionSwitchOk && settle.ok
      }
    } else if (mismatch && options.confirmVersionSwitch) {
      report(onProgress, {
        phase: 'installing-version',
        message: `Version ${profile.gameVersion.replace(/^v/i, '')} confirmed (Steam BetaKey write disabled)…`,
      })
      versionNotes.push(
        'Version switch confirmed, but Steam BetaKey write is disabled in settings. Switch Betas manually in Steam.',
      )
      // Still refuse to vault while Steam is busy.
      const busy = getSteamBusyStatus(storeLive.gameInstallPath)
      if (busy.busy) {
        throw new Error(
          `Cannot Activate mods while Steam is busy: ${busy.detail}. Finish the Steam update first.`,
        )
      }
    } else if (!mismatch) {
      versionNotes.push(
        discovery.detectedGameVersion
          ? `Game version matches profile (${discovery.detectedGameVersion}).`
          : 'No game version detected; proceeding with vault + launcher deploy.',
      )
      const busy = getSteamBusyStatus(storeLive.gameInstallPath)
      if (busy.busy) {
        throw new Error(
          `Cannot Activate: ${busy.userMessage || 'Steam is updating Bannerlord'} (${busy.detail}).`,
        )
      }
    }

    report(onProgress, {
      phase: 'activating-mods',
      message: 'Activating mods…',
    })

    if (discovery.modulesPath) {
      const imported = importModulesIntoVault(discovery.modulesPath)
      if (imported.imported.length) {
        vaultNotes.push(
          `Imported ${imported.imported.length} module folder(s) into vault before deploy.`,
        )
      }
    }

    const vault = deployProfileVault(discovery.modulesPath, profileLive)
    vaultNotes.push(...vault.notes)
    warnings.push(...vault.warnings)

    const after = discoverGame(storeLive.gameInstallPath, storeLive.documentsPath)
    const installedIds = new Set(after.mods.map((m) => m.id))
    for (const mod of profileLive.mods.filter((m) => m.enabled)) {
      if (!installedIds.has(mod.id)) {
        warnings.push(
          `Enabled mod "${mod.name}" (${mod.id}) is not present under Modules after vault deploy.`,
        )
      }
    }

    report(onProgress, {
      phase: 'writing-launcher',
      message: 'Writing launcher data…',
    })

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

    storeLive.activeProfileId = profileLive.id
    storeLive.lastActivatedAt = new Date().toISOString()
    storeLive.lastActivationNotes = [...versionNotes, ...vaultNotes, ...warnings]
    const target = storeLive.profiles.find((p) => p.id === profileLive.id)
    if (target) target.dirty = false
    saveStore(storeLive)

    report(onProgress, {
      phase: 'done',
      message: 'Done',
    })

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
  } catch (err) {
    report(onProgress, {
      phase: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    endActivateLock()
  }
}

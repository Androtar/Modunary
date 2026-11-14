import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BlseInfo, LaunchResult, ModProfile } from '../types'
import { findSteamExe, STEAM_APP_ID } from './paths'

const execFileAsync = promisify(execFile)

export function detectBlse(installPath: string | null): BlseInfo {
  const empty: BlseInfo = {
    installed: false,
    launcherPath: null,
    launcherExPath: null,
    standalonePath: null,
  }
  if (!installPath) return empty

  const candidates = [
    path.join(installPath, 'bin', 'Win64_Shipping_Client'),
    path.join(installPath, 'bin', 'Gaming.Desktop.x64_Shipping_Client'),
  ]

  for (const dir of candidates) {
    const launcher = path.join(dir, 'Bannerlord.BLSE.Launcher.exe')
    const launcherEx = path.join(dir, 'Bannerlord.BLSE.LauncherEx.exe')
    const standalone = path.join(dir, 'Bannerlord.BLSE.Standalone.exe')
    if (fs.existsSync(launcher) || fs.existsSync(launcherEx) || fs.existsSync(standalone)) {
      return {
        installed: true,
        launcherPath: fs.existsSync(launcher) ? launcher : null,
        launcherExPath: fs.existsSync(launcherEx) ? launcherEx : null,
        standalonePath: fs.existsSync(standalone) ? standalone : null,
      }
    }
  }
  return empty
}

export function inferRequiresBlse(profile: ModProfile, blseInstalled: boolean): boolean {
  if (profile.settings.requiresBlse) return true
  if (profile.settings.preferredLauncher === 'blse') return true
  // Common BLSE-dependent stack markers
  const ids = new Set(profile.mods.filter((m) => m.enabled).map((m) => m.id))
  if (ids.has('Bannerlord.Harmony') && blseInstalled) return true
  return false
}

export async function launchProfile(
  profile: ModProfile,
  installPath: string | null,
): Promise<LaunchResult> {
  const blse = detectBlse(installPath)
  const useBlse = profile.settings.requiresBlse || profile.settings.preferredLauncher === 'blse'

  if (useBlse) {
    if (!blse.installed) {
      return {
        ok: false,
        mode: 'blse',
        command: '',
        message:
          'This profile requires BLSE, but Bannerlord.BLSE.*.exe was not found under bin/Win64_Shipping_Client.',
      }
    }
    const exe =
      blse.launcherExPath || blse.launcherPath || blse.standalonePath
    if (!exe) {
      return {
        ok: false,
        mode: 'blse',
        command: '',
        message: 'BLSE is partially installed; no launcher executable found.',
      }
    }
    spawn(exe, [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
    }).unref()
    return {
      ok: true,
      mode: 'blse',
      command: exe,
      message: `Launched via BLSE: ${path.basename(exe)}`,
    }
  }

  const steamExe = findSteamExe()
  const uri = `steam://rungameid/${STEAM_APP_ID}`
  try {
    if (steamExe) {
      spawn(steamExe, ['-applaunch', STEAM_APP_ID], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      return {
        ok: true,
        mode: 'steam',
        command: `${steamExe} -applaunch ${STEAM_APP_ID}`,
        message: 'Launched Bannerlord via Steam.',
      }
    }
    await execFileAsync('cmd', ['/c', `start ${uri}`], { windowsHide: true })
    return {
      ok: true,
      mode: 'steam',
      command: uri,
      message: 'Opened Steam run URI for Bannerlord.',
    }
  } catch (err) {
    return {
      ok: false,
      mode: 'steam',
      command: uri,
      message: `Steam launch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import {
  findSteamAppManifest,
  findSteamExe,
  getBackupsPath,
  STEAM_APP_ID,
} from './paths'

const execFileAsync = promisify(execFile)

export function compareLooseVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/^v/i, '').split('.').slice(0, 3).join('.')
  return norm(a) === norm(b)
}

export function resolveDesiredBetaKey(
  gameVersion: string,
  steamBetaBranch: string,
): string {
  if (steamBetaBranch.trim()) return steamBetaBranch.trim()
  if (!gameVersion || gameVersion === 'unknown') return ''
  const v = gameVersion.replace(/^v/i, '')
  return `v${v}`
}

function upsertBetaKey(text: string, section: string, betaKey: string): string {
  const betaRe = new RegExp(`("${section}"\\s*\\{[\\s\\S]*?"BetaKey"\\s+")([^"]*)(")`, 'i')
  if (betaRe.test(text)) {
    return text.replace(betaRe, `$1${betaKey}$3`)
  }
  const sectionRe = new RegExp(`("${section}"\\s*\\{)`, 'i')
  if (sectionRe.test(text)) {
    return text.replace(sectionRe, `$1\n\t\t"BetaKey"\t\t"${betaKey}"`)
  }
  return text
}

export function setBetaKeyInAcf(text: string, betaKey: string): string {
  let next = upsertBetaKey(text, 'UserConfig', betaKey)
  next = upsertBetaKey(next, 'MountedConfig', betaKey)
  return next
}

export interface SteamVersionSwitchResult {
  ok: boolean
  attempted: boolean
  notes: string[]
  backupPath: string | null
}

/**
 * Opt-in Steam version switch: rewrite appmanifest BetaKey and ask Steam to update.
 * Steam may overwrite BetaKey; fully exiting Steam first improves reliability.
 */
export async function attemptSteamVersionSwitch(
  installPath: string | null,
  desiredBetaKey: string,
): Promise<SteamVersionSwitchResult> {
  const notes: string[] = []
  const manifest = findSteamAppManifest(installPath)
  if (!manifest || !fs.existsSync(manifest)) {
    return {
      ok: false,
      attempted: false,
      notes: ['Steam appmanifest_261550.acf not found; cannot write BetaKey.'],
      backupPath: null,
    }
  }

  const backupDir = getBackupsPath()
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${backupDir}\\appmanifest_261550-${stamp}.acf`
  fs.copyFileSync(manifest, backupPath)
  notes.push(`Backed up appmanifest to ${backupPath}`)

  const original = fs.readFileSync(manifest, 'utf8')
  const next = setBetaKeyInAcf(original, desiredBetaKey)
  fs.writeFileSync(manifest, next, 'utf8')
  notes.push(
    desiredBetaKey
      ? `Wrote Steam BetaKey "${desiredBetaKey}" into appmanifest.`
      : 'Cleared Steam BetaKey (public branch) in appmanifest.',
  )

  try {
    const steamExe = findSteamExe()
    // Steam may keep the protocol handler open while downloading — cap wait so Activate can finish.
    const withTimeout = <T>(p: Promise<T>, ms: number) =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error('Steam validate trigger timed out')), ms)
        }),
      ])
    try {
      if (steamExe) {
        try {
          await withTimeout(
            execFileAsync(steamExe, [`steam://validate/${STEAM_APP_ID}`], {
              windowsHide: true,
            }),
            8000,
          )
        } catch {
          await withTimeout(
            execFileAsync('cmd', ['/c', `start "" steam://validate/${STEAM_APP_ID}`], {
              windowsHide: true,
            }),
            5000,
          )
        }
      } else {
        await withTimeout(
          execFileAsync('cmd', ['/c', `start "" steam://validate/${STEAM_APP_ID}`], {
            windowsHide: true,
          }),
          5000,
        )
      }
      notes.push(
        'Requested Steam validate/update for Bannerlord. Steam may keep downloading in the background — watch Steam if the branch does not change immediately.',
      )
    } catch {
      // Fire-and-forget fallback: don't block Activate on Steam's download.
      void execFileAsync('cmd', ['/c', `start "" steam://validate/${STEAM_APP_ID}`], {
        windowsHide: true,
      }).catch(() => undefined)
      notes.push(
        'Triggered Steam validate (non-blocking). If the branch does not change, fully exit Steam and reopen, then confirm Betas in Properties.',
      )
    }
  } catch {
    notes.push(
      'BetaKey written, but could not trigger Steam update automatically. Open Steam → Bannerlord → Properties → Betas.',
    )
  }

  return { ok: true, attempted: true, notes, backupPath }
}

export async function openSteamBetaUi(): Promise<string> {
  try {
    await execFileAsync('cmd', ['/c', `start steam://nav/games/details/${STEAM_APP_ID}`], {
      windowsHide: true,
    })
    return 'Opened Steam game details. Use Properties → Betas if the automatic switch did not stick.'
  } catch {
    return 'Could not open Steam UI.'
  }
}

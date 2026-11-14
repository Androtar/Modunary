import { getSteamBusyStatus } from './steamBusy'
import { compareLooseVersion } from './steamVersion'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function betaMatches(current: string | null, desired: string): boolean {
  const a = (current || '').trim().toLowerCase()
  const b = desired.trim().toLowerCase()
  if (!b) return !a || a === 'public' || a === 'none' || a === 'default'
  return a === b
}

/**
 * After BetaKey write + validate, wait until Steam is no longer updating (and BetaKey sticks).
 * Refuses to return while downloading so vault deploy cannot race Steam.
 */
export async function waitForSteamVersionSettle(input: {
  installPath: string | null
  desiredBetaKey: string
  desiredGameVersion: string
  versionLabel: string
  onProgress?: (message: string) => void
  /** Max wait for Steam; default 45 minutes. */
  timeoutMs?: number
  pollMs?: number
}): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = []
  const timeoutMs = input.timeoutMs ?? 45 * 60 * 1000
  const pollMs = input.pollMs ?? 2000
  const started = Date.now()
  let sawBusy = false
  let idleStreak = 0

  input.onProgress?.(
    `Waiting for Steam to finish installing version ${input.versionLabel}…`,
  )

  // Brief head-start so Steam can create the downloading folder after validate.
  await sleep(2500)

  while (Date.now() - started < timeoutMs) {
    const status = getSteamBusyStatus(input.installPath)
    const keyOk = betaMatches(status.betaKey, input.desiredBetaKey)
    const versionOk =
      !input.desiredGameVersion ||
      input.desiredGameVersion === 'unknown' ||
      input.desiredGameVersion === 'public' ||
      !status.detectedVersion ||
      compareLooseVersion(status.detectedVersion, input.desiredGameVersion)

    if (status.busy) {
      sawBusy = true
      idleStreak = 0
      input.onProgress?.(
        `Installing version ${input.versionLabel}… (${status.detail})`,
      )
    } else if (keyOk && (versionOk || sawBusy)) {
      idleStreak += 1
      if (idleStreak >= 2) {
        notes.push(
          sawBusy
            ? `Steam finished updating toward ${input.versionLabel}.`
            : `Steam reports idle with BetaKey matching ${input.desiredBetaKey || '(public)'}.`,
        )
        if (!versionOk && status.detectedVersion) {
          notes.push(
            `Detected game version is still ${status.detectedVersion}; expected ${input.desiredGameVersion}. Proceeding cautiously.`,
          )
        }
        return { ok: true, notes }
      }
      input.onProgress?.(
        `Waiting for Steam to settle on version ${input.versionLabel}…`,
      )
    } else {
      idleStreak = 0
      input.onProgress?.(
        keyOk
          ? `Waiting for Steam version ${input.versionLabel}…`
          : `Waiting for Steam BetaKey ${input.desiredBetaKey || '(public)'} to stick…`,
      )
    }

    await sleep(pollMs)
  }

  const finalStatus = getSteamBusyStatus(input.installPath)
  notes.push(
    `Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for Steam (last: ${finalStatus.detail}, BetaKey=${finalStatus.betaKey || '(none)'}, version=${finalStatus.detectedVersion || 'unknown'}).`,
  )
  return { ok: false, notes }
}

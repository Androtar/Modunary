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

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function versionRequired(desiredGameVersion: string): boolean {
  return Boolean(
    desiredGameVersion &&
      desiredGameVersion !== 'unknown' &&
      desiredGameVersion !== 'public',
  )
}

/**
 * After BetaKey write + validate, wait until Steam finishes installing/updating
 * and the installed game version matches the profile target.
 *
 * While Steam reports Bannerlord busy (download / update / validate), wait without
 * a short timeout — multi-GB version swaps can take a long time. A separate
 * false-start budget only applies when Steam never becomes busy and never lands
 * on the target version/BetaKey.
 */
export async function waitForSteamVersionSettle(input: {
  installPath: string | null
  desiredBetaKey: string
  desiredGameVersion: string
  versionLabel: string
  onProgress?: (message: string) => void
  /**
   * Max wall time with Steam never busy and never settled (false start).
   * Default 45 minutes. Does not apply while Steam is actively updating.
   */
  falseStartTimeoutMs?: number
  /**
   * Absolute ceiling even while Steam stays busy (safety net).
   * Default 8 hours — real installs should finish far sooner.
   */
  absoluteTimeoutMs?: number
  /** @deprecated Prefer falseStartTimeoutMs; kept for callers/tests. */
  timeoutMs?: number
  pollMs?: number
}): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = []
  const falseStartTimeoutMs =
    input.falseStartTimeoutMs ?? input.timeoutMs ?? 45 * 60 * 1000
  const absoluteTimeoutMs = input.absoluteTimeoutMs ?? 8 * 60 * 60 * 1000
  const pollMs = input.pollMs ?? 2000
  const started = Date.now()
  let lastBusyAt: number | null = null
  let sawBusy = false
  let idleStreak = 0
  let lastProgressAt = 0

  const needVersion = versionRequired(input.desiredGameVersion)

  const emitProgress = (message: string, force = false) => {
    const now = Date.now()
    // Keep UI alive on long waits without spamming every 2s poll.
    if (!force && now - lastProgressAt < 4000) return
    lastProgressAt = now
    input.onProgress?.(message)
  }

  emitProgress(
    `Waiting for Steam to finish installing version ${input.versionLabel}… (large updates can take a long time)`,
    true,
  )

  // Brief head-start so Steam can create the downloading folder after validate.
  await sleep(2500)

  while (true) {
    const elapsed = Date.now() - started
    if (elapsed >= absoluteTimeoutMs) {
      const finalStatus = getSteamBusyStatus(input.installPath)
      notes.push(
        `Timed out after ${formatElapsed(absoluteTimeoutMs)} absolute wait for Steam (last: ${finalStatus.detail}, BetaKey=${finalStatus.betaKey || '(none)'}, version=${finalStatus.detectedVersion || 'unknown'}).`,
      )
      return { ok: false, notes }
    }

    const status = getSteamBusyStatus(input.installPath)
    const keyOk = betaMatches(status.betaKey, input.desiredBetaKey)
    const versionOk =
      !needVersion ||
      (Boolean(status.detectedVersion) &&
        compareLooseVersion(status.detectedVersion!, input.desiredGameVersion))

    if (status.busy) {
      sawBusy = true
      lastBusyAt = Date.now()
      idleStreak = 0
      emitProgress(
        `Installing version ${input.versionLabel}… ${status.detail} · elapsed ${formatElapsed(elapsed)} (waiting until Steam finishes)`,
      )
      await sleep(pollMs)
      continue
    }

    // Steam idle: only succeed when BetaKey matches and (when known) version matches.
    if (keyOk && versionOk) {
      idleStreak += 1
      if (idleStreak >= 2) {
        notes.push(
          sawBusy
            ? `Steam finished updating to ${input.versionLabel}.`
            : `Steam reports idle with BetaKey matching ${input.desiredBetaKey || '(public)'} and version ${status.detectedVersion || input.desiredGameVersion}.`,
        )
        return { ok: true, notes }
      }
      emitProgress(
        `Waiting for Steam to settle on version ${input.versionLabel}… (${formatElapsed(elapsed)})`,
      )
      await sleep(pollMs)
      continue
    }

    idleStreak = 0

    // Idle but not on target yet — false-start / stalled clock only runs while not busy.
    const idleReference = lastBusyAt ?? started
    const idleFor = Date.now() - idleReference
    if (idleFor >= falseStartTimeoutMs) {
      const finalStatus = getSteamBusyStatus(input.installPath)
      const reason = sawBusy
        ? `Steam went idle but did not reach version ${input.versionLabel}`
        : `Steam never started installing version ${input.versionLabel}`
      notes.push(
        `${reason} after ${formatElapsed(idleFor)} idle (last: ${finalStatus.detail}, BetaKey=${finalStatus.betaKey || '(none)'}, version=${finalStatus.detectedVersion || 'unknown'}).`,
      )
      return { ok: false, notes }
    }

    if (!keyOk) {
      emitProgress(
        `Waiting for Steam BetaKey ${input.desiredBetaKey || '(public)'} to stick… (${formatElapsed(elapsed)}; large updates can take a long time)`,
      )
    } else if (needVersion) {
      emitProgress(
        `Waiting for installed version ${input.versionLabel}… currently ${status.detectedVersion || 'unknown'} · ${formatElapsed(elapsed)}`,
      )
    } else {
      emitProgress(
        `Waiting for Steam to finish installing version ${input.versionLabel}… (${formatElapsed(elapsed)})`,
      )
    }

    await sleep(pollMs)
  }
}

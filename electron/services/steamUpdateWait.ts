import { getSteamBusyStatus } from './steamBusy'
import { compareLooseVersion } from './steamVersion'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function betaMatches(current: string | null, desired: string): boolean {
  const a = (current || '').trim().toLowerCase()
  const b = desired.trim().toLowerCase()
  if (!b) return !a || a === 'public' || a === 'none' || a === 'default' || a === 'beta'
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
 * Settle rule (primary): Steam idle + installed version matches target.
 * BetaKey is best-effort — Steam often rewrites it to public/beta after update.
 *
 * While Steam is truly busy (download/staging activity), wait without a short
 * timeout. Stale StateFlags alone must not keep us waiting forever.
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
   * After Steam was busy then goes idle on the *wrong* version, give up.
   * Default 2 minutes once fully idle — validate leftovers should not hang Activate.
   */
  postUpdateMismatchTimeoutMs?: number
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
  const postUpdateMismatchTimeoutMs =
    input.postUpdateMismatchTimeoutMs ?? 2 * 60 * 1000
  const absoluteTimeoutMs = input.absoluteTimeoutMs ?? 8 * 60 * 60 * 1000
  const pollMs = input.pollMs ?? 2000
  const started = Date.now()
  let lastBusyAt: number | null = null
  let sawBusy = false
  let busyStreak = 0
  let idleStreak = 0
  let lastProgressAt = 0
  let stableWrongVersion: string | null = null
  let stableWrongSince = 0

  const needVersion = versionRequired(input.desiredGameVersion)

  const emitProgress = (message: string, force = false) => {
    const now = Date.now()
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
      busyStreak += 1
      // Require two consecutive busy polls so a one-shot stale flag cannot pin us.
      if (busyStreak >= 2) {
        sawBusy = true
        lastBusyAt = Date.now()
      }
      idleStreak = 0
      stableWrongVersion = null
      emitProgress(
        `Installing version ${input.versionLabel}… ${status.detail} · elapsed ${formatElapsed(elapsed)} (waiting until Steam finishes)`,
      )
      await sleep(pollMs)
      continue
    }

    busyStreak = 0

    // Primary settle: idle + version matches (BetaKey optional).
    if (versionOk || (!needVersion && keyOk)) {
      idleStreak += 1
      if (idleStreak >= 2) {
        if (needVersion && !keyOk) {
          notes.push(
            `Steam idle on version ${status.detectedVersion} (BetaKey=${status.betaKey || '(none)'}; wanted ${input.desiredBetaKey || '(public)'} — Steam often rewrites BetaKey after update).`,
          )
        }
        notes.push(
          sawBusy
            ? `Steam finished updating to ${input.versionLabel}.`
            : `Steam reports idle with version ${status.detectedVersion || input.desiredGameVersion}.`,
        )
        return { ok: true, notes }
      }
      emitProgress(
        `Steam idle — confirming version ${input.versionLabel}… (${formatElapsed(elapsed)})`,
      )
      await sleep(pollMs)
      continue
    }

    idleStreak = 0

    // Track stable wrong version while idle so we can fail clearly after Steam finishes.
    const detected = status.detectedVersion || 'unknown'
    if (stableWrongVersion !== detected) {
      stableWrongVersion = detected
      stableWrongSince = Date.now()
    }

    const idleReference = lastBusyAt ?? started
    const idleFor = Date.now() - idleReference
    const wrongFor = Date.now() - stableWrongSince

    // Idle on a stable wrong build — fail fast. Validate often finishes before
    // Activate starts watching, so do not require sawBusy (that used to hang
    // for falseStartTimeoutMs after Steam was already done).
    if (
      detected !== 'unknown' &&
      idleFor >= postUpdateMismatchTimeoutMs &&
      wrongFor >= postUpdateMismatchTimeoutMs
    ) {
      notes.push(
        `Steam is idle but installed version is ${detected} (wanted ${input.versionLabel}); BetaKey=${status.betaKey || '(none)'} (wanted ${input.desiredBetaKey || '(public)'}). Activate aborted before touching Modules — pick a Steam beta that provides ${input.versionLabel}, or change the profile version to match the install.`,
      )
      return { ok: false, notes }
    }

    // False start: never became busy, version still unknown / unsettled.
    if (!sawBusy && idleFor >= falseStartTimeoutMs) {
      notes.push(
        `Steam never started installing version ${input.versionLabel} after ${formatElapsed(idleFor)} idle (last: ${status.detail}, BetaKey=${status.betaKey || '(none)'}, version=${detected}).`,
      )
      return { ok: false, notes }
    }

    if (needVersion) {
      emitProgress(
        `Steam idle — waiting for version ${input.versionLabel} (currently ${detected}; BetaKey=${status.betaKey || '(none)'}) · ${formatElapsed(elapsed)}`,
      )
    } else if (!keyOk) {
      emitProgress(
        `Waiting for Steam BetaKey ${input.desiredBetaKey || '(public)'} to stick… (${formatElapsed(elapsed)})`,
      )
    } else {
      emitProgress(
        `Waiting for Steam to finish installing version ${input.versionLabel}… (${formatElapsed(elapsed)})`,
      )
    }

    await sleep(pollMs)
  }
}

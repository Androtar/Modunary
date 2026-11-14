import type { ActivateLockState, ActivateProgressEvent, ActivateProgressPhase } from '../types'
import { getSteamBusyStatusAsync, type SteamBusyStatus } from './steamBusy'
import { getStoreSnapshot } from './profiles'

type Listener = (state: ActivateLockState) => void

type ActivateOnly = {
  active: boolean
  profileId: string | null
  profileName: string | null
  phase: ActivateProgressPhase | null
  message: string | null
  startedAt: string | null
}

const ACTIVATE_IDLE: ActivateOnly = {
  active: false,
  profileId: null,
  profileName: null,
  phase: null,
  message: null,
  startedAt: null,
}

let activateOnly: ActivateOnly = { ...ACTIVATE_IDLE }
let steamStatus: SteamBusyStatus = {
  busy: false,
  detail: 'Steam idle',
  betaKey: null,
  detectedVersion: null,
  userMessage: null,
  reasons: [],
}
let monitorTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<Listener>()

function compose(): ActivateLockState {
  const activateInProgress = activateOnly.active
  const steamBusy = steamStatus.busy
  const blocked = activateInProgress || steamBusy

  let message: string | null = null
  let source: ActivateLockState['source'] = 'none'
  if (activateInProgress && steamBusy) {
    source = 'both'
    message =
      activateOnly.message ||
      steamStatus.userMessage ||
      'Modunary activate and Steam Bannerlord update in progress'
  } else if (activateInProgress) {
    source = 'activate'
    message = activateOnly.message || 'Modunary activate in progress'
  } else if (steamBusy) {
    source = 'steam'
    message =
      steamStatus.userMessage ||
      'Steam is installing/validating/updating Bannerlord'
  }

  const steamDetail = steamStatus.detail || null
  const tooltip = blocked
    ? source === 'activate'
      ? `Modunary activate in progress — ${activateOnly.message || 'wait until it finishes'}`
      : source === 'steam'
        ? `Steam busy: ${steamDetail || 'installing/validating/updating Bannerlord'}`
        : `Activate in progress and Steam busy: ${steamDetail || 'updating'}`
    : null

  return {
    active: blocked,
    blocked,
    source,
    profileId: activateOnly.profileId,
    profileName: activateOnly.profileName,
    phase: activateOnly.phase,
    message: blocked
      ? message
      : steamDetail
        ? `Steam monitor: ${steamDetail}`
        : null,
    startedAt: activateOnly.startedAt,
    steamUpdatePending:
      steamBusy ||
      activateOnly.phase === 'waiting-steam' ||
      activateOnly.phase === 'installing-version',
    activateInProgress,
    steamBusy,
    steamDetail,
    tooltip,
  }
}

export function getActivateLock(): ActivateLockState {
  return compose()
}

export function subscribeActivateLock(listener: Listener): () => void {
  listeners.add(listener)
  listener(compose())
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  const snapshot = compose()
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch {
      // ignore
    }
  }
}

export function assertOperationAllowed(
  kind: 'activate' | 'launch',
  opts?: { allowSteamBusy?: boolean },
): void {
  if (activateOnly.active) {
    const action = kind === 'activate' ? 'Activate' : 'Launch'
    throw new Error(
      `Cannot ${action}: Modunary activate in progress${activateOnly.message ? ` — ${activateOnly.message}` : ''}. Wait until it finishes.`,
    )
  }
  if (steamStatus.busy && !(kind === 'activate' && opts?.allowSteamBusy)) {
    const action = kind === 'activate' ? 'Activate' : 'Launch'
    throw new Error(
      `Cannot ${action}: ${steamStatus.userMessage || 'Steam is installing/validating/updating Bannerlord'}${steamStatus.detail ? ` (${steamStatus.detail})` : ''}.`,
    )
  }
}

export function beginActivateLock(input: {
  profileId: string
  profileName: string
  message: string
}): void {
  // Only one Modunary activate at a time; Steam may already be busy when we drive a version switch.
  if (activateOnly.active) {
    throw new Error(
      `Cannot Activate: Modunary activate already in progress${activateOnly.message ? ` — ${activateOnly.message}` : ''}.`,
    )
  }
  activateOnly = {
    active: true,
    profileId: input.profileId,
    profileName: input.profileName,
    phase: 'saving',
    message: input.message,
    startedAt: new Date().toISOString(),
  }
  emit()
}

export function updateActivateLock(
  patch: Partial<Pick<ActivateOnly, 'phase' | 'message'>>,
): void {
  if (!activateOnly.active) return
  activateOnly = { ...activateOnly, ...patch }
  emit()
}

export function reportActivateLockProgress(event: ActivateProgressEvent): void {
  if (!activateOnly.active) return
  updateActivateLock({
    phase: event.phase === 'error' ? activateOnly.phase : event.phase,
    message: event.message,
  })
}

export function endActivateLock(): void {
  if (!activateOnly.active) return
  activateOnly = { ...ACTIVATE_IDLE }
  emit()
}

async function pollSteamOnce(): Promise<void> {
  try {
    const store = getStoreSnapshot()
    const next = await getSteamBusyStatusAsync(store.gameInstallPath)
    const changed =
      next.busy !== steamStatus.busy ||
      next.detail !== steamStatus.detail ||
      next.userMessage !== steamStatus.userMessage
    steamStatus = next
    if (changed) emit()
  } catch {
    // keep last known
  }
}

/** Start background Steam busy scanning for Bannerlord (261550). */
export function startSteamBusyMonitor(intervalMs = 2500): void {
  if (monitorTimer) return
  void pollSteamOnce()
  monitorTimer = setInterval(() => {
    void pollSteamOnce()
  }, intervalMs)
}

export function stopSteamBusyMonitor(): void {
  if (!monitorTimer) return
  clearInterval(monitorTimer)
  monitorTimer = null
}

/** Force-clear Modunary activate lock (stuck session) and re-poll Steam. */
export async function forceClearOperationLock(): Promise<ActivateLockState> {
  if (activateOnly.active) {
    activateOnly = { ...ACTIVATE_IDLE }
  }
  await pollSteamOnce()
  emit()
  return compose()
}

/** Re-read Steam busy immediately (does not clear a real activate). */
export async function refreshSteamBusyNow(): Promise<ActivateLockState> {
  await pollSteamOnce()
  emit()
  return compose()
}

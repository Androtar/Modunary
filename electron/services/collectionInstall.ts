import { BrowserWindow, shell } from 'electron'
import type {
  CollectionInstallProgress,
  CollectionInstallItem,
  NexusCollectionInfoDto,
} from '../types'
import { downloadUrlToVault, importZipToVault } from './installMod'
import { addModulesToProfile } from './profiles'
import { getNexusDownloadLink, listNexusFiles, validateNexusKey } from './stores/nexus'
import {
  resolveNexusCollection,
  type NexusCollectionMod,
} from './stores/nexusCollection'
import { getDownloadsPath, waitForNewDownload } from './downloadWatch'
import {
  createNexusBrowser,
  ensureNexusSessionConfigured,
  getActiveNexusDownloadPath,
  injectNexusGuideBanner,
  modFilesUrl,
  nexusLoginUrl,
  nexusSessionLooksLoggedIn,
  takeCompletedNexusDownload,
  tryAssistSlowDownload,
} from './nexusBrowser'

type ProgressListener = (p: CollectionInstallProgress) => void

type Session = {
  profileId: string
  collection: NexusCollectionInfoDto
  items: CollectionInstallItem[]
  index: number
  running: boolean
  cancelled: boolean
  skipCurrent: boolean
  retryCurrent: boolean
  browser: BrowserWindow | null
  includeOptional: boolean
  parent: BrowserWindow | null
}

let session: Session | null = null
const listeners = new Set<ProgressListener>()

function broadcast(progress: CollectionInstallProgress): void {
  for (const l of listeners) {
    try {
      l(progress)
    } catch {
      // ignore
    }
  }
}

function emit(partial?: Partial<CollectionInstallProgress>): void {
  if (!session) {
    if (partial) {
      broadcast({
        active: Boolean(partial.active),
        stage: partial.stage || 'idle',
        collectionName: partial.collectionName || null,
        collectionUrl: partial.collectionUrl || null,
        profileId: partial.profileId || null,
        total: partial.total || 0,
        completed: partial.completed || 0,
        index: partial.index || 0,
        currentModId: partial.currentModId || null,
        currentModName: partial.currentModName || null,
        message: partial.message || '',
        items: partial.items || [],
        downloadsPath: getDownloadsPath(),
        error: partial.error || null,
      })
    }
    return
  }
  const total = session.items.length
  const done = session.items.filter((i) => i.status === 'done' || i.status === 'skipped').length
  const current = session.items[session.index]
  const progress: CollectionInstallProgress = {
    active: session.running,
    stage: partial?.stage || (session.running ? 'installing' : 'idle'),
    collectionName: session.collection.name,
    collectionUrl: session.collection.url,
    profileId: session.profileId,
    total,
    completed: done,
    index: session.index,
    currentModId: current ? String(current.modId) : null,
    currentModName: current?.name || null,
    message: partial?.message || current?.message || '',
    downloadsPath: getDownloadsPath(),
    error: partial?.error || null,
    ...partial,
    items: partial?.items || session.items.map((i) => ({ ...i })),
  }
  broadcast(progress)
}

export function subscribeCollectionInstall(listener: ProgressListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCollectionInstallProgress(): CollectionInstallProgress | null {
  if (!session) return null
  const total = session.items.length
  const done = session.items.filter((i) => i.status === 'done' || i.status === 'skipped').length
  const current = session.items[session.index]
  return {
    active: session.running,
    stage: session.running ? 'installing' : 'idle',
    collectionName: session.collection.name,
    collectionUrl: session.collection.url,
    profileId: session.profileId,
    total,
    completed: done,
    index: session.index,
    currentModId: current ? String(current.modId) : null,
    currentModName: current?.name || null,
    message: current?.message || '',
    items: session.items.map((i) => ({ ...i })),
    downloadsPath: getDownloadsPath(),
    error: null,
  }
}

export function clearCollectionInstallProgress(): void {
  if (session?.running) return
  closeBrowser()
  session = null
  broadcast({
    active: false,
    stage: 'idle',
    collectionName: null,
    collectionUrl: null,
    profileId: null,
    total: 0,
    completed: 0,
    index: 0,
    currentModId: null,
    currentModName: null,
    message: '',
    items: [],
    downloadsPath: getDownloadsPath(),
    error: null,
  })
}

function closeBrowser(): void {
  if (session?.browser && !session.browser.isDestroyed()) {
    try {
      session.browser.close()
    } catch {
      // ignore
    }
  }
  if (session) session.browser = null
}

function ensureBrowser(parent: BrowserWindow | null): BrowserWindow {
  if (!session) throw new Error('No session')
  if (session.browser && !session.browser.isDestroyed()) return session.browser
  session.browser = createNexusBrowser(parent || session.parent)
  session.browser.on('closed', () => {
    if (session) session.browser = null
  })
  return session.browser
}

async function loadUrl(win: BrowserWindow, url: string): Promise<void> {
  if (win.isDestroyed()) return
  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 800))
}

async function ensureLoggedIn(parent: BrowserWindow | null): Promise<boolean> {
  if (!session) return false
  ensureNexusSessionConfigured()
  if (await nexusSessionLooksLoggedIn()) {
    emit({
      stage: 'installing',
      message: 'Nexus session found (persisted login) — continuing Collection install…',
    })
    return true
  }

  const win = ensureBrowser(parent)
  win.show()
  win.focus()
  await loadUrl(win, nexusLoginUrl())
  await injectNexusGuideBanner(
    win,
    'Modunary: Sign in to Nexus here. Your login persists for later mods. After login, Collection install continues automatically.',
  )
  emit({
    stage: 'waiting-download',
    message:
      'ACTION NEEDED: Sign in to Nexus in the browser window (session persists). Waiting for login…',
  })

  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    if (session.cancelled) return false
    if (session.skipCurrent) {
      session.skipCurrent = false
      // skipping login isn't meaningful — treat as cancel
      return false
    }
    if (await nexusSessionLooksLoggedIn()) {
      emit({ stage: 'installing', message: 'Logged in — starting mods…' })
      await injectNexusGuideBanner(win, 'Logged in. Installing Collection mods…')
      return true
    }
    emit({
      stage: 'waiting-download',
      message:
        'ACTION NEEDED: Sign in to Nexus in the browser window. Waiting for login cookie…',
    })
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

async function tryPremiumInstall(mod: NexusCollectionMod): Promise<{
  ok: boolean
  needsManual?: boolean
  modules?: Array<{ folderName: string; id: string; name: string; version: string }>
  error?: string
}> {
  const premium = await validateNexusKey()
  if (!premium.ok || !premium.isPremium) {
    return { ok: false, needsManual: true, error: 'Premium CDN not available (optional).' }
  }

  let fileId = mod.fileId
  if (!fileId) {
    const files = await listNexusFiles(String(mod.modId))
    if (!files.ok || !files.files.length) {
      return { ok: false, needsManual: true, error: files.error || 'No files listed.' }
    }
    fileId = files.files[0].id
  }

  const link = await getNexusDownloadLink(String(mod.modId), String(fileId))
  if (!link.ok || !link.url) {
    return {
      ok: false,
      needsManual: true,
      error: link.error || 'No CDN link.',
    }
  }
  const imported = await downloadUrlToVault(link.url, `nexus-${mod.modId}-${fileId}`)
  if (!imported.ok) return { ok: false, needsManual: true, error: imported.error }
  return { ok: true, modules: imported.modules }
}

async function manualSlowDownloadInstall(
  mod: NexusCollectionMod,
  parent: BrowserWindow | null,
): Promise<{
  ok: boolean
  skipped?: boolean
  modules?: Array<{ folderName: string; id: string; name: string; version: string }>
  error?: string
}> {
  if (!session) return { ok: false, error: 'No session.' }
  const item = session.items[session.index]
  const domain = session.collection.domain || 'mountandblade2bannerlord'
  const url = modFilesUrl(domain, mod.modId, mod.fileId)

  item.status = 'waiting-user'
  item.message = `ACTION NEEDED: Click Slow Download for “${mod.name}” (complete timer/CAPTCHA yourself). Watching Downloads…`
  emit({ stage: 'waiting-download', message: item.message })

  const win = ensureBrowser(parent)
  win.show()
  win.focus()
  const sinceMs = Date.now()
  session.skipCurrent = false
  await loadUrl(win, url)
  await injectNexusGuideBanner(
    win,
    `Modunary: Click “Slow Download” for ${mod.name}. Complete any timer/CAPTCHA yourself — Modunary will import the ZIP from Downloads.`,
  )

  // Assist: try opening download modal / clicking Slow Download when safe.
  let lastAssist = ''
  const assistDeadline = Date.now() + 45_000
  while (Date.now() < assistDeadline) {
    if (session.cancelled) return { ok: false, error: 'Cancelled.' }
    if (session.skipCurrent) return { ok: false, skipped: true }
    const assist = await tryAssistSlowDownload(win)
    lastAssist = assist.detail
    await injectNexusGuideBanner(win, `Modunary: ${assist.detail}`)
    if (assist.status === 'captcha' || assist.status === 'login' || assist.status === 'waiting-timer') {
      item.message = `ACTION NEEDED: ${assist.detail}`
      emit({ stage: 'waiting-download', message: item.message })
      if (assist.status === 'captcha' || assist.status === 'waiting-timer') break
      if (assist.status === 'login') {
        // Wait a bit for login then retry
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
    }
    if (assist.status === 'clicked-slow') {
      item.message = 'Slow Download clicked — waiting for ZIP in Downloads…'
      emit({ stage: 'waiting-download', message: item.message })
      break
    }
    if (assist.status === 'clicked-download') {
      item.message =
        'ACTION NEEDED: Download popup opened — click Slow Download (complete timer/CAPTCHA if shown).'
      emit({ stage: 'waiting-download', message: item.message })
      await new Promise((r) => setTimeout(r, 1200))
      continue
    }
    item.message = `ACTION NEEDED: ${assist.detail}`
    emit({ stage: 'waiting-download', message: item.message })
    await new Promise((r) => setTimeout(r, 1500))
  }

  // Watch Downloads folder + Electron will-download; keep assisting Slow Download.
  let stopAssist = false
  let electronHit: { path: string; name: string } | null = null

  void (async () => {
    const deadline = Date.now() + 20 * 60 * 1000
    while (!stopAssist && Date.now() < deadline) {
      if (session?.cancelled || session?.skipCurrent) return
      const hit = takeCompletedNexusDownload(sinceMs)
      if (hit) {
        electronHit = hit
        stopAssist = true
        return
      }
      if (session?.browser && !session.browser.isDestroyed()) {
        const assist = await tryAssistSlowDownload(session.browser)
        lastAssist = assist.detail
        if (
          assist.status === 'captcha' ||
          assist.status === 'waiting-timer' ||
          assist.status === 'not-found' ||
          assist.status === 'clicked-download'
        ) {
          const msg = `ACTION NEEDED: ${assist.detail}`
          item.message = msg
          emit({ stage: 'waiting-download', message: msg })
          void injectNexusGuideBanner(session.browser, msg)
        } else if (assist.status === 'clicked-slow') {
          item.message = 'Slow Download clicked — waiting for ZIP in Downloads…'
          emit({ stage: 'waiting-download', message: item.message })
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
  })()

  const folderResult = await waitForNewDownload({
    sinceMs,
    timeoutMs: 20 * 60 * 1000,
    nameHints: [String(mod.modId), mod.name.slice(0, 24)],
    signal: {
      get cancelled() {
        // Stop folder watch when will-download completed or user cancelled.
        return Boolean(session?.cancelled) || Boolean(electronHit)
      },
      get skipped() {
        return Boolean(session?.skipCurrent)
      },
    },
    onProgress: (message) => {
      if (!session || stopAssist) return
      const cur = session.items[session.index]
      const active = getActiveNexusDownloadPath()
      const text = active
        ? `Downloading to ${active}…`
        : message.includes('Waiting for a new ZIP')
          ? `ACTION NEEDED: Click Slow Download for “${mod.name}”. ${lastAssist || ''} Watching ${getDownloadsPath()}…`
          : message
      if (cur) cur.message = text
      emit({ stage: 'waiting-download', message: text })
      void injectNexusGuideBanner(win, text.startsWith('ACTION') ? text : `Modunary: ${text}`)
    },
  })
  stopAssist = true

  const archive =
    electronHit ||
    (folderResult.ok && folderResult.file
      ? { path: folderResult.file.path, name: folderResult.file.name }
      : takeCompletedNexusDownload(sinceMs))

  if (archive) {
    item.status = 'importing'
    item.message = `Importing ${archive.name}…`
    emit({ stage: 'installing', message: item.message })
    const imported = await importZipToVault(archive.path)
    if (!imported.ok) return { ok: false, error: imported.error }
    return { ok: true, modules: imported.modules }
  }

  if (folderResult.skipped || session?.skipCurrent) return { ok: false, skipped: true }
  return {
    ok: false,
    error:
      folderResult.error ||
      `Timed out waiting for Slow Download ZIP. Last guide: ${lastAssist || 'none'}`,
  }
}

async function installOne(
  mod: NexusCollectionMod,
  parent: BrowserWindow | null,
): Promise<void> {
  if (!session) return
  const item = session.items[session.index]
  item.status = 'downloading'
  item.message = 'Trying Premium CDN…'
  item.error = null
  emit({ stage: 'installing', message: item.message })

  const premium = await tryPremiumInstall(mod)
  if (premium.ok && premium.modules) {
    addModulesToProfile(
      session.profileId,
      premium.modules.map((m) => ({
        ...m,
        source: 'nexus' as const,
        sourceId: String(mod.modId),
      })),
      true,
    )
    item.status = 'done'
    item.message = 'Installed via Premium CDN'
    item.method = 'premium'
    return
  }

  item.message = `${premium.error || 'Premium unavailable'} — opening Slow Download…`
  emit({ stage: 'waiting-download', message: item.message })

  const manual = await manualSlowDownloadInstall(mod, parent)
  if (manual.skipped) {
    item.status = 'skipped'
    item.message = 'Skipped'
    return
  }
  if (!manual.ok || !manual.modules) {
    item.status = 'error'
    item.error = manual.error || 'Manual install failed'
    item.message = item.error
    return
  }
  addModulesToProfile(
    session.profileId,
    manual.modules.map((m) => ({
      ...m,
      source: 'nexus' as const,
      sourceId: String(mod.modId),
    })),
    true,
  )
  item.status = 'done'
  item.message = 'Installed via Slow Download + folder watch'
  item.method = 'slow-download'
}

async function runLoop(parent: BrowserWindow | null): Promise<void> {
  if (!session) return
  session.running = true
  session.parent = parent
  ensureNexusSessionConfigured()
  emit({ stage: 'installing', message: 'Starting Collection install…' })

  const loggedIn = await ensureLoggedIn(parent)
  if (!loggedIn) {
    session.running = false
    emit({
      stage: 'cancelled',
      message: 'Collection install stopped — Nexus login not completed.',
      error: 'Login required',
    })
    return
  }

  while (session.index < session.items.length) {
    if (session.cancelled) break
    const item = session.items[session.index]
    if (item.status === 'done' || item.status === 'skipped') {
      session.index += 1
      continue
    }

    const mod = session.collection.mods.find((m) => m.modId === item.modId)
    if (!mod) {
      item.status = 'error'
      item.error = 'Mod missing from collection payload'
      session.index += 1
      continue
    }

    session.skipCurrent = false
    session.retryCurrent = false
    await installOne(mod, parent)

    if (session.cancelled) break

    if (item.status === 'error') {
      item.message = `${item.error || 'Failed'} — use Retry or Skip.`
      emit({ stage: 'paused', message: item.message, error: item.error })
      while (session.running && !session.cancelled && !session.skipCurrent && !session.retryCurrent) {
        await new Promise((r) => setTimeout(r, 400))
      }
      if (session.cancelled) break
      if (session.skipCurrent) {
        item.status = 'skipped'
        item.message = 'Skipped'
        session.skipCurrent = false
        session.index += 1
        continue
      }
      if (session.retryCurrent) {
        session.retryCurrent = false
        item.status = 'pending'
        item.error = null
        continue
      }
    }

    session.index += 1
  }

  closeBrowser()
  session.running = false
  const failed = session.items.filter((i) => i.status === 'error').length
  const skipped = session.items.filter((i) => i.status === 'skipped').length
  const done = session.items.filter((i) => i.status === 'done').length
  emit({
    stage: session.cancelled ? 'cancelled' : 'done',
    active: false,
    message: session.cancelled
      ? 'Collection install cancelled.'
      : `Collection install finished — ${done} installed, ${skipped} skipped, ${failed} failed.`,
  })
}

export async function startCollectionInstall(input: {
  profileId: string
  collectionUrl: string
  includeOptional?: boolean
  parentWindow?: BrowserWindow | null
}): Promise<{ ok: boolean; error?: string; collection?: NexusCollectionInfoDto }> {
  if (session?.running) {
    return { ok: false, error: 'A Collection install is already running.' }
  }

  ensureNexusSessionConfigured()

  emit({
    stage: 'resolving',
    message: 'Resolving Collection…',
    active: true,
    total: 0,
    completed: 0,
    index: 0,
    items: [],
    collectionName: null,
    collectionUrl: input.collectionUrl,
    profileId: input.profileId,
    currentModId: null,
    currentModName: null,
    downloadsPath: getDownloadsPath(),
    error: null,
  })

  const resolved = await resolveNexusCollection(input.collectionUrl)
  if (!resolved.ok || !resolved.collection) {
    return { ok: false, error: resolved.error || 'Could not resolve collection.' }
  }

  const mods = resolved.collection.mods.filter((m) => input.includeOptional || !m.optional)
  if (!mods.length) {
    return { ok: false, error: 'Collection has no installable mods (or only optional ones).' }
  }

  const items: CollectionInstallItem[] = mods.map((m) => ({
    modId: m.modId,
    fileId: m.fileId,
    name: m.name,
    version: m.version,
    optional: m.optional,
    status: 'pending',
    message: '',
    error: null,
    method: null,
  }))

  session = {
    profileId: input.profileId,
    collection: { ...resolved.collection, mods },
    items,
    index: 0,
    running: false,
    cancelled: false,
    skipCurrent: false,
    retryCurrent: false,
    browser: null,
    includeOptional: Boolean(input.includeOptional),
    parent: input.parentWindow || null,
  }

  void runLoop(input.parentWindow || null)
  return { ok: true, collection: resolved.collection }
}

export function skipCollectionMod(): void {
  if (!session?.running) return
  session.skipCurrent = true
  emit({ message: 'Skip requested…' })
}

export function retryCollectionMod(): void {
  if (!session) return
  session.retryCurrent = true
  const item = session.items[session.index]
  if (item) {
    item.status = 'pending'
    item.error = null
    item.message = 'Retrying…'
  }
  emit({ stage: 'installing', message: 'Retrying current mod…' })
}

export function cancelCollectionInstall(): void {
  if (!session) return
  session.cancelled = true
  session.skipCurrent = true
  closeBrowser()
  emit({ stage: 'cancelled', message: 'Cancelling…', active: false })
}

export async function openDownloadsFolder(): Promise<void> {
  await shell.openPath(getDownloadsPath())
}

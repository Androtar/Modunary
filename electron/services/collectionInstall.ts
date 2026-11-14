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

function closeBrowser(): void {
  if (session?.browser && !session.browser.isDestroyed()) {
    session.browser.close()
  }
  if (session) session.browser = null
}

function openModBrowser(url: string, parent: BrowserWindow | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    parent: parent || undefined,
    title: 'Nexus Mods — Slow Download (complete timer/CAPTCHA yourself)',
    webPreferences: {
      partition: 'persist:modunary-nexus',
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  void win.loadURL(url)
  return win
}

async function tryPremiumInstall(mod: NexusCollectionMod): Promise<{
  ok: boolean
  needsManual?: boolean
  modules?: Array<{ folderName: string; id: string; name: string; version: string }>
  error?: string
}> {
  const premium = await validateNexusKey()
  if (!premium.ok || !premium.isPremium) {
    return { ok: false, needsManual: true, error: premium.error || 'Premium CDN not available.' }
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
      needsManual: Boolean(link.needsPremium) || true,
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
  item.status = 'waiting-user'
  item.message =
    'Opened Nexus Files tab — click Slow Download, wait out the timer/CAPTCHA (Modunary will not bypass it), then wait for the ZIP.'
  emit({ stage: 'waiting-download', message: item.message })

  closeBrowser()
  session.browser = openModBrowser(mod.url, parent)
  const sinceMs = Date.now()
  session.skipCurrent = false

  const watched = await waitForNewDownload({
    sinceMs,
    nameHints: [String(mod.modId), mod.name.slice(0, 24)],
    signal: {
      get cancelled() {
        return Boolean(session?.cancelled)
      },
      get skipped() {
        return Boolean(session?.skipCurrent)
      },
    },
    onProgress: (message) => {
      if (!session) return
      const cur = session.items[session.index]
      if (cur) cur.message = message
      emit({ stage: 'waiting-download', message })
    },
  })

  closeBrowser()

  if (watched.skipped) return { ok: false, skipped: true }
  if (!watched.ok || !watched.file) {
    return { ok: false, error: watched.error || 'Download not detected.' }
  }

  item.status = 'importing'
  item.message = `Importing ${watched.file.name}…`
  emit({ stage: 'installing', message: item.message })

  const imported = await importZipToVault(watched.file.path)
  if (!imported.ok) return { ok: false, error: imported.error }
  return { ok: true, modules: imported.modules }
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

  item.message = premium.error || 'Premium unavailable — switching to Slow Download…'
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
  emit({ stage: 'installing', message: 'Starting Collection install…' })

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
      // Pause on error until Retry / Skip
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
  emit({ stage: 'cancelled', message: 'Cancelling…' })
}

export async function openDownloadsFolder(): Promise<void> {
  await shell.openPath(getDownloadsPath())
}

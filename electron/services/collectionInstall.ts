import { BrowserWindow, shell } from 'electron'
import type {
  CollectionInstallProgress,
  CollectionInstallItem,
  NexusCollectionInfoDto,
} from '../types'
import { downloadUrlToVault, importZipToVault } from './installMod'
import {
  addModulesToProfile,
  addVaultModulesToProfile,
  getStoreSnapshot,
  updateProfile,
} from './profiles'
import { getNexusDownloadLink, listNexusFiles, validateNexusKey } from './stores/nexus'
import {
  resolveNexusCollection,
  type NexusCollectionMod,
} from './stores/nexusCollection'
import { getDownloadsPath, listDownloadArchives, waitForNewDownload } from './downloadWatch'
import {
  createNexusBrowser,
  ensureNexusSessionConfigured,
  getActiveNexusDownloadPath,
  getActiveNexusDownloadStats,
  injectNexusGuideBanner,
  manualDownloadPopupUrl,
  modFilesUrl,
  nexusLoginUrl,
  nexusSessionLooksLoggedIn,
  takeCompletedNexusDownload,
  takeLastBlockedProtocol,
  tryAssistSlowDownload,
} from './nexusBrowser'

type ProgressListener = (p: CollectionInstallProgress) => void

function isBlseCollectionMod(mod: { name: string; modId: number }): boolean {
  const n = (mod.name || '').toLowerCase()
  return (
    /\bblse\b/.test(n) ||
    /bannerlord\s*software\s*extender/.test(n) ||
    /\bsoftware\s*extender\b/.test(n)
  )
}

/** Strict Downloads match for Retry — require modId or a strong name token; never bare "Bannerlord". */
function findStrictMatchingDownload(mod: NexusCollectionMod): {
  path: string
  name: string
} | null {
  const modId = String(mod.modId)
  const name = (mod.name || '').toLowerCase()
  const tokens = name
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 5 && !['bannerlord', 'mount', 'blade', 'module', 'mod'].includes(t))
  const wantBlse = isBlseCollectionMod(mod)

  const scored = listDownloadArchives()
    .filter((f) => Date.now() - f.mtimeMs < 12 * 60 * 60 * 1000)
    .map((f) => {
      const n = f.name.toLowerCase()
      let score = 0
      if (n.includes(modId)) score += 5
      for (const t of tokens.slice(0, 4)) {
        if (n.includes(t)) score += 2
      }
      const looksBlse = /\bblse\b|software\s*extender/i.test(n)
      if (wantBlse && looksBlse) score += 4
      if (!wantBlse && looksBlse) score -= 10 // never reuse BLSE for a normal mod
      return { f, score }
    })
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score || b.f.mtimeMs - a.f.mtimeMs)

  const hit = scored[0]?.f
  return hit ? { path: hit.path, name: hit.name } : null
}

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

function formatProgressBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function setCurrentItemProgress(
  update: {
    progressStep?: CollectionInstallItem['progressStep']
    progressPercent?: number | null
    progressDetail?: string | null
    status?: CollectionInstallItem['status']
    message?: string
    error?: string | null
  },
  stage?: CollectionInstallProgress['stage'],
): void {
  if (!session) return
  const item = session.items[session.index]
  if (!item) return
  if (update.progressStep !== undefined) item.progressStep = update.progressStep
  if (update.progressPercent !== undefined) item.progressPercent = update.progressPercent
  if (update.progressDetail !== undefined) item.progressDetail = update.progressDetail
  if (update.status !== undefined) item.status = update.status
  if (update.message !== undefined) item.message = update.message
  if (update.error !== undefined) item.error = update.error
  emit({
    stage: stage || (item.status === 'importing' ? 'installing' : 'waiting-download'),
    message: item.message,
  })
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

function wantsBrowserVisible(): boolean {
  try {
    return getStoreSnapshot().showNexusBrowserDuringCollection === true
  } catch {
    return false
  }
}

/** Apply Show-browser preference. Closing the X hides instead of destroying during Collection. */
export function applyNexusBrowserVisibility(forceShow = false): void {
  const win = session?.browser
  if (!win || win.isDestroyed()) return
  if (forceShow || wantsBrowserVisible()) {
    if (!win.isVisible()) win.show()
  } else if (win.isVisible()) {
    win.hide()
  }
}

function closeBrowser(): void {
  if (session?.browser && !session.browser.isDestroyed()) {
    try {
      session.browser.destroy()
    } catch {
      // ignore
    }
  }
  if (session) session.browser = null
}

function ensureBrowser(parent: BrowserWindow | null): BrowserWindow {
  if (!session) throw new Error('No session')
  if (session.browser && !session.browser.isDestroyed()) {
    applyNexusBrowserVisibility()
    return session.browser
  }
  session.browser = createNexusBrowser(parent || session.parent)
  // Closing the window must not abort Collection — hide instead of destroy.
  session.browser.on('close', (e) => {
    if (!session?.running) return
    e.preventDefault()
    try {
      session.browser?.hide()
    } catch {
      // ignore
    }
  })
  session.browser.on('closed', () => {
    if (session) session.browser = null
  })
  applyNexusBrowserVisibility()
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
  // Login always needs a visible window so Stephen can sign in.
  applyNexusBrowserVisibility(true)
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
  kind?: 'module' | 'blse'
}> {
  if (!session) return { ok: false, error: 'No session.' }
  const item = session.items[session.index]
  const domain = session.collection.domain || 'mountandblade2bannerlord'
  // Prefer Manual Download popup (nmm=0). Never Vortex / nxm / nmm=1.
  const url =
    mod.fileId && mod.fileId > 0
      ? manualDownloadPopupUrl(mod.fileId)
      : modFilesUrl(domain, mod.modId, mod.fileId)

  item.status = 'waiting-user'
  item.message = `Auto-clicking Manual / Slow Download for “${mod.name}” (never Vortex)…`
  emit({ stage: 'waiting-download', message: item.message })

  // Retry fast-path: only re-import an archive that clearly matches THIS mod (never a random BLSE .7z).
  {
    const recent = findStrictMatchingDownload(mod)
    if (recent) {
      item.status = 'importing'
      item.message = `Re-importing existing ${recent.name} with 7za…`
      emit({ stage: 'installing', message: item.message })
      setCurrentItemProgress({
        status: 'importing',
        progressStep: 'extract',
        progressPercent: null,
        progressDetail: 'Extracting…',
        message: `Re-importing existing ${recent.name} with 7za…`,
      }, 'installing')
      const imported = await importZipToVault(recent.path, {
        onProgress: (p) => {
          setCurrentItemProgress({
            status: 'importing',
            progressStep: p.step,
            progressPercent: p.percent,
            progressDetail: p.detail,
            message: `${p.detail} (${recent.name})`,
          }, 'installing')
        },
      })
      if (imported.ok) {
        // Reject BLSE overlay when this collection row is a normal module.
        if (imported.kind === 'blse' && !isBlseCollectionMod(mod)) {
          item.message =
            `Existing archive was BLSE bin overlay, not “${mod.name}” — downloading the correct file…`
          emit({ stage: 'waiting-download', message: item.message })
        } else if (imported.kind !== 'blse' && (!imported.modules || imported.modules.length === 0)) {
          item.message = `Existing archive had no modules — downloading “${mod.name}”…`
          emit({ stage: 'waiting-download', message: item.message })
        } else {
          item.message = `Imported ${recent.name} (${imported.extractor || '7za'})`
          return { ok: true, modules: imported.modules, kind: imported.kind }
        }
      } else {
        item.message = `Existing archive failed (${imported.error || 'unknown'}) — trying Slow Download…`
        emit({ stage: 'waiting-download', message: item.message })
      }
    }
  }

  const win = ensureBrowser(parent)
  applyNexusBrowserVisibility()
  if (wantsBrowserVisible()) win.focus()
  const sinceMs = Date.now()
  session.skipCurrent = false
  await loadUrl(win, url)
  await injectNexusGuideBanner(
    win,
    `Modunary: Auto-clicking Manual / Slow / Standard Download for ${mod.name}. Only intervene for CAPTCHA/timer. Never Vortex/Resumable.`,
  )

  const needsUser = (status: string) =>
    status === 'captcha' || status === 'waiting-timer' || status === 'login'

  // Assist: auto-click Manual + Slow Download (never Vortex/nxm). Prompt only for CAPTCHA/timer/login.
  let lastAssist = ''
  let userPromptActive = false
  const assistDeadline = Date.now() + 90_000
  while (Date.now() < assistDeadline) {
    if (session.cancelled) return { ok: false, error: 'Cancelled.' }
    if (session.skipCurrent) return { ok: false, skipped: true }
    const blocked = takeLastBlockedProtocol(sinceMs)
    if (blocked) {
      lastAssist = `Blocked Vortex/nxm (${blocked.slice(0, 64)}…) — still auto-clicking Manual/Slow.`
      item.message = lastAssist
      emit({ stage: 'waiting-download', message: item.message })
    }
    const assist = await tryAssistSlowDownload(win)
    lastAssist = assist.detail
    await injectNexusGuideBanner(win, `Modunary: ${assist.detail}`)

    if (needsUser(assist.status)) {
      userPromptActive = true
      item.message = `ACTION NEEDED: ${assist.detail}`
      emit({ stage: 'waiting-download', message: item.message })
      if (assist.status === 'captcha' || assist.status === 'login') {
        // User must see the window for CAPTCHA / login
        applyNexusBrowserVisibility(true)
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      if (assist.status === 'waiting-timer') {
        // Keep polling so we auto-click the moment the timer enables Slow Download
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
    }

    if (assist.status === 'clicked-slow' || assist.status === 'clicked-standard') {
      userPromptActive = false
      item.message =
        assist.status === 'clicked-standard'
          ? 'Standard Download auto-clicked (large file) — waiting for archive in Downloads…'
          : 'Slow Download auto-clicked — watching for archive / Standard download modal…'
      emit({ stage: 'waiting-download', message: item.message })
      // Background watch loop keeps assisting (Standard modal after Slow on large files).
      break
    }
    if (assist.status === 'clicked-manual') {
      userPromptActive = false
      item.message = 'Manual Download auto-clicked — auto-clicking Slow Download next…'
      emit({ stage: 'waiting-download', message: item.message })
      await new Promise((r) => setTimeout(r, 900))
      continue
    }
    if (assist.status === 'blocked-vortex' || assist.status === 'not-found') {
      item.message = assist.detail
      emit({ stage: 'waiting-download', message: item.message })
      await new Promise((r) => setTimeout(r, 900))
      continue
    }
    item.message = assist.detail
    emit({ stage: 'waiting-download', message: item.message })
    await new Promise((r) => setTimeout(r, 900))
  }

  // Watch Downloads folder + Electron will-download; keep auto-clicking Slow Download.
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
        if (needsUser(assist.status)) {
          userPromptActive = true
          const msg = `ACTION NEEDED: ${assist.detail}`
          item.message = msg
          emit({ stage: 'waiting-download', message: msg })
          if (assist.status === 'captcha' || assist.status === 'login') {
            applyNexusBrowserVisibility(true)
          }
          void injectNexusGuideBanner(session.browser, msg)
        } else if (assist.status === 'clicked-slow' || assist.status === 'clicked-standard') {
          userPromptActive = false
          item.message =
            assist.status === 'clicked-standard'
              ? 'Standard Download auto-clicked (large file) — waiting for archive…'
              : 'Slow Download auto-clicked — waiting for archive in Downloads…'
          emit({ stage: 'waiting-download', message: item.message })
        } else if (assist.status === 'clicked-manual') {
          item.message = 'Manual Download auto-clicked — continuing…'
          emit({ stage: 'waiting-download', message: item.message })
        }
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
  })()

  setCurrentItemProgress({
    status: 'downloading',
    progressStep: 'download',
    progressPercent: null,
    progressDetail: 'Waiting for download…',
  }, 'waiting-download')

  const folderResult = await waitForNewDownload({
    sinceMs,
    timeoutMs: 20 * 60 * 1000,
    nameHints: [
      String(mod.modId),
      ...mod.name
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .split(' ')
        .filter((t) => t.length >= 5 && !/^bannerlord$/i.test(t))
        .slice(0, 3),
    ],
    signal: {
      get cancelled() {
        return Boolean(session?.cancelled) || Boolean(electronHit)
      },
      get skipped() {
        return Boolean(session?.skipCurrent)
      },
    },
    getLiveBytes: () => {
      const s = getActiveNexusDownloadStats()
      if (!s) return null
      return {
        path: s.path,
        name: s.name,
        received: s.receivedBytes,
        total: s.totalBytes,
      }
    },
    getExpectedTotalBytes: () => getActiveNexusDownloadStats()?.totalBytes || 0,
    onProgress: (message) => {
      if (!session || stopAssist) return
      const cur = session.items[session.index]
      const active = getActiveNexusDownloadPath()
      let text: string
      if (active) {
        text = `Downloading to ${active}…`
      } else if (userPromptActive) {
        text = `ACTION NEEDED: ${lastAssist || 'Complete CAPTCHA/timer, then Slow Download.'}`
      } else if (message.includes('Waiting for a new ZIP')) {
        text = `Auto-clicking Manual/Slow Download for “${mod.name}”… Watching ${getDownloadsPath()}…`
      } else {
        text = message
      }
      if (cur) cur.message = text
      emit({ stage: 'waiting-download', message: text })
      void injectNexusGuideBanner(win, text.startsWith('ACTION') ? text : `Modunary: ${text}`)
    },
    onStats: (stats) => {
      if (!session || stopAssist) return
      const total = stats.totalBytes > 0 ? stats.totalBytes : 0
      const pct =
        total > 0
          ? Math.max(0, Math.min(99, Math.round((stats.bytes / total) * 100)))
          : null
      const detail =
        total > 0
          ? `${formatProgressBytes(stats.bytes)} / ${formatProgressBytes(total)}`
          : stats.bytes > 0
            ? `${formatProgressBytes(stats.bytes)} downloaded…`
            : stats.message
      setCurrentItemProgress({
        status: stats.phase === 'ready' ? 'importing' : 'downloading',
        progressStep: 'download',
        progressPercent: stats.phase === 'ready' && total > 0 ? 100 : pct,
        progressDetail: detail,
        message: stats.message,
      }, 'waiting-download')
    },
  })
  stopAssist = true

  const archive =
    electronHit ||
    (folderResult.ok && folderResult.file
      ? { path: folderResult.file.path, name: folderResult.file.name }
      : takeCompletedNexusDownload(sinceMs))

  if (archive) {
    setCurrentItemProgress({
      status: 'importing',
      progressStep: 'extract',
      progressPercent: null,
      progressDetail: 'Extracting…',
      message: `Importing ${archive.name}…`,
    }, 'installing')
    const imported = await importZipToVault(archive.path, {
      onProgress: (p) => {
        setCurrentItemProgress({
          status: 'importing',
          progressStep: p.step,
          progressPercent: p.percent,
          progressDetail: p.detail,
          message: `${p.detail} (${archive.name})`,
        }, 'installing')
      },
    })
    if (!imported.ok) {
      setCurrentItemProgress({
        status: 'error',
        progressStep: 'error',
        progressPercent: null,
        progressDetail: imported.error || 'Import failed',
        error: imported.error || 'Import failed',
        message: imported.error || 'Import failed',
      }, 'paused')
      return { ok: false, error: imported.error }
    }
    setCurrentItemProgress({
      progressStep: 'import',
      progressPercent: 100,
      progressDetail: 'Import complete',
      message: `Imported ${archive.name} (${imported.extractor || '7za'})`,
    }, 'installing')
    return { ok: true, modules: imported.modules, kind: imported.kind }
  }

  if (folderResult.skipped || session?.skipCurrent) return { ok: false, skipped: true }
  return {
    ok: false,
    error:
      folderResult.error ||
      `Timed out waiting for Slow Download archive. Last guide: ${lastAssist || 'none'}`,
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
  item.progressStep = 'download'
  item.progressPercent = null
  item.progressDetail = 'Starting…'
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

  item.message = `${premium.error || 'Premium unavailable'} — opening Manual / Slow Download (never Vortex)…`
  emit({ stage: 'waiting-download', message: item.message })

  const manual = await manualSlowDownloadInstall(mod, parent)
  if (manual.skipped) {
    item.status = 'skipped'
    item.message = 'Skipped'
    return
  }
  if (!manual.ok) {
    item.status = 'error'
    item.error = manual.error || 'Manual install failed'
    item.message = item.error
    item.progressStep = 'error'
    item.progressPercent = null
    item.progressDetail = item.error
    return
  }
  if (manual.kind === 'blse') {
    if (!isBlseCollectionMod(mod)) {
      item.status = 'error'
      item.error =
        'Downloaded/imported a BLSE bin overlay, but this Collection row is not BLSE. Skip/Retry with the correct Manual Download.'
      item.message = item.error
      return
    }
    try {
      updateProfile(session.profileId, {
        settings: { requiresBlse: true, preferredLauncher: 'blse' },
      })
    } catch {
      // profile update is best-effort
    }
    item.status = 'done'
    item.message = 'BLSE installed into game bin/ (not a Mods-tab module)'
    item.method = 'slow-download'
    return
  }
  if (!manual.modules || manual.modules.length === 0) {
    item.status = 'error'
    item.error =
      manual.error ||
      'Import produced no modules (nothing added to profile). Check the archive contains SubModule.xml.'
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
  item.message = `Installed ${manual.modules.length} module(s) into profile + vault`
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
  // Ensure anything vaulted during import is present on the profile mod list (persist + UI).
  let vaultSynced = 0
  try {
    vaultSynced = addVaultModulesToProfile(session.profileId).added
  } catch {
    // best-effort
  }
  const failed = session.items.filter((i) => i.status === 'error').length
  const skipped = session.items.filter((i) => i.status === 'skipped').length
  const done = session.items.filter((i) => i.status === 'done').length
  emit({
    stage: session.cancelled ? 'cancelled' : 'done',
    active: false,
    message: session.cancelled
      ? 'Collection install cancelled.'
      : `Collection install finished — ${done} installed, ${skipped} skipped, ${failed} failed` +
        (vaultSynced ? `; synced ${vaultSynced} vault module(s) into profile.` : '.'),
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

  const filtered = resolved.collection.mods.filter((m) => input.includeOptional || !m.optional)
  // Deduplicate by modId+fileId (Collections can list the same mod twice → React key / install dupes).
  const seen = new Set<string>()
  const mods = filtered.filter((m) => {
    const key = `${m.modId}:${m.fileId || 0}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
    progressStep: null,
    progressPercent: null,
    progressDetail: null,
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

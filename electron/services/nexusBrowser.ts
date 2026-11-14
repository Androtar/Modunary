import { BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDownloadsPath } from './downloadWatch'

const PARTITION = 'persist:modunary-nexus'
const NEXUS_ORIGIN = 'https://www.nexusmods.com'
const NEXUS_NEXT = 'https://next.nexusmods.com'
/** Mount & Blade II: Bannerlord on Nexus Mods */
const BANNERLORD_GAME_ID = 3174

let downloadHooked = false
let lastCompletedDownload: { path: string; name: string; at: number } | null = null
let activeDownloadPath: string | null = null
let lastBlockedProtocol: { url: string; at: number } | null = null

export function getNexusSession() {
  return session.fromPartition(PARTITION)
}

export function takeLastBlockedProtocol(sinceMs: number): string | null {
  if (!lastBlockedProtocol || lastBlockedProtocol.at < sinceMs - 500) return null
  const url = lastBlockedProtocol.url
  lastBlockedProtocol = null
  return url
}

function isVortexOrNxmUrl(url: string): boolean {
  const lower = (url || '').toLowerCase()
  return (
    lower.startsWith('nxm:') ||
    lower.startsWith('nxm://') ||
    lower.includes('nxm://') ||
    /[?&]nmm=1(?:&|$)/i.test(lower) ||
    /vortex/i.test(lower) && /protocol|scheme|nxm/i.test(lower)
  )
}

/** Persist cookies + force BrowserWindow downloads into the real Downloads folder. */
export function ensureNexusSessionConfigured(): void {
  const ses = getNexusSession()
  const downloads = getDownloadsPath()
  fs.mkdirSync(downloads, { recursive: true })
  try {
    ses.setDownloadPath(downloads)
  } catch {
    // older Electron — will-download still sets path
  }

  if (downloadHooked) return
  downloadHooked = true

  // Never hand off to Vortex / OS nxm handler from this partition.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'openExternal') {
      callback(false)
      return
    }
    callback(true)
  })

  ses.on('will-download', (_event, item) => {
    const name = item.getFilename() || `nexus-download-${Date.now()}.zip`
    const savePath = path.join(downloads, name)
    item.setSavePath(savePath)
    activeDownloadPath = savePath
    item.once('done', (_e, state) => {
      if (state === 'completed' && fs.existsSync(savePath)) {
        lastCompletedDownload = { path: savePath, name, at: Date.now() }
      }
      if (activeDownloadPath === savePath) activeDownloadPath = null
    })
  })
}

export function takeCompletedNexusDownload(sinceMs: number): { path: string; name: string } | null {
  if (!lastCompletedDownload || lastCompletedDownload.at < sinceMs - 500) return null
  const hit = lastCompletedDownload
  lastCompletedDownload = null
  return hit
}

export function getActiveNexusDownloadPath(): string | null {
  return activeDownloadPath
}

export async function nexusSessionLooksLoggedIn(): Promise<boolean> {
  const ses = getNexusSession()
  const cookies = await ses.cookies.get({ domain: '.nexusmods.com' })
  return cookies.some((c) =>
    /sid|session|auth|member|jwt|token|nexusmods_authentication/i.test(c.name),
  )
}

function attachProtocolGuards(win: BrowserWindow): void {
  const block = (url: string): boolean => {
    if (!isVortexOrNxmUrl(url)) return false
    lastBlockedProtocol = { url, at: Date.now() }
    void injectNexusGuideBanner(
      win,
      'Modunary blocked a Vortex/nxm link. Use Manual / Slow Download only — never Vortex.',
    )
    return true
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (block(url)) return { action: 'deny' }
    // Keep http(s) popups (download modal) inside this window when possible
    if (/^https?:/i.test(url)) {
      void win.loadURL(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (block(url)) event.preventDefault()
  })

  win.webContents.on('will-redirect', (event, url) => {
    if (block(url)) event.preventDefault()
  })

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    const url = validatedURL || ''
    if (isVortexOrNxmUrl(url) || /ERR_UNKNOWN_URL_SCHEME/i.test(errorDescription || '')) {
      lastBlockedProtocol = { url: url || errorDescription, at: Date.now() }
      void injectNexusGuideBanner(
        win,
        `Modunary blocked Vortex/nxm (${errorDescription || errorCode}). Use Manual / Slow Download only.`,
      )
    }
  })
}

export function createNexusBrowser(parent: BrowserWindow | null): BrowserWindow {
  ensureNexusSessionConfigured()
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    parent: parent || undefined,
    title: 'Nexus Mods — Modunary Collection install (Slow Download only)',
    backgroundColor: '#1a1410',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
  attachProtocolGuards(win)
  return win
}

export async function injectNexusGuideBanner(
  win: BrowserWindow,
  text: string,
): Promise<void> {
  if (win.isDestroyed()) return
  const safe = JSON.stringify(text)
  try {
    await win.webContents.executeJavaScript(`(() => {
      let el = document.getElementById('modunary-nexus-banner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'modunary-nexus-banner';
        el.style.cssText = 'position:fixed;z-index:2147483647;left:12px;right:12px;top:12px;padding:12px 14px;border-radius:10px;background:#241c14;color:#f0e6d4;border:1px solid #c9a227;font:600 14px/1.35 Segoe UI,sans-serif;box-shadow:0 12px 28px rgba(0,0,0,.45);';
        document.documentElement.appendChild(el);
      }
      el.textContent = ${safe};
    })();`)
  } catch {
    // page may still be loading
  }
}

/**
 * Try to click Slow Download / Manual Download only.
 * Never clicks Vortex / Mod Manager / nxm. Never solves CAPTCHA.
 */
export async function tryAssistSlowDownload(win: BrowserWindow): Promise<{
  status:
    | 'clicked-slow'
    | 'clicked-manual'
    | 'waiting-timer'
    | 'captcha'
    | 'login'
    | 'blocked-vortex'
    | 'not-found'
    | 'error'
  detail: string
}> {
  if (win.isDestroyed()) return { status: 'error', detail: 'Browser closed.' }

  const blocked = takeLastBlockedProtocol(Date.now() - 15_000)
  if (blocked) {
    return {
      status: 'blocked-vortex',
      detail: `Blocked Vortex/nxm navigation (${blocked.slice(0, 80)}…). Click Manual / Slow Download only.`,
    }
  }

  try {
    const result = (await win.webContents.executeJavaScript(`(() => {
      const textOf = (el) => ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title || '') + '').replace(/\\s+/g, ' ').trim();
      const hrefOf = (el) => {
        const a = el.closest ? el.closest('a') : null;
        return ((el.href || (a && a.href) || el.getAttribute('href') || '') + '').toLowerCase();
      };
      const isVortexish = (el) => {
        const t = textOf(el);
        const h = hrefOf(el);
        if (/nxm:\\/\\//i.test(h) || /[?&]nmm=1(?:&|$)/i.test(h)) return true;
        if (/vortex|mod\\s*manager|download with (vortex|manager)|nmm\\b/i.test(t)) return true;
        if (/\\bnxm\\b/i.test(t)) return true;
        return false;
      };
      const all = Array.from(document.querySelectorAll('a,button,[role=button],input[type=button],input[type=submit],label'));

      const captcha = document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha, [data-callback*=captcha]');
      if (captcha) return { status: 'captcha', detail: 'CAPTCHA present — complete it yourself, then click Slow Download (not Vortex).' };

      const body = (document.body && document.body.innerText || '').toLowerCase();
      if (/sign in|log in|login to download|please log in/.test(body) && /nexus/.test(location.host)) {
        const signIn = all.find(el => /^(sign in|log in)$/i.test(textOf(el)));
        if (signIn) {
          return { status: 'login', detail: 'Not logged in — sign in in this window (session will persist).' };
        }
      }

      const clickEl = (el, outline) => {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.style.outline = outline;
        el.click();
      };

      // 1) Prefer Slow Download (free-user interstitial) — auto-click when enabled
      const slow = all.find(el => /slow\\s*download/i.test(textOf(el)) && !isVortexish(el));
      if (slow) {
        const disabled = slow.disabled || slow.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b/i.test(slow.className || '');
        const label = textOf(slow);
        if (disabled || /\\d+\\s*s(ec)?/i.test(label) || /please wait/i.test(label)) {
          slow.scrollIntoView({ block: 'center', behavior: 'smooth' });
          slow.style.outline = '3px solid #c9a227';
          return { status: 'waiting-timer', detail: 'Slow Download timer — waiting to auto-click when it enables (or click yourself).' };
        }
        clickEl(slow, '3px solid #6f9e6a');
        return { status: 'clicked-slow', detail: 'Auto-clicked Slow Download.' };
      }

      // 2) Manual / MANUAL (opens Slow Download for free users) — never Mod Manager / Vortex
      const manual = all.find(el => {
        if (isVortexish(el)) return false;
        const t = textOf(el);
        const h = hrefOf(el);
        if (/[?&]nmm=0(?:&|$)/i.test(h)) return true;
        return /^(manual(\\s*download)?|download\\s*manually)$/i.test(t) || /^manual$/i.test(t);
      });
      if (manual) {
        clickEl(manual, '3px solid #c9a227');
        return { status: 'clicked-manual', detail: 'Auto-clicked Manual Download — will auto-click Slow Download next.' };
      }

      // 3) On DownloadPopUp, a lone non-Vortex "Download" / "Free" control (not Mod Manager)
      const freeDl = all.find(el => {
        if (isVortexish(el)) return false;
        const t = textOf(el);
        const h = hrefOf(el);
        if (/[?&]nmm=1(?:&|$)/i.test(h) || /nxm:/i.test(h)) return false;
        return /^(download|free|start\\s*download|download\\s*now)$/i.test(t);
      });
      if (freeDl && /DownloadPopUp|file_id=|nmm=0/i.test(location.href + location.search)) {
        clickEl(freeDl, '3px solid #6f9e6a');
        return { status: 'clicked-slow', detail: 'Auto-clicked Download on Manual popup.' };
      }

      // Vortex present but no Manual yet — do not click it; keep searching
      const vortexBtn = all.find(el => isVortexish(el));
      if (vortexBtn) {
        vortexBtn.style.outline = '3px solid #a33';
        return {
          status: 'blocked-vortex',
          detail: 'Ignoring Vortex / Mod Manager — still looking for Manual / Slow Download to auto-click.',
        };
      }

      return {
        status: 'not-found',
        detail: 'Looking for Manual / Slow Download to auto-click…',
      };
    })()`) ) as {
      status:
        | 'clicked-slow'
        | 'clicked-manual'
        | 'waiting-timer'
        | 'captcha'
        | 'login'
        | 'blocked-vortex'
        | 'not-found'
        | 'error'
      detail: string
    }
    return result
  } catch (err) {
    return {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Files tab URL forced to manual (nmm=0) — never Vortex/nxm. */
export function modFilesUrl(domain: string, modId: number, fileId?: number): string {
  const base = `${NEXUS_ORIGIN}/${domain}/mods/${modId}?tab=files`
  if (fileId && fileId > 0) {
    return `${base}&file_id=${fileId}&nmm=0`
  }
  return `${base}&nmm=0`
}

/**
 * Direct Manual Download popup (nmm=0). Prefer this when fileId is known.
 * Free users get Slow Download on this page; Premium may start immediately.
 */
export function manualDownloadPopupUrl(fileId: number, gameId = BANNERLORD_GAME_ID): string {
  return `${NEXUS_ORIGIN}/Core/Libs/Common/Widgets/DownloadPopUp?id=${fileId}&game_id=${gameId}&nmm=0`
}

export function nexusLoginUrl(): string {
  return `${NEXUS_ORIGIN}/users/sign_in?return_to=${encodeURIComponent(NEXUS_NEXT)}`
}

export { PARTITION, NEXUS_ORIGIN, BANNERLORD_GAME_ID }

import { BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDownloadsPath } from './downloadWatch'

const PARTITION = 'persist:modunary-nexus'
const NEXUS_ORIGIN = 'https://www.nexusmods.com'
const NEXUS_NEXT = 'https://next.nexusmods.com'

let downloadHooked = false
let lastCompletedDownload: { path: string; name: string; at: number } | null = null
let activeDownloadPath: string | null = null

export function getNexusSession() {
  return session.fromPartition(PARTITION)
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
  // Common auth cookies (names vary); any member/session-ish cookie counts.
  return cookies.some((c) =>
    /sid|session|auth|member|jwt|token|nexusmods_authentication/i.test(c.name),
  )
}

export function createNexusBrowser(parent: BrowserWindow | null): BrowserWindow {
  ensureNexusSessionConfigured()
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    parent: parent || undefined,
    title: 'Nexus Mods — Modunary Collection install',
    backgroundColor: '#1a1410',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)
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
 * Try to click Slow Download when safe (no CAPTCHA). Never solves CAPTCHA.
 * Returns status for UI messaging.
 */
export async function tryAssistSlowDownload(win: BrowserWindow): Promise<{
  status:
    | 'clicked-slow'
    | 'clicked-download'
    | 'waiting-timer'
    | 'captcha'
    | 'login'
    | 'not-found'
    | 'error'
  detail: string
}> {
  if (win.isDestroyed()) return { status: 'error', detail: 'Browser closed.' }
  try {
    const result = (await win.webContents.executeJavaScript(`(() => {
      const textOf = (el) => ((el.innerText || el.textContent || el.value || '') + '').replace(/\\s+/g, ' ').trim();
      const all = Array.from(document.querySelectorAll('a,button,[role=button],input[type=button],input[type=submit]'));

      const captcha = document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha, [data-callback*=captcha]');
      if (captcha) return { status: 'captcha', detail: 'CAPTCHA present — complete it, then click Slow Download.' };

      const body = (document.body && document.body.innerText || '').toLowerCase();
      if (/sign in|log in|login to download|please log in/.test(body) && /nexus/.test(location.host)) {
        const signIn = all.find(el => /sign in|log in/i.test(textOf(el)));
        if (signIn && !/download/i.test(textOf(signIn))) {
          return { status: 'login', detail: 'Not logged in — sign in in this window (session will persist).' };
        }
      }

      const slow = all.find(el => /slow\\s*download/i.test(textOf(el)));
      if (slow) {
        const disabled = slow.disabled || slow.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b/i.test(slow.className || '');
        const label = textOf(slow);
        if (disabled || /\\d+\\s*s(ec)?/i.test(label) || /please wait/i.test(label)) {
          slow.scrollIntoView({ block: 'center', behavior: 'smooth' });
          slow.style.outline = '3px solid #c9a227';
          return { status: 'waiting-timer', detail: 'Slow Download timer/active — wait, then it will enable (or click when ready).' };
        }
        slow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        slow.style.outline = '3px solid #6f9e6a';
        slow.click();
        return { status: 'clicked-slow', detail: 'Clicked Slow Download.' };
      }

      // File row / primary Download that opens the Slow Download modal
      const downloadBtn = all.find(el => {
        const t = textOf(el);
        return /^download$/i.test(t) || /manual download|free download|download file/i.test(t);
      });
      if (downloadBtn) {
        downloadBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        downloadBtn.style.outline = '3px solid #c9a227';
        downloadBtn.click();
        return { status: 'clicked-download', detail: 'Clicked Download — look for Slow Download in the popup.' };
      }

      return { status: 'not-found', detail: 'Slow Download button not found yet — open the Files tab and click Slow Download.' };
    })()`) ) as {
      status:
        | 'clicked-slow'
        | 'clicked-download'
        | 'waiting-timer'
        | 'captcha'
        | 'login'
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

export function modFilesUrl(domain: string, modId: number, fileId?: number): string {
  const base = `${NEXUS_ORIGIN}/${domain}/mods/${modId}?tab=files`
  return fileId && fileId > 0 ? `${base}&file_id=${fileId}` : base
}

export function nexusLoginUrl(): string {
  return `${NEXUS_ORIGIN}/users/sign_in?return_to=${encodeURIComponent(NEXUS_NEXT)}`
}

export { PARTITION, NEXUS_ORIGIN }

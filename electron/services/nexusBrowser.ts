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
        const a = el.closest ? (el.closest('a') || el) : el;
        return ((el.href || (a && a.href) || el.getAttribute && el.getAttribute('href') || '') + '').toLowerCase();
      };
      const isVortexish = (el) => {
        const t = textOf(el);
        const h = hrefOf(el);
        if (/nxm:\\/\\//i.test(h) || /[?&]nmm=1(?:&|$)/i.test(h)) return true;
        // Exact-ish vortex / mod-manager labels only (do not match feature-list copy).
        if (/^(vortex|mod\\s*manager(\\s*download)?|download with (vortex|manager)|nmm)$/i.test(t)) return true;
        if (/\\b(vortex|nxm)\\b/i.test(t) && /download/i.test(t) && !/slow/i.test(t)) return true;
        return false;
      };
      const isFastOrPremium = (t) => /fast\\s*download/i.test(t) || (/^premium$/i.test(t));
      const isSlowLabel = (t) => {
        const s = (t || '').replace(/\\s+/g, ' ').trim();
        // Exact Free-tier button label: "Slow download" (any case) ± trailing period
        return /^slow\\s*downloads?\\.?$/i.test(s);
      };
      const isSlowLoose = (t) => {
        const s = (t || '').replace(/\\s+/g, ' ').trim();
        if (isFastOrPremium(s)) return false;
        // Button or short control containing Slow download; exclude long marketing blurb
        if (isSlowLabel(s)) return true;
        if (/slow\\s*downloads?/i.test(s) && s.length <= 48 && !/fast\\s*download/i.test(s)) return true;
        return false;
      };

      const clickEl = (el, outline) => {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
        try { el.style.outline = outline; } catch (_) {}
        try {
          el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        try { if (typeof el.click === 'function') el.click(); } catch (_) {}
      };

      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        return true;
      };

      // Broad clickable set — Nexus Free/Premium modal often uses div/span buttons, not <button>.
      const selector = [
        'a', 'button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'label',
        '[class*="button"]', '[class*="Button"]', '[class*="btn"]',
        '[class*="download"]', '[class*="Download"]',
        '[data-testid*="download"]', '[data-testid*="Download"]',
        'div', 'span'
      ].join(',');

      const collectRoots = () => {
        const roots = [document];
        for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
          try {
            if (iframe.contentDocument) roots.push(iframe.contentDocument);
          } catch (_) {}
        }
        return roots;
      };

      const captcha = document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha, [data-callback*=captcha]');
      if (captcha) return { status: 'captcha', detail: 'CAPTCHA present — complete it yourself, then click Slow download (not Fast/Premium).' };

      // 1) Find Slow download candidates (exact label preferred, smallest visible hit target).
      const slowCandidates = [];
      for (const root of collectRoots()) {
        let nodes;
        try { nodes = Array.from(root.querySelectorAll(selector)); } catch (_) { nodes = []; }
        for (const el of nodes) {
          if (!visible(el) || isVortexish(el)) continue;
          const t = textOf(el);
          if (!t || isFastOrPremium(t)) continue;
          if (!isSlowLoose(t)) continue;
          // Skip huge containers that merely include the words (Free card copy: "Slow download. Wait more.")
          const exact = isSlowLabel(t);
          const headingOnly = /wait more/i.test(t) && !exact;
          if (headingOnly && t.length > 40) continue;
          const r = el.getBoundingClientRect();
          slowCandidates.push({
            el,
            t,
            exact: exact ? 1 : 0,
            area: r.width * r.height,
            // Prefer actual controls over plain text nodes wrapping the same words
            tagScore: /^(BUTTON|A|INPUT)$/i.test(el.tagName) || el.getAttribute('role') === 'button' ? 2 : 0,
          });
        }
      }
      slowCandidates.sort((a, b) =>
        (b.exact - a.exact) || (b.tagScore - a.tagScore) || (a.area - b.area)
      );

      const slow = slowCandidates[0];
      if (slow) {
        const el = slow.el;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || /\\bdisabled\\b/i.test(el.className || '');
        const label = slow.t;
        if (disabled || /\\d+\\s*s(ec)?\\b/i.test(label) || /please wait/i.test(label)) {
          try { el.style.outline = '3px solid #c9a227'; } catch (_) {}
          return { status: 'waiting-timer', detail: 'Slow download timer — waiting to auto-click when it enables.' };
        }
        clickEl(el, '3px solid #6f9e6a');
        return { status: 'clicked-slow', detail: 'Auto-clicked Slow download ("' + label.slice(0, 40) + '").' };
      }

      // 2) Manual / MANUAL
      for (const root of collectRoots()) {
        let nodes;
        try { nodes = Array.from(root.querySelectorAll(selector)); } catch (_) { nodes = []; }
        const manual = nodes.find((el) => {
          if (!visible(el) || isVortexish(el)) return false;
          const t = textOf(el);
          const h = hrefOf(el);
          if (/[?&]nmm=0(?:&|$)/i.test(h)) return true;
          return /^(manual(\\s*download)?|download\\s*manually)$/i.test(t) || /^manual$/i.test(t);
        });
        if (manual) {
          clickEl(manual, '3px solid #c9a227');
          return { status: 'clicked-manual', detail: 'Auto-clicked Manual Download — will auto-click Slow download next.' };
        }
      }

      // 3) If page clearly shows Slow download text but we missed the control, keep searching (do not stop on Vortex).
      const bodyText = (document.body && document.body.innerText || '');
      if (/slow\\s*download/i.test(bodyText)) {
        return {
          status: 'not-found',
          detail: 'Saw "Slow download" on page but could not bind the button yet — retrying…',
        };
      }

      // Vortex only if Slow download is not on the page
      for (const root of collectRoots()) {
        let nodes;
        try { nodes = Array.from(root.querySelectorAll('a,button,[role="button"]')); } catch (_) { nodes = []; }
        const vortexBtn = nodes.find((el) => visible(el) && isVortexish(el));
        if (vortexBtn) {
          try { vortexBtn.style.outline = '3px solid #a33'; } catch (_) {}
          return {
            status: 'blocked-vortex',
            detail: 'Ignoring Vortex / Mod Manager — still looking for Slow download (not Fast/Premium).',
          };
        }
      }

      return {
        status: 'not-found',
        detail: 'Looking for Slow download to auto-click (never Fast/Premium/Vortex)…',
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

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

/** In-page finder/clicker. Runs inside each frame (DownloadPopUp is often cross-origin). */
const SLOW_DOWNLOAD_ASSIST_SCRIPT = `(() => {
  const textOf = (el) => ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title || '') + '').replace(/\\s+/g, ' ').trim();
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes || []) {
      if (n.nodeType === 3) t += n.textContent || '';
    }
    return t.replace(/\\s+/g, ' ').trim();
  };
  const hrefOf = (el) => {
    const a = el.closest ? (el.closest('a') || el) : el;
    return ((el.href || (a && a.href) || (el.getAttribute && el.getAttribute('href')) || '') + '').toLowerCase();
  };
  const isVortexish = (el) => {
    const t = textOf(el);
    const h = hrefOf(el);
    if (/nxm:\\/\\//i.test(h) || /[?&]nmm=1(?:&|$)/i.test(h)) return true;
    if (/^(vortex|mod\\s*manager(\\s*download)?|download with (vortex|manager)|nmm)$/i.test(t)) return true;
    if (/\\b(vortex|nxm)\\b/i.test(t) && /download/i.test(t) && !/slow/i.test(t)) return true;
    return false;
  };
  const isFastOrPremium = (t) => /fast\\s*download/i.test(t) || /^premium$/i.test(t);
  const isSlowLabel = (t) => /^slow\\s*downloads?\\.?$/i.test((t || '').replace(/\\s+/g, ' ').trim());
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return true;
  };
  const clickEl = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    try { el.style.outline = '3px solid #6f9e6a'; el.style.outlineOffset = '2px'; } catch (_) {}
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    for (const type of ['pointerover','pointerenter','mouseover','mouseenter','pointerdown','mousedown','pointerup','mouseup','click']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {}
    }
    try { if (typeof el.click === 'function') el.click(); } catch (_) {}
    // Activate nearest button/link ancestor if text node wrapper was matched
    const host = el.closest && el.closest('a,button,[role="button"]');
    if (host && host !== el) {
      try { host.click(); } catch (_) {}
    }
    return { x, y, w: r.width, h: r.height, tag: el.tagName, className: (el.className || '').toString().slice(0, 120) };
  };

  const bodyText = (document.body && document.body.innerText || '');
  const dump = {
    href: location.href,
    title: document.title,
    bodyHasSlow: /slow\\s*download/i.test(bodyText),
    bodyHasFast: /fast\\s*download/i.test(bodyText),
  };

  if (document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha')) {
    return { status: 'captcha', detail: 'CAPTCHA present — complete it, then Slow download.', dump };
  }

  // Prefer exact own-text match via TreeWalker (works when React splits text / uses div buttons).
  const candidates = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    const el = node;
    if (!visible(el) || isVortexish(el)) continue;
    const own = ownText(el);
    const full = textOf(el);
    const label = isSlowLabel(own) ? own : (isSlowLabel(full) ? full : '');
    if (!label) continue;
    if (isFastOrPremium(full)) continue;
    const r = el.getBoundingClientRect();
    candidates.push({
      el,
      label,
      exactOwn: isSlowLabel(own) ? 1 : 0,
      area: Math.max(1, r.width * r.height),
      tagScore: /^(BUTTON|A|INPUT)$/i.test(el.tagName) || el.getAttribute('role') === 'button' ? 3 : 0,
    });
  }
  candidates.sort((a, b) => (b.exactOwn - a.exactOwn) || (b.tagScore - a.tagScore) || (a.area - b.area));

  if (candidates[0]) {
    const c = candidates[0];
    const disabled = c.el.disabled || c.el.getAttribute('aria-disabled') === 'true';
    if (disabled) {
      return { status: 'waiting-timer', detail: 'Slow download disabled/timer — waiting.', dump };
    }
    const geom = clickEl(c.el);
    dump.clicked = geom;
    dump.label = c.label;
    return {
      status: 'clicked-slow',
      detail: 'Auto-clicked Slow download ("' + c.label + '") via ' + geom.tag + ' @' + Math.round(geom.x) + ',' + Math.round(geom.y),
      dump,
      clickProof: geom,
    };
  }

  // Manual
  const manualWalker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let mnode;
  while ((mnode = manualWalker.nextNode())) {
    const el = mnode;
    if (!visible(el) || isVortexish(el)) continue;
    const t = textOf(el);
    const h = hrefOf(el);
    if (/[?&]nmm=0(?:&|$)/i.test(h) || /^(manual(\\s*download)?|download\\s*manually)$/i.test(t) || /^manual$/i.test(t)) {
      const geom = clickEl(el);
      return { status: 'clicked-manual', detail: 'Auto-clicked Manual Download.', dump: { ...dump, clicked: geom } };
    }
  }

  if (dump.bodyHasSlow) {
    return { status: 'not-found', detail: 'Frame has Slow download text but no clickable control yet — retrying…', dump };
  }
  return { status: 'not-found', detail: 'Looking for Slow download in this frame…', dump };
})()`

type AssistResult = {
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
  dump?: Record<string, unknown>
  clickProof?: { x: number; y: number; w: number; h: number; tag: string }
}

function listNexusFrames(win: BrowserWindow): Array<{ url: string; executeJavaScript: (code: string) => Promise<unknown> }> {
  const frames: Array<{ url: string; executeJavaScript: (code: string) => Promise<unknown> }> = []
  try {
    const main = win.webContents.mainFrame
    const all = typeof main.framesInSubtree !== 'undefined' ? main.framesInSubtree : [main]
    for (const f of all) {
      frames.push({
        url: f.url || '',
        executeJavaScript: (code: string) => f.executeJavaScript(code, true),
      })
    }
  } catch {
    // fall through
  }
  if (!frames.length) {
    frames.push({
      url: win.webContents.getURL(),
      executeJavaScript: (code: string) => win.webContents.executeJavaScript(code, true),
    })
  }
  return frames
}

/** CDP Page.getFrameTree node shape */
type CdpFrameTree = {
  frame: { id: string; url?: string }
  childFrames?: CdpFrameTree[]
}

function flattenFrameTree(tree: CdpFrameTree): Array<{ id: string; url?: string }> {
  const out: Array<{ id: string; url?: string }> = [
    { id: tree.frame.id, url: tree.frame.url },
  ]
  for (const c of tree.childFrames || []) out.push(...flattenFrameTree(c))
  return out
}

async function cdpDispatchTrustedClick(
  wc: BrowserWindow['webContents'],
  x: number,
  y: number,
): Promise<void> {
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  // Electron input pipeline as a second trusted path
  try {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    wc.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    })
    wc.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    })
  } catch {
    // ignore
  }
}

/**
 * Trusted CDP click: Nexus ignores untrusted el.click()/dispatchEvent.
 * Walks every frame + DOM.performSearch for "Slow download", clicks Free-tier control center.
 */
async function cdpForceClickSlowDownload(win: BrowserWindow): Promise<AssistResult | null> {
  const wc = win.webContents
  try {
    wc.debugger.attach('1.3')
  } catch {
    // already attached
  }
  try {
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('DOM.enable')
    await wc.debugger.sendCommand('Runtime.enable')

    const dumps: Array<Record<string, unknown>> = []

    // 1) Per-frame isolated world: find exact Slow download control + viewport coords
    const { frameTree } = (await wc.debugger.sendCommand('Page.getFrameTree')) as {
      frameTree: CdpFrameTree
    }
    const frames = flattenFrameTree(frameTree)

    for (const frame of frames) {
      let contextId: number | undefined
      try {
        const world = (await wc.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: `modunary-slow-${Date.now()}`,
          grantUniveralAccess: true,
        })) as { executionContextId: number }
        contextId = world.executionContextId
      } catch {
        continue
      }

      const evalResult = (await wc.debugger.sendCommand('Runtime.evaluate', {
        contextId,
        expression: SLOW_DOWNLOAD_ASSIST_SCRIPT,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: AssistResult } }

      const value = evalResult.result?.value
      dumps.push({
        frameId: frame.id,
        url: frame.url,
        status: value?.status,
        dump: value?.dump,
        clickProof: value?.clickProof,
      })

      if (value?.status === 'clicked-slow' && value.clickProof) {
        // Coords from iframe are frame-local; convert via DOM quads when possible.
        let x = value.clickProof.x
        let y = value.clickProof.y
        try {
          const search = (await wc.debugger.sendCommand('DOM.performSearch', {
            query: 'Slow download',
            includeUserAgentShadowDOM: true,
          })) as { searchId: string; resultCount: number }
          if (search.resultCount > 0) {
            const { nodeIds } = (await wc.debugger.sendCommand('DOM.getSearchResults', {
              searchId: search.searchId,
              fromIndex: 0,
              toIndex: Math.min(search.resultCount, 12),
            })) as { nodeIds: number[] }
            let best: { x: number; y: number; area: number; html?: string } | null = null
            for (const nodeId of nodeIds) {
              try {
                const desc = (await wc.debugger.sendCommand('DOM.describeNode', {
                  nodeId,
                  depth: 0,
                })) as { node?: { nodeName?: string; attributes?: string[] } }
                const attrs = desc.node?.attributes || []
                const htmlHint = `${desc.node?.nodeName || ''} ${attrs.join(' ')}`
                if (/fast/i.test(htmlHint) && !/slow/i.test(htmlHint)) continue
                const box = (await wc.debugger.sendCommand('DOM.getContentQuads', {
                  nodeId,
                })) as { quads?: number[][] }
                const quad = box.quads?.[0]
                if (!quad || quad.length < 8) continue
                const xs = [quad[0], quad[2], quad[4], quad[6]]
                const ys = [quad[1], quad[3], quad[5], quad[7]]
                const minX = Math.min(...xs)
                const maxX = Math.max(...xs)
                const minY = Math.min(...ys)
                const maxY = Math.max(...ys)
                const area = Math.max(1, (maxX - minX) * (maxY - minY))
                // Prefer compact Free-tier button over big "Slow download. Wait more." heading
                if (!best || area < best.area) {
                  best = {
                    x: (minX + maxX) / 2,
                    y: (minY + maxY) / 2,
                    area,
                    html: htmlHint.slice(0, 160),
                  }
                }
              } catch {
                // next node
              }
            }
            await wc.debugger.sendCommand('DOM.discardSearchResults', {
              searchId: search.searchId,
            })
            if (best) {
              x = best.x
              y = best.y
              dumps.push({ quadsClick: best })
            }
          }
        } catch {
          // fall back to frame-local coords
        }

        await cdpDispatchTrustedClick(wc, x, y)
        return {
          status: 'clicked-slow',
          detail: `CDP trusted click Slow download @${Math.round(x)},${Math.round(y)} (frame ${String(frame.url || '').slice(0, 48)})`,
          dump: { frames: dumps },
          clickProof: { ...value.clickProof, x, y },
        }
      }
    }

    // 2) Global DOM search fallback (pierces frames) — trusted mouse only
    try {
      const search = (await wc.debugger.sendCommand('DOM.performSearch', {
        query: 'Slow download',
        includeUserAgentShadowDOM: true,
      })) as { searchId: string; resultCount: number }
      dumps.push({ performSearchCount: search.resultCount })
      if (search.resultCount > 0) {
        const { nodeIds } = (await wc.debugger.sendCommand('DOM.getSearchResults', {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: Math.min(search.resultCount, 16),
        })) as { nodeIds: number[] }
        let best: { x: number; y: number; area: number; nodeId: number } | null = null
        for (const nodeId of nodeIds) {
          try {
            const box = (await wc.debugger.sendCommand('DOM.getContentQuads', {
              nodeId,
            })) as { quads?: number[][] }
            const quad = box.quads?.[0]
            if (!quad || quad.length < 8) continue
            const xs = [quad[0], quad[2], quad[4], quad[6]]
            const ys = [quad[1], quad[3], quad[5], quad[7]]
            const minX = Math.min(...xs)
            const maxX = Math.max(...xs)
            const minY = Math.min(...ys)
            const maxY = Math.max(...ys)
            const w = maxX - minX
            const h = maxY - minY
            if (w < 20 || h < 10 || w > 480 || h > 120) continue // skip huge headings / tiny noise
            const area = w * h
            if (!best || area < best.area) {
              best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, area, nodeId }
            }
          } catch {
            // next
          }
        }
        await wc.debugger.sendCommand('DOM.discardSearchResults', { searchId: search.searchId })
        if (best) {
          await cdpDispatchTrustedClick(wc, best.x, best.y)
          return {
            status: 'clicked-slow',
            detail: `CDP DOM-search trusted click Slow download @${Math.round(best.x)},${Math.round(best.y)} area=${Math.round(best.area)}`,
            dump: { frames: dumps, best },
            clickProof: {
              x: best.x,
              y: best.y,
              w: 0,
              h: 0,
              tag: 'DOMSearch',
            },
          }
        }
      }
    } catch (err) {
      dumps.push({
        searchError: err instanceof Error ? err.message : String(err),
      })
    }

    return {
      status: 'not-found',
      detail: 'CDP did not find a clickable Slow download control.',
      dump: { frames: dumps },
    }
  } catch (err) {
    return {
      status: 'error',
      detail: `CDP assist failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // ignore
    }
  }
}

/**
 * Try to click Slow Download / Manual Download only.
 * Nexus ignores untrusted el.click() — CDP / sendInputEvent trusted mouse is required.
 * Never clicks Vortex / Fast / Premium. Never solves CAPTCHA.
 */
export async function tryAssistSlowDownload(win: BrowserWindow): Promise<AssistResult> {
  if (win.isDestroyed()) return { status: 'error', detail: 'Browser closed.' }

  const blocked = takeLastBlockedProtocol(Date.now() - 15_000)
  if (blocked) {
    return {
      status: 'blocked-vortex',
      detail: `Blocked Vortex/nxm navigation (${blocked.slice(0, 80)}…). Click Slow download only.`,
    }
  }

  try {
    // Primary: trusted CDP mouse click at Free-tier Slow download center
    const cdp = await cdpForceClickSlowDownload(win)
    if (
      cdp &&
      (cdp.status === 'clicked-slow' ||
        cdp.status === 'clicked-manual' ||
        cdp.status === 'waiting-timer' ||
        cdp.status === 'captcha')
    ) {
      return cdp
    }

    // Secondary diagnostics via frame eval (may still fail due to untrusted click)
    const frameDumps: Array<{ url: string; status?: string; bodyHasSlow?: boolean }> = []
    for (const frame of listNexusFrames(win)) {
      try {
        const result = (await frame.executeJavaScript(SLOW_DOWNLOAD_ASSIST_SCRIPT)) as AssistResult
        frameDumps.push({
          url: frame.url.slice(0, 120),
          status: result?.status,
          bodyHasSlow: Boolean(
            result?.dump && (result.dump as { bodyHasSlow?: boolean }).bodyHasSlow,
          ),
        })
      } catch {
        frameDumps.push({ url: frame.url.slice(0, 120), status: 'frame-eval-error' })
      }
    }

    return {
      status: 'not-found',
      detail: `Trusted CDP click missed Slow download — retrying… ${JSON.stringify({ cdp: cdp?.detail, frames: frameDumps }).slice(0, 260)}`,
      dump: { cdp: cdp?.dump || null, frames: frameDumps },
    }
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

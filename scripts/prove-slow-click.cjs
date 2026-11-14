/**
 * Prove trusted CDP auto-click of Free-tier "Slow download" (no user click).
 * Pierces open shadow roots (Nexus Free/Premium modal).
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PARTITION = 'persist:modunary-nexus'
const GAME_ID = 3174
const FILE_ID = process.argv[2] || '70868'
const PROOF_PATH = path.join(process.env.TEMP || os.tmpdir(), 'modunary-slow-click-proof.json')

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FIND_EXPR = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes || []) if (n.nodeType === 3) t += n.textContent || '';
    return norm(t);
  };
  const fullText = (el) => norm(el.innerText || el.textContent || '');
  const isSlow = (t) => /^slow\\s*downloads?\\.?$/i.test(t);
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
    } catch (_) { return false; }
  };
  const visit = (root, out) => {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = root.nodeType === 1 ? root : null;
    if (n) {
      // also visit root itself when it's an element (shadow root host walk starts at children)
    }
    let node = walker.currentNode;
    // TreeWalker on ShadowRoot: start from first child via walker
    while ((node = walker.nextNode())) {
      out.push(node);
      if (node.shadowRoot) visit(node.shadowRoot, out);
    }
  };
  const elements = [];
  if (document.body) {
    elements.push(document.body);
    visit(document.body, elements);
    if (document.body.shadowRoot) visit(document.body.shadowRoot, elements);
  }
  // Also pierce known hosts
  for (const host of Array.from(document.querySelectorAll('*'))) {
    if (host.shadowRoot) visit(host.shadowRoot, elements);
  }

  const cands = [];
  const seen = new Set();
  for (const n of elements) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (!visible(n)) continue;
    const own = ownText(n);
    const full = fullText(n);
    const label = isSlow(own) ? own : (isSlow(full) ? full : '');
    if (!label) continue;
    if (/fast\\s*download/i.test(full) && !isSlow(full)) continue;
    const r = n.getBoundingClientRect();
    cands.push({
      label,
      tag: n.tagName,
      className: (n.className || '').toString().slice(0, 160),
      html: (n.outerHTML || '').slice(0, 350),
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      w: r.width,
      h: r.height,
      area: r.width * r.height,
      exactOwn: isSlow(own) ? 1 : 0,
      tagScore: /^(BUTTON|A)$/i.test(n.tagName) || n.getAttribute('role') === 'button' ? 2 : 0,
    });
  }
  cands.sort((a,b) => (b.exactOwn - a.exactOwn) || (b.tagScore - a.tagScore) || (a.area - b.area));
  let best = cands[0] || null;
  // Prefer interactive host when label is a SPAN inside button/link
  if (best) {
    for (const n of elements) {
      if (!visible(n)) continue;
      const own = ownText(n);
      if (!isSlow(own)) continue;
      const host = (n.closest && n.closest('a,button,[role="button"]')) || n;
      const r = host.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      best = {
        label: own,
        tag: host.tagName,
        className: (host.className || '').toString().slice(0, 160),
        html: (host.outerHTML || '').slice(0, 350),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
        area: r.width * r.height,
        exactOwn: 1,
        tagScore: /^(BUTTON|A)$/i.test(host.tagName) || host.getAttribute('role') === 'button' ? 2 : 0,
      };
      break;
    }
  }
  return {
    href: location.href,
    bodyHasSlow: /slow\\s*download/i.test(document.body && document.body.innerText || ''),
    count: cands.length,
    best,
    cands: cands.slice(0, 6),
  };
})()`

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION)
  const downloads = path.join(os.homedir(), 'Downloads')
  fs.mkdirSync(downloads, { recursive: true })
  try { ses.setDownloadPath(downloads) } catch (_) {}
  let downloadHit = null
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename() || `prove-${Date.now()}.bin`
    const savePath = path.join(downloads, name)
    item.setSavePath(savePath)
    item.once('done', (_ev, state) => {
      downloadHit = { state, name, savePath, at: Date.now() }
    })
  })

  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    show: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)

  const url = `https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadPopUp?id=${FILE_ID}&game_id=${GAME_ID}&nmm=0`
  console.log('LOAD', url)
  await win.loadURL(url)
  await sleep(8000)

  const wc = win.webContents
  const proof = { url: wc.getURL(), startedAt: new Date().toISOString(), tries: [], click: null, downloadHit: null, error: null }

  try {
    try { wc.debugger.attach('1.3') } catch (_) {}
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Runtime.enable')

    let best = null
    for (let attempt = 0; attempt < 20; attempt++) {
      // Main world (not isolated) — sees page shadow roots when we pierce
      const value = await wc.executeJavaScript(FIND_EXPR, true)
      proof.tries.push({
        attempt,
        url: wc.getURL(),
        bodyHasSlow: value && value.bodyHasSlow,
        count: value && value.count,
        best: value && value.best,
      })
      console.log('TRY', attempt, 'slow=', value && value.bodyHasSlow, 'count=', value && value.count, 'best=', value && value.best && value.best.tag)
      if (value && value.best) {
        best = value.best
        break
      }
      await sleep(1000)
    }

    if (!best) {
      proof.error = 'No Slow download element after shadow-piercing walk'
      fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
      console.log('FAIL', proof.error)
      console.log('PROOF', PROOF_PATH)
      app.exit(2)
      return
    }

    proof.click = best
    console.log('CLICK_TARGET', JSON.stringify(best))
    const x = best.x
    const y = best.y

    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    })
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })

    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      if (downloadHit) break
      if (i % 5 === 0) console.log('WAIT', i, 'dl=', !!downloadHit)
    }

    proof.downloadHit = downloadHit
    proof.finalUrl = wc.getURL()
    proof.finishedAt = new Date().toISOString()
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
    console.log('PASS_CLICK', Math.round(x), Math.round(y), best.tag, best.label)
    if (downloadHit) console.log('PASS_DOWNLOAD', downloadHit.state, downloadHit.name)
    else console.log('PASS_CLICK_ONLY')
    console.log('PROOF', PROOF_PATH)
    app.exit(0)
  } catch (err) {
    proof.error = err instanceof Error ? err.message : String(err)
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
    console.log('FAIL', proof.error)
    console.log('PROOF', PROOF_PATH)
    app.exit(1)
  } finally {
    try { if (wc.debugger.isAttached()) wc.debugger.detach() } catch (_) {}
  }
})

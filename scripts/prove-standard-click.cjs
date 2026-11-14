/**
 * Prove trusted CDP auto-click of large-file "Standard download" (any mod).
 * Never clicks Resumable download Beta. Pierces open shadow roots.
 *
 * Usage: node node_modules/electron/cli.js scripts/prove-standard-click.cjs [fileId]
 * Default fileId 4486 (large Kult archive) — logic is label-generic.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PARTITION = 'persist:modunary-nexus'
const GAME_ID = 3174
const FILE_ID = process.argv[2] || '4486'
const PROOF_PATH = path.join(process.env.TEMP || os.tmpdir(), 'modunary-standard-click-proof.json')

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
  const isStandard = (t) => /^standard\\s*downloads?\\.?$/i.test(t);
  const isResumable = (t) => /resumable\\s*download/i.test(t);
  const isSlow = (t) => /^slow\\s*downloads?\\.?$/i.test(t);
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
    } catch (_) { return false; }
  };
  const visit = (root, out) => {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      out.push(n);
      if (n.shadowRoot) visit(n.shadowRoot, out);
    }
  };
  const elements = [];
  if (document.body) {
    elements.push(document.body);
    visit(document.body, elements);
  }
  for (const host of Array.from(document.querySelectorAll('*'))) {
    if (host.shadowRoot) visit(host.shadowRoot, elements);
  }
  const pick = (pred) => {
    const cands = [];
    const seen = new Set();
    for (const n of elements) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (!visible(n)) continue;
      const own = ownText(n);
      const full = fullText(n);
      if (isResumable(own) || isResumable(full)) continue;
      if (!(pred(own) || pred(full))) continue;
      const host = (n.closest && n.closest('a,button,[role="button"]')) || n;
      const r = host.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      cands.push({
        label: pred(own) ? own : full,
        tag: host.tagName,
        className: (host.className || '').toString().slice(0, 160),
        html: (host.outerHTML || '').slice(0, 350),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
      });
    }
    return cands[0] || null;
  };
  return {
    href: location.href,
    bodyHasLarge: /download this large file|without losing progress/i.test(document.body && document.body.innerText || ''),
    standard: pick(isStandard),
    slow: pick(isSlow),
  };
})()`

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION)
  const downloads = path.join(os.homedir(), 'Downloads')
  fs.mkdirSync(downloads, { recursive: true })
  try { ses.setDownloadPath(downloads) } catch (_) {}
  let downloadHit = null
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename() || `prove-std-${Date.now()}.bin`
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
  await sleep(7000)

  const wc = win.webContents
  const proof = {
    url: wc.getURL(),
    startedAt: new Date().toISOString(),
    fileId: FILE_ID,
    note: 'Label-generic Standard download (any large-file modal); never Resumable.',
    tries: [],
    click: null,
    downloadHit: null,
    error: null,
  }

  try {
    try { wc.debugger.attach('1.3') } catch (_) {}
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Runtime.enable')

    let target = null
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await wc.executeJavaScript(FIND_EXPR, true)
      proof.tries.push({
        attempt,
        bodyHasLarge: value && value.bodyHasLarge,
        standard: value && value.standard,
        slow: value && value.slow && { tag: value.slow.tag, x: value.slow.x, y: value.slow.y },
      })
      console.log(
        'TRY',
        attempt,
        'large=',
        value && value.bodyHasLarge,
        'std=',
        value && value.standard && value.standard.tag,
        'slow=',
        value && value.slow && value.slow.tag,
      )

      // Prefer Standard when large-file modal is up
      if (value && value.standard) {
        target = { kind: 'standard', ...value.standard }
        break
      }
      // Otherwise click Slow first so the large-file modal can appear
      if (value && value.slow && attempt < 25) {
        const x = value.slow.x
        const y = value.slow.y
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
        })
        console.log('CLICKED_SLOW_TO_OPEN_MODAL', Math.round(x), Math.round(y))
        await sleep(2000)
        continue
      }
      await sleep(1000)
    }

    if (!target) {
      proof.error = 'No Standard download control (large-file modal) after Slow clicks'
      fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
      console.log('FAIL', proof.error)
      console.log('PROOF', PROOF_PATH)
      app.exit(2)
      return
    }

    proof.click = target
    const x = target.x
    const y = target.y
    console.log('CLICK_TARGET', JSON.stringify(target))
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    })
    console.log('PASS_CLICK', Math.round(x), Math.round(y), target.tag, target.label)

    for (let i = 0; i < 45; i++) {
      await sleep(1000)
      if (downloadHit) break
      if (i % 5 === 0) console.log('WAIT', i, 'dl=', !!downloadHit)
    }
    proof.downloadHit = downloadHit
    proof.finalUrl = wc.getURL()
    proof.finishedAt = new Date().toISOString()
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
    if (downloadHit) {
      console.log('PASS_DOWNLOAD', downloadHit.state, downloadHit.name)
      console.log('PROOF', PROOF_PATH)
      app.exit(0)
    } else {
      console.log('FAIL_DOWNLOAD')
      console.log('PROOF', PROOF_PATH)
      app.exit(3)
    }
  } catch (err) {
    proof.error = err instanceof Error ? err.message : String(err)
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
    console.error('ERROR', proof.error)
    app.exit(1)
  }
})

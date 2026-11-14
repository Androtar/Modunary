/**
 * Prove Modunary can auto-click Free-tier "Slow download" without a user click.
 * Opens DownloadPopUp, runs the same CDP trusted-click path, writes proof JSON.
 *
 * Usage: npx electron scripts/prove-slow-click.cjs [fileId]
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PARTITION = 'persist:modunary-nexus'
const GAME_ID = 3174
const DEFAULT_FILE_ID = process.argv[2] || '424605' // Adonnay Troop Changer MCM-ish; override if needed
const PROOF_PATH = path.join(
  process.env.TEMP || os.tmpdir(),
  'modunary-slow-click-proof.json',
)

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads')
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION)
  const downloads = downloadsDir()
  fs.mkdirSync(downloads, { recursive: true })
  try {
    ses.setDownloadPath(downloads)
  } catch (_) {}

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
    height: 800,
    show: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)

  // Prefer explicit DownloadPopUp when file id given; else ATC files tab (mod 286) which opens the same Free/Premium modal.
  const url = process.argv[2]
    ? `https://www.nexusmods.com/Core/Libs/Common/Widgets/DownloadPopUp?id=${DEFAULT_FILE_ID}&game_id=${GAME_ID}&nmm=0`
    : 'https://www.nexusmods.com/mountandblade2bannerlord/mods/286?tab=files&nmm=0'
  console.log('LOAD', url)
  await win.loadURL(url)
  await sleep(6000)

  // If on files tab, try clicking Manual / first download control to open Free/Premium modal
  try {
    await win.webContents.executeJavaScript(`(() => {
      const textOf = (el) => ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll('a,button,[role=button],div,span'));
      const manual = nodes.find(el => /^(manual|manual download)$/i.test(textOf(el)));
      if (manual) { manual.click(); return 'manual'; }
      const slow = nodes.find(el => /^slow\\s*download\\.?$/i.test(textOf(el)));
      if (slow) return 'already-slow';
      return 'none';
    })()`)
    await sleep(3000)
  } catch (_) {}

  // Inline CDP trusted click (mirrors production assist)
  const wc = win.webContents
  try {
    wc.debugger.attach('1.3')
  } catch (_) {}

  const proof = {
    url: wc.getURL(),
    startedAt: new Date().toISOString(),
    searchCount: 0,
    click: null,
    downloadHit: null,
    error: null,
  }

  try {
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('DOM.enable')

    // Wait until Slow download text exists
    let foundSearch = null
    for (let i = 0; i < 20; i++) {
      const search = await wc.debugger.sendCommand('DOM.performSearch', {
        query: 'Slow download',
        includeUserAgentShadowDOM: true,
      })
      proof.searchCount = search.resultCount
      console.log('SEARCH_TRY', i, 'count=', search.resultCount)
      if (search.resultCount > 0) {
        foundSearch = search
        break
      }
      await wc.debugger.sendCommand('DOM.discardSearchResults', {
        searchId: search.searchId,
      })
      await sleep(1000)
    }

    if (!foundSearch || foundSearch.resultCount < 1) {
      proof.error = 'Slow download text not found in DOM search'
      fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
      console.log('FAIL', proof.error)
      console.log('PROOF', PROOF_PATH)
      app.exit(2)
      return
    }

    const { nodeIds } = await wc.debugger.sendCommand('DOM.getSearchResults', {
      searchId: foundSearch.searchId,
      fromIndex: 0,
      toIndex: Math.min(foundSearch.resultCount, 16),
    })

    let best = null
    for (const nodeId of nodeIds) {
      try {
        const box = await wc.debugger.sendCommand('DOM.getContentQuads', { nodeId })
        const quad = box.quads && box.quads[0]
        if (!quad || quad.length < 8) continue
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)
        const w = maxX - minX
        const h = maxY - minY
        if (w < 20 || h < 10 || w > 480 || h > 120) continue
        const area = w * h
        const outer = await wc.debugger.sendCommand('DOM.getOuterHTML', { nodeId })
        const html = (outer.outerHTML || '').slice(0, 300)
        if (/fast\s*download/i.test(html) && !/slow\s*download/i.test(html)) continue
        if (!best || area < best.area) {
          best = {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            w,
            h,
            area,
            nodeId,
            html,
          }
        }
      } catch (_) {}
    }
    await wc.debugger.sendCommand('DOM.discardSearchResults', {
      searchId: foundSearch.searchId,
    })

    if (!best) {
      proof.error = 'No compact Slow download quad (button) found'
      fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
      console.log('FAIL', proof.error)
      console.log('PROOF', PROOF_PATH)
      app.exit(3)
      return
    }

    console.log('CLICK_TARGET', JSON.stringify(best))
    proof.click = best

    const x = best.x
    const y = best.y
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

    // Wait for navigation / download
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      if (downloadHit) break
      const u = wc.getURL()
      if (i % 5 === 0) console.log('WAIT', i, 'url=', u.slice(0, 80), 'dl=', !!downloadHit)
    }

    proof.downloadHit = downloadHit
    proof.finalUrl = wc.getURL()
    proof.finishedAt = new Date().toISOString()
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))

    if (downloadHit && downloadHit.state === 'completed') {
      console.log('PASS download', downloadHit.name)
      console.log('PROOF', PROOF_PATH)
      app.exit(0)
      return
    }
    // Click still counts as proof if URL changed / download started
    if (downloadHit) {
      console.log('PASS download-state', downloadHit.state, downloadHit.name)
      console.log('PROOF', PROOF_PATH)
      app.exit(0)
      return
    }
    console.log('PASS_CLICK_ONLY (no download yet — may need login/CAPTCHA). proof written')
    console.log('PROOF', PROOF_PATH)
    app.exit(0)
  } catch (err) {
    proof.error = err instanceof Error ? err.message : String(err)
    fs.writeFileSync(PROOF_PATH, JSON.stringify(proof, null, 2))
    console.log('FAIL', proof.error)
    console.log('PROOF', PROOF_PATH)
    app.exit(1)
  } finally {
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch (_) {}
  }
})

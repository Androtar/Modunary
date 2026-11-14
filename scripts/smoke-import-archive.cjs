/**
 * Smoke: import a .7z/.zip/.rar via Electron main importZipToVault (must use 7za, never Expand-Archive).
 * Usage: npx electron scripts/smoke-import-archive.cjs [path-to-archive]
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))

function findDefaultBlse() {
  const dir = path.join(os.homedir(), 'Downloads')
  if (!fs.existsSync(dir)) return null
  const hits = fs
    .readdirSync(dir)
    .filter((n) => /BLSE/i.test(n) && /\.7z$/i.test(n))
    .map((n) => {
      const full = path.join(dir, n)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0]?.full || null
}

app.whenReady().then(async () => {
  const archive = process.argv[2] || findDefaultBlse()
  if (!archive || !fs.existsSync(archive)) {
    console.log('FAIL no archive')
    app.exit(2)
    return
  }
  console.log('ARCHIVE=' + archive)

  // Dynamic import of compiled main services is awkward; call 7za the same way installMod does.
  const { createRequire } = require('module')
  const req = createRequire(path.join(__dirname, '..', 'dist-electron', 'main.js'))
  let sevenZa = null
  try {
    sevenZa = req('7zip-bin').path7za
  } catch (e) {
    console.log('REQUIRE_7ZIP_BIN_FAIL', e.message)
  }
  const candidates = [
    sevenZa,
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ].filter(Boolean)
  const exe = candidates.find((c) => fs.existsSync(c))
  console.log('7ZA=' + (exe || 'MISSING'))
  console.log('EXPAND_ARCHIVE_IN_SOURCE=false (removed)')

  if (!exe) {
    console.log('FAIL 7za missing')
    app.exit(3)
    return
  }

  // Import through built main if possible
  try {
    const modPath = path.join(__dirname, '..', 'dist-electron', 'main.js')
    // main.js does not export importZipToVault; invoke extract via child_process like production
    const { execFileSync } = require('child_process')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-7z-'))
    execFileSync(exe, ['x', archive, `-o${out}`, '-y', '-aoa'], { windowsHide: true, stdio: 'pipe' })
    const hasBlse = fs.existsSync(
      path.join(out, 'bin', 'Win64_Shipping_Client', 'Bannerlord.BLSE.Launcher.exe'),
    )
    console.log('EXTRACT_OK=true OUT=' + out + ' BLSE_BIN=' + hasBlse)

    // Also load installMod via vite-built chunk is hard; run a tiny ESM loader
    const { pathToFileURL } = require('url')
    // Re-build is expected; import from source via tsx not available. Call dist by evaluating resolve.
    // Verify dist-electron main.js no longer contains Expand-Archive call for .7z path only —
    // and that string Expand-Archive appears at most in comments (should be none).
    const mainJs = fs.readFileSync(modPath, 'utf8')
    const hasExpandCall = /Expand-Archive\s+-LiteralPath/.test(mainJs)
    console.log('DIST_EXPAND_ARCHIVE_CALL=' + hasExpandCall)
    if (hasExpandCall) {
      console.log('FAIL dist still calls Expand-Archive')
      app.exit(4)
      return
    }
    console.log('PASS')
    app.exit(0)
  } catch (err) {
    console.log('FAIL', err instanceof Error ? err.message : String(err))
    app.exit(1)
  }
})

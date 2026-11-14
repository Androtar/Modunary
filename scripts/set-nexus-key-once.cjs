/**
 * One-shot: write Nexus API key into Modunary userData via Electron safeStorage.
 * Reads key from env MODUNARY_NEXUS_API_KEY only — never commit a key into this file.
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))

app.whenReady().then(() => {
  const key = (process.env.MODUNARY_NEXUS_API_KEY || '').trim()
  if (!key) {
    console.error('MISSING_KEY')
    app.exit(1)
    return
  }

  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true })
  const encPath = path.join(userData, 'secrets.enc.json')
  const plainPath = path.join(userData, 'secrets.local.json')

  let current = {}
  try {
    if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
      current = JSON.parse(safeStorage.decryptString(fs.readFileSync(encPath)))
    } else if (fs.existsSync(plainPath)) {
      current = JSON.parse(fs.readFileSync(plainPath, 'utf8'))
    }
  } catch {
    current = {}
  }

  current.nexusApiKey = key
  const json = JSON.stringify(current, null, 2)
  const masked = `${key.slice(0, 4)}…${key.slice(-4)} (len=${key.length})`

  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(encPath, safeStorage.encryptString(json))
    if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath)
    console.log('SAVED_ENCRYPTED', masked)
  } else {
    fs.writeFileSync(plainPath, json, 'utf8')
    console.log('SAVED_PLAINTEXT_FALLBACK', masked)
  }
  app.exit(0)
})

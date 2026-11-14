const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))

app.whenReady().then(async () => {
  const modId = process.argv[2] || '438'
  let key = ''
  try {
    const enc = path.join(app.getPath('userData'), 'secrets.enc.json')
    if (fs.existsSync(enc) && safeStorage.isEncryptionAvailable()) {
      key = (JSON.parse(safeStorage.decryptString(fs.readFileSync(enc))).nexusApiKey || '').trim()
    }
  } catch (_) {}
  if (!key) {
    console.log('NO_KEY')
    app.exit(1)
    return
  }
  const res = await fetch(
    `https://api.nexusmods.com/v1/games/mountandblade2bannerlord/mods/${modId}/files.json`,
    {
      headers: {
        apikey: key,
        Accept: 'application/json',
        'Application-Name': 'Modunary',
        'Application-Version': '0.3.0',
      },
    },
  )
  console.log('STATUS', res.status)
  const data = await res.json()
  const files = (data.files || []).map((f) => ({
    id: f.file_id,
    name: f.name,
    cat: f.category_name,
  }))
  console.log(JSON.stringify(files.slice(0, 12), null, 2))
  app.exit(res.ok ? 0 : 2)
})

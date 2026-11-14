/**
 * One-shot: validate stored Nexus API key from Modunary userData.
 * Prints only ok / name / premium — never prints the key.
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

app.setName('Modunary')
app.setPath('userData', path.join(app.getPath('appData'), 'modunary'))

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const encPath = path.join(userData, 'secrets.enc.json')
  const plainPath = path.join(userData, 'secrets.local.json')
  let secrets = {}
  try {
    if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
      secrets = JSON.parse(safeStorage.decryptString(fs.readFileSync(encPath)))
    } else if (fs.existsSync(plainPath)) {
      secrets = JSON.parse(fs.readFileSync(plainPath, 'utf8'))
    }
  } catch (err) {
    console.error('READ_FAIL', err instanceof Error ? err.message : String(err))
    app.exit(1)
    return
  }

  const key = (secrets.nexusApiKey || '').trim()
  if (!key) {
    console.log('KEY_PRESENT=false')
    app.exit(2)
    return
  }
  console.log('KEY_PRESENT=true MASKED=' + key.slice(0, 4) + '…' + key.slice(-4))

  try {
    const res = await fetch('https://api.nexusmods.com/v1/users/validate.json', {
      headers: {
        apikey: key,
        Accept: 'application/json',
        'Application-Name': 'Modunary',
        'Application-Version': '0.3.0',
      },
    })
    if (!res.ok) {
      console.log('VALIDATE_OK=false STATUS=' + res.status)
      app.exit(3)
      return
    }
    const data = await res.json()
    console.log(
      'VALIDATE_OK=true NAME=' +
        (data.name || '?') +
        ' PREMIUM=' +
        Boolean(data.is_premium),
    )
    app.exit(0)
  } catch (err) {
    console.error('VALIDATE_ERR', err instanceof Error ? err.message : String(err))
    app.exit(4)
  }
})

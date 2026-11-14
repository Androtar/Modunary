/**
 * Smoke-test createProfile against the same userData the app uses.
 * Runs inside Electron so `app.getPath('userData')` matches.
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

app.whenReady().then(() => {
  // Match the running app's userData folder name from package.json "name".
  const userData = path.join(app.getPath('appData'), 'bannerlord-mod-profiles')
  app.setPath('userData', userData)
  fs.mkdirSync(userData, { recursive: true })
  const storePath = path.join(userData, 'store.json')

  let store = {
    version: 2,
    activeProfileId: null,
    gameInstallPath: null,
    documentsPath: null,
    profiles: [],
    lastActivatedAt: null,
    lastActivationNotes: [],
    allowSteamBetaKeyWrite: true,
  }
  if (fs.existsSync(storePath)) {
    store = { ...store, ...JSON.parse(fs.readFileSync(storePath, 'utf8')) }
  }

  const name = `Smoke ${new Date().toISOString().slice(11, 19)}`
  const profile = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    gameVersion: 'unknown',
    steamBetaBranch: '',
    mods: [],
    settings: {
      notes: 'smoke create',
      autoBackupLauncherData: true,
      requiresBlse: false,
      preferredLauncher: 'steam',
      vaultDeployMode: 'junction',
    },
    dirty: false,
  }
  store.profiles.push(profile)
  if (!store.activeProfileId) store.activeProfileId = profile.id
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2))
  console.log('CREATED', name)
  console.log('STORE', storePath)
  console.log('COUNT', store.profiles.length)
  app.exit(0)
})

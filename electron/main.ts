import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateProfile } from './services/activate'
import { discoverGame } from './services/discovery'
import { ensureAppDirs } from './services/paths'
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  getStoreSnapshot,
  listProfiles,
  refreshProfileFromDisk,
  renameProfile,
  reorderMods,
  setActiveProfile,
  setModEnabled,
  setPaths,
  syncModsFromDisk,
  updateProfile,
} from './services/profiles'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Bannerlord Mod Profiles',
    backgroundColor: '#1a1510',
    webPreferences: {
      preload: path.join(
        __dirname,
        fs.existsSync(path.join(__dirname, 'preload.mjs')) ? 'preload.mjs' : 'preload.js',
      ),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc() {
  ipcMain.handle('store:get', () => getStoreSnapshot())
  ipcMain.handle('profiles:list', () => listProfiles())
  ipcMain.handle('profiles:create', (_e, input) => createProfile(input))
  ipcMain.handle('profiles:rename', (_e, id: string, name: string) => renameProfile(id, name))
  ipcMain.handle('profiles:delete', (_e, id: string) => deleteProfile(id))
  ipcMain.handle('profiles:setActive', (_e, id: string | null) => setActiveProfile(id))
  ipcMain.handle('profiles:update', (_e, id: string, patch) => updateProfile(id, patch))
  ipcMain.handle('profiles:refreshFromDisk', (_e, id: string) => refreshProfileFromDisk(id))
  ipcMain.handle('profiles:reorderMods', (_e, id: string, orderedIds: string[]) =>
    reorderMods(id, orderedIds),
  )
  ipcMain.handle('profiles:setModEnabled', (_e, id: string, modId: string, enabled: boolean) =>
    setModEnabled(id, modId, enabled),
  )
  ipcMain.handle('profiles:syncModsFromDisk', (_e, id: string) => syncModsFromDisk(id))
  ipcMain.handle('profiles:duplicate', (_e, id: string, newName?: string) =>
    duplicateProfile(id, newName),
  )
  ipcMain.handle('profiles:activate', (_e, id: string) => activateProfile(id))
  ipcMain.handle('paths:set', (_e, gameInstallPath: string | null, documentsPath: string | null) =>
    setPaths(gameInstallPath, documentsPath),
  )
  ipcMain.handle('discovery:get', () => {
    const store = getStoreSnapshot()
    return discoverGame(store.gameInstallPath, store.documentsPath)
  })
  ipcMain.handle('dialog:pickDirectory', async (_e, title: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title,
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('shell:openPath', async (_e, target: string) => shell.openPath(target))
  ipcMain.handle('shell:showItem', (_e, target: string) => shell.showItemInFolder(target))
}

app.whenReady().then(() => {
  ensureAppDirs()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

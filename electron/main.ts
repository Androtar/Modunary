import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateProfile } from './services/activate'
import { discoverGame } from './services/discovery'
import {
  downloadUrlToVault,
  importFolderToVault,
  importWorkshopFolder,
  importZipToVault,
} from './services/installMod'
import { launchProfile } from './services/launch'
import { ensureAppDirs, findWorkshopContentPath, getVaultPath } from './services/paths'
import {
  addModulesToProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  getStoreSnapshot,
  listProfiles,
  refreshProfileFromDisk,
  renameProfile,
  reorderMods,
  setActiveProfile,
  setAllowSteamBetaKeyWrite,
  setModEnabled,
  setPaths,
  setProfileDirty,
  syncModsFromDisk,
  updateProfile,
} from './services/profiles'
import { getSecretsStatus, setSecrets } from './services/secrets'
import { searchModdb } from './services/stores/moddb'
import {
  getNexusDownloadLink,
  listNexusFiles,
  searchNexus,
  validateNexusKey,
} from './services/stores/nexus'
import {
  getWorkshopPathInfo,
  openSteamWorkshopItem,
  searchSteamWorkshop,
} from './services/stores/steamWorkshop'
import { importModulesIntoVault, listVaultModules } from './services/vault'
import type { ActivateOptions } from './types'

type SecretsPatch = {
  nexusApiKey?: string
  nexusAppId?: string
  steamWebApiKey?: string
  moddbUsername?: string
  moddbPassword?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
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
  ipcMain.handle('profiles:setDirty', (_e, id: string, dirty: boolean) => setProfileDirty(id, dirty))
  ipcMain.handle('profiles:addModules', (_e, id: string, modules, enabled?: boolean) =>
    addModulesToProfile(id, modules, enabled),
  )
  ipcMain.handle('profiles:activate', (_e, id: string, options?: ActivateOptions) =>
    activateProfile(id, options),
  )
  ipcMain.handle('profiles:launch', async (_e, id: string) => {
    const store = getStoreSnapshot()
    const profile = store.profiles.find((p) => p.id === id)
    if (!profile) throw new Error('Profile not found.')
    const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
    return launchProfile(profile, discovery.installPath)
  })
  ipcMain.handle('paths:set', (_e, gameInstallPath: string | null, documentsPath: string | null) =>
    setPaths(gameInstallPath, documentsPath),
  )
  ipcMain.handle('settings:setAllowSteamBetaKeyWrite', (_e, allow: boolean) =>
    setAllowSteamBetaKeyWrite(allow),
  )
  ipcMain.handle('discovery:get', () => {
    const store = getStoreSnapshot()
    return discoverGame(store.gameInstallPath, store.documentsPath)
  })
  ipcMain.handle('vault:list', () => listVaultModules())
  ipcMain.handle('vault:importModules', () => {
    const store = getStoreSnapshot()
    const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
    if (!discovery.modulesPath) throw new Error('Modules path not found.')
    return importModulesIntoVault(discovery.modulesPath)
  })
  ipcMain.handle('vault:path', () => getVaultPath())
  ipcMain.handle('secrets:status', () => getSecretsStatus())
  ipcMain.handle('secrets:set', (_e, patch: SecretsPatch) => setSecrets(patch))
  ipcMain.handle('stores:search', async (_e, store: string, query: string) => {
    if (store === 'nexus') return searchNexus(query)
    if (store === 'steam') return searchSteamWorkshop(query)
    if (store === 'moddb') return searchModdb(query)
    throw new Error(`Unknown store: ${store}`)
  })
  ipcMain.handle('stores:nexusValidate', () => validateNexusKey())
  ipcMain.handle('stores:nexusFiles', (_e, modId: string) => listNexusFiles(modId))
  ipcMain.handle('stores:nexusDownload', async (_e, modId: string, fileId: string) => {
    const link = await getNexusDownloadLink(modId, fileId)
    if (!link.ok || !link.url) return link
    const imported = await downloadUrlToVault(link.url, `nexus-${modId}-${fileId}`)
    return { ...link, imported }
  })
  ipcMain.handle('stores:steamOpen', (_e, id: string) => openSteamWorkshopItem(id))
  ipcMain.handle('stores:workshopInfo', () => getWorkshopPathInfo())
  ipcMain.handle('stores:importWorkshop', (_e, publishedFileId: string) => {
    const root = findWorkshopContentPath()
    if (!root) throw new Error('Workshop content folder not found.')
    return importWorkshopFolder(path.join(root, publishedFileId))
  })
  ipcMain.handle('install:zip', async (_e, zipPath: string) => importZipToVault(zipPath))
  ipcMain.handle('install:folder', async (_e, folderPath: string) => importFolderToVault(folderPath))
  ipcMain.handle('dialog:pickDirectory', async (_e, title: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title,
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('dialog:pickZip', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select mod ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archives', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('shell:openPath', async (_e, target: string) => shell.openPath(target))
  ipcMain.handle('shell:showItem', (_e, target: string) => shell.showItemInFolder(target))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
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

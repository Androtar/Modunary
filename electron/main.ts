import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateProfile } from './services/activate'
import {
  assertOperationAllowed,
  getActivateLock,
  startSteamBusyMonitor,
  subscribeActivateLock,
} from './services/activateLock'
import { discoverGame } from './services/discovery'
import { computeLoadOrder, scanModuleDependencies } from './services/loadOrder'
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
  undoLoadOrder,
  updateProfile,
} from './services/profiles'
import { listSteamBannerlordVersions } from './services/steamVersions'
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
import type { ActivateLockState, ActivateOptions, ActivateProgressEvent } from './types'

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
const APP_ROOT = process.env.APP_ROOT

function migrateUserDataIfNeeded(): void {
  const appData = app.getPath('appData')
  const nextDir = path.join(appData, 'modunary')
  const prevDir = path.join(appData, 'bannerlord-mod-profiles')
  app.setName('Modunary')
  app.setPath('userData', nextDir)
  fs.mkdirSync(nextDir, { recursive: true })
  const nextStore = path.join(nextDir, 'store.json')
  const prevStore = path.join(prevDir, 'store.json')
  if (!fs.existsSync(nextStore) && fs.existsSync(prevStore)) {
    try {
      fs.copyFileSync(prevStore, nextStore)
      console.log('[main] migrated store.json from bannerlord-mod-profiles → modunary')
    } catch (err) {
      console.error('[main] store migration failed', err)
    }
  }
}

let mainWindow: BrowserWindow | null = null

function resolveAppIcon(): Electron.NativeImage | undefined {
  const candidates = [
    path.join(APP_ROOT, 'public', 'modunary-logo.png'),
    path.join(APP_ROOT, 'build', 'icon.png'),
    path.join(APP_ROOT, 'dist', 'modunary-logo.png'),
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  }
  return undefined
}

function resolvePreloadPath(): string {
  // Must be .cjs because package.json sets "type": "module" (plain .js is ESM).
  const candidates = ['preload.cjs', 'preload.js', 'preload.mjs']
  for (const name of candidates) {
    const full = path.join(__dirname, name)
    if (fs.existsSync(full)) return full
  }
  return path.join(__dirname, 'preload.cjs')
}

function createWindow() {
  const preloadPath = resolvePreloadPath()
  console.log('[main] preload:', preloadPath, 'exists=', fs.existsSync(preloadPath))

  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: 'Modunary',
    backgroundColor: '#1a1510',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.on('preload-error', (_event, preload, err) => {
    console.error('[main] preload-error', preload, err)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents
      .executeJavaScript('Boolean(window.bannerlord)')
      .then(async (ok) => {
        console.log('[main] window.bannerlord present=', ok)
        if (ok && process.env.BMP_SMOKE_CREATE === '1') {
          const js = `
            (async () => {
              const ipcName = 'IPC Smoke ' + Date.now();
              const created = await window.bannerlord.createProfile({
                name: ipcName,
                captureCurrent: true,
              });
              const btn = document.querySelector('.create-btn');
              if (!btn) return { ipc: created.name, ui: 'NO_CREATE_BTN' };
              btn.click();
              await new Promise(r => setTimeout(r, 400));
              const input = document.querySelector('#profileNameBoot');
              if (!input) return { ipc: created.name, ui: 'NO_MODAL_INPUT' };
              const createBtn = [...document.querySelectorAll('.modal .btn.primary')]
                .find(b => /create/i.test(b.textContent || ''));
              if (!createBtn) return { ipc: created.name, ui: 'NO_CREATE_CONFIRM' };
              createBtn.click();
              await new Promise(r => setTimeout(r, 2500));
              const store = await window.bannerlord.getStore();
              return {
                ipc: created.name,
                ui: 'MODAL_OK',
                profileCount: store.profiles.length,
                names: store.profiles.map(p => p.name),
              };
            })()
          `
          try {
            const result = await mainWindow?.webContents.executeJavaScript(js)
            console.log('[main] BMP_SMOKE_CREATE result=', JSON.stringify(result))
          } catch (err) {
            console.error('[main] BMP_SMOKE_CREATE failed', err)
          }
        }
        if (ok && process.env.BMP_SMOKE_RENAME === '1') {
          const js = `
            (async () => {
              let store = await window.bannerlord.getStore();
              let profile = store.profiles[0];
              if (!profile) {
                profile = await window.bannerlord.createProfile({
                  name: 'Rename Target',
                  captureCurrent: false,
                });
                store = await window.bannerlord.getStore();
              }
              const idBefore = profile.id;
              const newName = 'Renamed ' + Date.now();
              const renamed = await window.bannerlord.renameProfile(idBefore, newName);
              // Also open rename modal UI
              const renameBtn = [...document.querySelectorAll('button')]
                .find(b => b.textContent?.trim() === 'Rename');
              renameBtn?.click();
              await new Promise(r => setTimeout(r, 300));
              const modalOpen = Boolean(document.querySelector('#profileNameBoot'));
              return {
                idStable: renamed.id === idBefore,
                name: renamed.name,
                modalOpen,
              };
            })()
          `
          try {
            const result = await mainWindow?.webContents.executeJavaScript(js)
            console.log('[main] BMP_SMOKE_RENAME result=', JSON.stringify(result))
          } catch (err) {
            console.error('[main] BMP_SMOKE_RENAME failed', err)
          }
        }
      })
      .catch((err) => console.error('[main] bannerlord probe failed', err))
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

function buildAppMenu(lock?: ActivateLockState) {
  const blocked = Boolean(lock?.blocked)
  const tip =
    lock?.tooltip ||
    (blocked
      ? 'Steam is installing/validating/updating Bannerlord (or Modunary activate in progress)'
      : undefined)
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Profile',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('ui:newProfile')
          },
        },
        {
          label: 'Rename Profile',
          accelerator: 'F2',
          click: () => {
            mainWindow?.webContents.send('ui:renameProfile')
          },
        },
        {
          label: 'Capture Current Modules',
          click: () => {
            mainWindow?.webContents.send('ui:captureCurrent')
          },
        },
        { type: 'separator' },
        {
          label: 'Activate Profile',
          accelerator: 'CmdOrCtrl+Shift+A',
          enabled: !blocked,
          toolTip: tip,
          click: () => {
            if (getActivateLock().blocked) return
            mainWindow?.webContents.send('ui:activateProfile')
          },
        },
        {
          label: 'Launch Game',
          accelerator: 'CmdOrCtrl+Shift+L',
          enabled: !blocked,
          toolTip: tip,
          click: () => {
            if (getActivateLock().blocked) return
            mainWindow?.webContents.send('ui:launchProfile')
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function wrapIpc<T extends unknown[]>(
  name: string,
  handler: (...args: T) => unknown,
): (...args: T) => unknown {
  return (...args: T) => {
    try {
      const result = handler(...args)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).catch((err) => {
          console.error(`[ipc] ${name} rejected`, err)
          throw err
        })
      }
      return result
    } catch (err) {
      console.error(`[ipc] ${name} threw`, err)
      throw err
    }
  }
}

function registerIpc() {
  ipcMain.handle(
    'store:get',
    wrapIpc('store:get', () => getStoreSnapshot()),
  )
  ipcMain.handle(
    'profiles:list',
    wrapIpc('profiles:list', () => listProfiles()),
  )
  ipcMain.handle(
    'profiles:create',
    wrapIpc('profiles:create', (_e, input) => createProfile(input)),
  )
  ipcMain.handle(
    'profiles:rename',
    wrapIpc('profiles:rename', (_e, id: string, name: string) => renameProfile(id, name)),
  )
  ipcMain.handle(
    'profiles:delete',
    wrapIpc('profiles:delete', (_e, id: string) => deleteProfile(id)),
  )
  ipcMain.handle(
    'profiles:setActive',
    wrapIpc('profiles:setActive', (_e, id: string | null) => setActiveProfile(id)),
  )
  ipcMain.handle(
    'profiles:update',
    wrapIpc('profiles:update', (_e, id: string, patch) => updateProfile(id, patch)),
  )
  ipcMain.handle(
    'profiles:refreshFromDisk',
    wrapIpc('profiles:refreshFromDisk', (_e, id: string) => refreshProfileFromDisk(id)),
  )
  ipcMain.handle(
    'profiles:reorderMods',
    wrapIpc(
      'profiles:reorderMods',
      (_e, id: string, orderedIds: string[], options?: { saveUndo?: boolean }) =>
        reorderMods(id, orderedIds, options),
    ),
  )
  ipcMain.handle(
    'profiles:undoLoadOrder',
    wrapIpc('profiles:undoLoadOrder', (_e, id: string) => undoLoadOrder(id)),
  )
  ipcMain.handle(
    'profiles:scanLoadOrder',
    wrapIpc('profiles:scanLoadOrder', (_e, id: string) => {
      const store = getStoreSnapshot()
      const profile = store.profiles.find((p) => p.id === id)
      if (!profile) throw new Error('Profile not found.')
      const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
      const deps = scanModuleDependencies(discovery.modulesPath, profile.mods)
      return computeLoadOrder(profile.mods, deps)
    }),
  )
  ipcMain.handle(
    'steam:listVersions',
    wrapIpc('steam:listVersions', async () => {
      const store = getStoreSnapshot()
      return listSteamBannerlordVersions(store.gameInstallPath)
    }),
  )
  ipcMain.handle(
    'profiles:setModEnabled',
    wrapIpc('profiles:setModEnabled', (_e, id: string, modId: string, enabled: boolean) =>
      setModEnabled(id, modId, enabled),
    ),
  )
  ipcMain.handle(
    'profiles:syncModsFromDisk',
    wrapIpc('profiles:syncModsFromDisk', (_e, id: string) => syncModsFromDisk(id)),
  )
  ipcMain.handle(
    'profiles:duplicate',
    wrapIpc('profiles:duplicate', (_e, id: string, newName?: string) =>
      duplicateProfile(id, newName),
    ),
  )
  ipcMain.handle(
    'profiles:setDirty',
    wrapIpc('profiles:setDirty', (_e, id: string, dirty: boolean) => setProfileDirty(id, dirty)),
  )
  ipcMain.handle(
    'profiles:addModules',
    wrapIpc('profiles:addModules', (_e, id: string, modules, enabled?: boolean) =>
      addModulesToProfile(id, modules, enabled),
    ),
  )
  ipcMain.handle(
    'profiles:activate',
    wrapIpc('profiles:activate', (e, id: string, options?: ActivateOptions) => {
      const sender = e.sender
      return activateProfile(id, options, (progress: ActivateProgressEvent) => {
        if (!sender.isDestroyed()) sender.send('activate:progress', progress)
      })
    }),
  )
  ipcMain.handle(
    'profiles:launch',
    wrapIpc('profiles:launch', async (_e, id: string) => {
      assertOperationAllowed('launch')
      const store = getStoreSnapshot()
      const profile = store.profiles.find((p) => p.id === id)
      if (!profile) throw new Error('Profile not found.')
      const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
      return launchProfile(profile, discovery.installPath)
    }),
  )
  ipcMain.handle(
    'activate:getLock',
    wrapIpc('activate:getLock', () => getActivateLock()),
  )
  ipcMain.handle(
    'paths:set',
    wrapIpc('paths:set', (_e, gameInstallPath: string | null, documentsPath: string | null) =>
      setPaths(gameInstallPath, documentsPath),
    ),
  )
  ipcMain.handle(
    'settings:setAllowSteamBetaKeyWrite',
    wrapIpc('settings:setAllowSteamBetaKeyWrite', (_e, allow: boolean) =>
      setAllowSteamBetaKeyWrite(allow),
    ),
  )
  ipcMain.handle(
    'discovery:get',
    wrapIpc('discovery:get', () => {
      const store = getStoreSnapshot()
      return discoverGame(store.gameInstallPath, store.documentsPath)
    }),
  )
  ipcMain.handle(
    'vault:list',
    wrapIpc('vault:list', () => listVaultModules()),
  )
  ipcMain.handle(
    'vault:importModules',
    wrapIpc('vault:importModules', () => {
      const store = getStoreSnapshot()
      const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
      if (!discovery.modulesPath) throw new Error('Modules path not found.')
      return importModulesIntoVault(discovery.modulesPath)
    }),
  )
  ipcMain.handle(
    'vault:path',
    wrapIpc('vault:path', () => getVaultPath()),
  )
  ipcMain.handle(
    'secrets:status',
    wrapIpc('secrets:status', () => getSecretsStatus()),
  )
  ipcMain.handle(
    'secrets:set',
    wrapIpc('secrets:set', (_e, patch: SecretsPatch) => setSecrets(patch)),
  )
  ipcMain.handle(
    'stores:search',
    wrapIpc('stores:search', async (_e, store: string, query: string) => {
      if (store === 'nexus') return searchNexus(query)
      if (store === 'steam') return searchSteamWorkshop(query)
      if (store === 'moddb') return searchModdb(query)
      throw new Error(`Unknown store: ${store}`)
    }),
  )
  ipcMain.handle(
    'stores:nexusValidate',
    wrapIpc('stores:nexusValidate', () => validateNexusKey()),
  )
  ipcMain.handle(
    'stores:nexusFiles',
    wrapIpc('stores:nexusFiles', (_e, modId: string) => listNexusFiles(modId)),
  )
  ipcMain.handle(
    'stores:nexusDownload',
    wrapIpc('stores:nexusDownload', async (_e, modId: string, fileId: string) => {
      const link = await getNexusDownloadLink(modId, fileId)
      if (!link.ok || !link.url) return link
      const imported = await downloadUrlToVault(link.url, `nexus-${modId}-${fileId}`)
      return { ...link, imported }
    }),
  )
  ipcMain.handle(
    'stores:steamOpen',
    wrapIpc('stores:steamOpen', (_e, id: string) => openSteamWorkshopItem(id)),
  )
  ipcMain.handle(
    'stores:workshopInfo',
    wrapIpc('stores:workshopInfo', () => getWorkshopPathInfo()),
  )
  ipcMain.handle(
    'stores:importWorkshop',
    wrapIpc('stores:importWorkshop', (_e, publishedFileId: string) => {
      const root = findWorkshopContentPath()
      if (!root) throw new Error('Workshop content folder not found.')
      return importWorkshopFolder(path.join(root, publishedFileId))
    }),
  )
  ipcMain.handle(
    'install:zip',
    wrapIpc('install:zip', async (_e, zipPath: string) => importZipToVault(zipPath)),
  )
  ipcMain.handle(
    'install:folder',
    wrapIpc('install:folder', async (_e, folderPath: string) => importFolderToVault(folderPath)),
  )
  ipcMain.handle(
    'dialog:pickDirectory',
    wrapIpc('dialog:pickDirectory', async (_e, title: string) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title,
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }),
  )
  ipcMain.handle(
    'dialog:pickZip',
    wrapIpc('dialog:pickZip', async () => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Select mod ZIP',
        properties: ['openFile'],
        filters: [{ name: 'ZIP archives', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }),
  )
  ipcMain.handle(
    'shell:openPath',
    wrapIpc('shell:openPath', async (_e, target: string) => shell.openPath(target)),
  )
  ipcMain.handle(
    'shell:showItem',
    wrapIpc('shell:showItem', (_e, target: string) => shell.showItemInFolder(target)),
  )
  ipcMain.handle(
    'shell:openExternal',
    wrapIpc('shell:openExternal', (_e, url: string) => shell.openExternal(url)),
  )
}

// Must run before ready so userData / app name stick.
migrateUserDataIfNeeded()

app.whenReady().then(() => {
  ensureAppDirs()
  registerIpc()
  buildAppMenu(getActivateLock())
  startSteamBusyMonitor(2500)
  subscribeActivateLock((lock) => {
    buildAppMenu(lock)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('activate:lock', lock)
    }
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivateOptions,
  ActivateProgressEvent,
  ActivateResult,
  AppStore,
  CreateProfileInput,
  GameDiscovery,
  LaunchResult,
  LoadOrderScanResult,
  ModProfile,
  SecretsStatus,
  SteamVersionOption,
  StoreSearchResponse,
} from './types'

export interface BannerlordApi {
  getStore: () => Promise<AppStore>
  listProfiles: () => Promise<ModProfile[]>
  createProfile: (input: CreateProfileInput) => Promise<ModProfile>
  renameProfile: (id: string, name: string) => Promise<ModProfile>
  deleteProfile: (id: string) => Promise<AppStore>
  setActiveProfile: (id: string | null) => Promise<AppStore>
  updateProfile: (
    id: string,
    patch: Partial<Pick<ModProfile, 'gameVersion' | 'steamBetaBranch' | 'mods' | 'settings'>>,
  ) => Promise<ModProfile>
  refreshProfileFromDisk: (id: string) => Promise<ModProfile>
  reorderMods: (
    id: string,
    orderedIds: string[],
    options?: { saveUndo?: boolean },
  ) => Promise<ModProfile>
  undoLoadOrder: (id: string) => Promise<ModProfile>
  scanLoadOrder: (id: string) => Promise<LoadOrderScanResult>
  listSteamVersions: () => Promise<{ options: SteamVersionOption[]; notes: string[] }>
  setModEnabled: (id: string, modId: string, enabled: boolean) => Promise<ModProfile>
  syncModsFromDisk: (id: string) => Promise<{ profile: ModProfile; added: number }>
  duplicateProfile: (id: string, newName?: string) => Promise<ModProfile>
  setDirty: (id: string, dirty: boolean) => Promise<ModProfile>
  addModules: (
    id: string,
    modules: Array<{
      folderName: string
      id: string
      name: string
      version: string
      source?: string
      sourceId?: string
    }>,
    enabled?: boolean,
  ) => Promise<ModProfile>
  activateProfile: (id: string, options?: ActivateOptions) => Promise<ActivateResult>
  onActivateProgress: (handler: (event: ActivateProgressEvent) => void) => () => void
  launchProfile: (id: string) => Promise<LaunchResult>
  setPaths: (gameInstallPath: string | null, documentsPath: string | null) => Promise<AppStore>
  setAllowSteamBetaKeyWrite: (allow: boolean) => Promise<AppStore>
  getDiscovery: () => Promise<GameDiscovery>
  listVault: () => Promise<string[]>
  importModulesToVault: () => Promise<{ imported: string[]; skipped: string[] }>
  getVaultPath: () => Promise<string>
  getSecretsStatus: () => Promise<SecretsStatus>
  setSecrets: (patch: Record<string, string | undefined>) => Promise<SecretsStatus>
  searchStore: (store: 'nexus' | 'steam' | 'moddb', query: string) => Promise<StoreSearchResponse>
  validateNexus: () => Promise<{ ok: boolean; name?: string; isPremium?: boolean; error?: string }>
  listNexusFiles: (
    modId: string,
  ) => Promise<{ ok: boolean; files: Array<{ id: number; name: string; version: string }>; error?: string }>
  downloadNexusFile: (
    modId: string,
    fileId: string,
  ) => Promise<{
    ok: boolean
    url?: string
    error?: string
    needsPremium?: boolean
    imported?: { ok: boolean; modules: unknown[]; error?: string }
  }>
  openSteamWorkshop: (id: string) => Promise<void>
  workshopInfo: () => Promise<{ path: string | null; note: string }>
  importWorkshop: (
    publishedFileId: string,
  ) => Promise<{ ok: boolean; modules: unknown[]; error?: string }>
  importZip: (zipPath: string) => Promise<{ ok: boolean; modules: unknown[]; error?: string }>
  importFolder: (folderPath: string) => Promise<{ ok: boolean; modules: unknown[]; error?: string }>
  pickDirectory: (title: string) => Promise<string | null>
  pickZip: () => Promise<string | null>
  openPath: (target: string) => Promise<string>
  showItemInFolder: (target: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  onUiCommand: (
    handler: (command: 'newProfile' | 'captureCurrent' | 'renameProfile') => void,
  ) => () => void
}

const api: BannerlordApi = {
  getStore: () => ipcRenderer.invoke('store:get'),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (input) => ipcRenderer.invoke('profiles:create', input),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  setActiveProfile: (id) => ipcRenderer.invoke('profiles:setActive', id),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  refreshProfileFromDisk: (id) => ipcRenderer.invoke('profiles:refreshFromDisk', id),
  reorderMods: (id, orderedIds, options) =>
    ipcRenderer.invoke('profiles:reorderMods', id, orderedIds, options),
  undoLoadOrder: (id) => ipcRenderer.invoke('profiles:undoLoadOrder', id),
  scanLoadOrder: (id) => ipcRenderer.invoke('profiles:scanLoadOrder', id),
  listSteamVersions: () => ipcRenderer.invoke('steam:listVersions'),
  setModEnabled: (id, modId, enabled) =>
    ipcRenderer.invoke('profiles:setModEnabled', id, modId, enabled),
  syncModsFromDisk: (id) => ipcRenderer.invoke('profiles:syncModsFromDisk', id),
  duplicateProfile: (id, newName) => ipcRenderer.invoke('profiles:duplicate', id, newName),
  setDirty: (id, dirty) => ipcRenderer.invoke('profiles:setDirty', id, dirty),
  addModules: (id, modules, enabled) =>
    ipcRenderer.invoke('profiles:addModules', id, modules, enabled),
  activateProfile: (id, options) => ipcRenderer.invoke('profiles:activate', id, options),
  onActivateProgress: (handler) => {
    const listener = (_event: unknown, data: ActivateProgressEvent) => {
      handler(data)
    }
    ipcRenderer.on('activate:progress', listener)
    return () => {
      ipcRenderer.removeListener('activate:progress', listener)
    }
  },
  launchProfile: (id) => ipcRenderer.invoke('profiles:launch', id),
  setPaths: (gameInstallPath, documentsPath) =>
    ipcRenderer.invoke('paths:set', gameInstallPath, documentsPath),
  setAllowSteamBetaKeyWrite: (allow) =>
    ipcRenderer.invoke('settings:setAllowSteamBetaKeyWrite', allow),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),
  listVault: () => ipcRenderer.invoke('vault:list'),
  importModulesToVault: () => ipcRenderer.invoke('vault:importModules'),
  getVaultPath: () => ipcRenderer.invoke('vault:path'),
  getSecretsStatus: () => ipcRenderer.invoke('secrets:status'),
  setSecrets: (patch) => ipcRenderer.invoke('secrets:set', patch),
  searchStore: (store, query) => ipcRenderer.invoke('stores:search', store, query),
  validateNexus: () => ipcRenderer.invoke('stores:nexusValidate'),
  listNexusFiles: (modId) => ipcRenderer.invoke('stores:nexusFiles', modId),
  downloadNexusFile: (modId, fileId) =>
    ipcRenderer.invoke('stores:nexusDownload', modId, fileId),
  openSteamWorkshop: (id) => ipcRenderer.invoke('stores:steamOpen', id),
  workshopInfo: () => ipcRenderer.invoke('stores:workshopInfo'),
  importWorkshop: (publishedFileId) =>
    ipcRenderer.invoke('stores:importWorkshop', publishedFileId),
  importZip: (zipPath) => ipcRenderer.invoke('install:zip', zipPath),
  importFolder: (folderPath) => ipcRenderer.invoke('install:folder', folderPath),
  pickDirectory: (title) => ipcRenderer.invoke('dialog:pickDirectory', title),
  pickZip: () => ipcRenderer.invoke('dialog:pickZip'),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:showItem', target),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onUiCommand: (handler) => {
    const onNew = () => handler('newProfile')
    const onCapture = () => handler('captureCurrent')
    const onRename = () => handler('renameProfile')
    ipcRenderer.on('ui:newProfile', onNew)
    ipcRenderer.on('ui:captureCurrent', onCapture)
    ipcRenderer.on('ui:renameProfile', onRename)
    return () => {
      ipcRenderer.removeListener('ui:newProfile', onNew)
      ipcRenderer.removeListener('ui:captureCurrent', onCapture)
      ipcRenderer.removeListener('ui:renameProfile', onRename)
    }
  },
}

contextBridge.exposeInMainWorld('bannerlord', api)

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivateResult,
  AppStore,
  CreateProfileInput,
  GameDiscovery,
  ModProfile,
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
  reorderMods: (id: string, orderedIds: string[]) => Promise<ModProfile>
  setModEnabled: (id: string, modId: string, enabled: boolean) => Promise<ModProfile>
  syncModsFromDisk: (id: string) => Promise<{ profile: ModProfile; added: number }>
  duplicateProfile: (id: string, newName?: string) => Promise<ModProfile>
  activateProfile: (id: string) => Promise<ActivateResult>
  setPaths: (gameInstallPath: string | null, documentsPath: string | null) => Promise<AppStore>
  getDiscovery: () => Promise<GameDiscovery>
  pickDirectory: (title: string) => Promise<string | null>
  openPath: (target: string) => Promise<string>
  showItemInFolder: (target: string) => Promise<void>
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
  reorderMods: (id, orderedIds) => ipcRenderer.invoke('profiles:reorderMods', id, orderedIds),
  setModEnabled: (id, modId, enabled) =>
    ipcRenderer.invoke('profiles:setModEnabled', id, modId, enabled),
  syncModsFromDisk: (id) => ipcRenderer.invoke('profiles:syncModsFromDisk', id),
  duplicateProfile: (id, newName) => ipcRenderer.invoke('profiles:duplicate', id, newName),
  activateProfile: (id) => ipcRenderer.invoke('profiles:activate', id),
  setPaths: (gameInstallPath, documentsPath) =>
    ipcRenderer.invoke('paths:set', gameInstallPath, documentsPath),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),
  pickDirectory: (title) => ipcRenderer.invoke('dialog:pickDirectory', title),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:showItem', target),
}

contextBridge.exposeInMainWorld('bannerlord', api)

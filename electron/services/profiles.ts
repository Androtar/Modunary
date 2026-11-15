import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppStore,
  CreateProfileInput,
  ModEntry,
  ModProfile,
  ProfileSettings,
} from '../types'
import { DEFAULT_PROFILE_SETTINGS, EMPTY_STORE } from '../types'
import { discoverGame, parseSubModuleXml } from './discovery'
import {
  modsFromLauncherData,
  readLauncherData,
} from './launcherData'
import {
  ensureAppDirs,
  getStorePath,
  getVaultPath,
  getVaultRoot,
  resolvePaths,
} from './paths'
import { setConfiguredVaultRoot } from './vaultConfig'
import { listVaultModules } from './vault'

function nowIso(): string {
  return new Date().toISOString()
}

function migrateProfile(raw: ModProfile): ModProfile {
  const settings = {
    ...DEFAULT_PROFILE_SETTINGS,
    ...(raw.settings || {}),
  } as ProfileSettings
  // Migrate old preferredLauncher 'official' → steam
  const preferred = String(settings.preferredLauncher)
  if (preferred === 'official') settings.preferredLauncher = 'steam'
  if (settings.requiresBlse == null) {
    settings.requiresBlse = settings.preferredLauncher === 'blse'
  }
  if (!settings.vaultDeployMode) settings.vaultDeployMode = 'junction'
  return {
    ...raw,
    steamBetaBranch: raw.steamBetaBranch ?? '',
    mods: Array.isArray(raw.mods) ? raw.mods : [],
    settings,
    dirty: Boolean(raw.dirty),
  }
}

function applyVaultRootFromStore(store: AppStore): void {
  setConfiguredVaultRoot(store.vaultPath)
}

function peekVaultPathFromDisk(): string | null {
  try {
    const storePath = getStorePath()
    if (!fs.existsSync(storePath)) return null
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<AppStore>
    if (typeof raw.vaultPath === 'string' && raw.vaultPath.trim()) return raw.vaultPath.trim()
  } catch {
    // ignore
  }
  return null
}

export function loadStore(): AppStore {
  // Apply vault root before ensureAppDirs so we don't recreate the old AppData vault.
  const peeked = peekVaultPathFromDisk()
  setConfiguredVaultRoot(peeked)
  if (!peeked) setConfiguredVaultRoot(getVaultRoot())
  ensureAppDirs()
  const storePath = getStorePath()
  if (!fs.existsSync(storePath)) {
    const store = { ...EMPTY_STORE }
    // Default vault to E:\Modunary when available (persisted so Settings shows it).
    store.vaultPath = getVaultRoot()
    applyVaultRootFromStore(store)
    saveStore(store)
    return store
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<AppStore>
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.map((p) => migrateProfile(p as ModProfile))
      : []
    const store: AppStore = {
      ...EMPTY_STORE,
      ...raw,
      version: 2,
      profiles,
      allowSteamBetaKeyWrite: raw.allowSteamBetaKeyWrite !== false,
      showNexusBrowserDuringCollection: raw.showNexusBrowserDuringCollection === true,
      collectionDownloadsPath:
        typeof raw.collectionDownloadsPath === 'string' && raw.collectionDownloadsPath.trim()
          ? raw.collectionDownloadsPath.trim()
          : null,
      vaultPath:
        typeof raw.vaultPath === 'string' && raw.vaultPath.trim()
          ? raw.vaultPath.trim()
          : null,
    }
    if (!store.vaultPath) {
      store.vaultPath = getVaultRoot()
    }
    applyVaultRootFromStore(store)
    return store
  } catch {
    const bak = `${storePath}.corrupt-${Date.now()}.json`
    fs.copyFileSync(storePath, bak)
    const store = { ...EMPTY_STORE }
    saveStore(store)
    return store
  }
}

export function saveStore(store: AppStore): void {
  ensureAppDirs()
  fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf8')
}

function captureModsFromDisk(store: AppStore): ModEntry[] {
  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  const byId = new Map(
    discovery.mods.map((m) => [m.id, m] as const),
  )
  if (discovery.launcherDataPath && fs.existsSync(discovery.launcherDataPath)) {
    const launcherMods = readLauncherData(discovery.launcherDataPath)
    const fromLauncher = modsFromLauncherData(launcherMods, byId)
    // Append discovered mods not present in launcher data (disabled by default).
    const present = new Set(fromLauncher.map((m) => m.id))
    let order = fromLauncher.length
    for (const m of discovery.mods) {
      if (present.has(m.id)) continue
      fromLauncher.push({
        id: m.id,
        folderName: m.folderName,
        name: m.name,
        version: m.version,
        enabled: false,
        order: order++,
      })
    }
    return fromLauncher
  }

  return discovery.mods.map((m, order) => ({
    id: m.id,
    folderName: m.folderName,
    name: m.name,
    version: m.version,
    enabled: ['Native', 'SandBoxCore', 'Sandbox', 'StoryMode', 'CustomBattle', 'BirthAndDeath'].includes(m.id),
    order,
  }))
}

export function listProfiles(): ModProfile[] {
  return loadStore().profiles.slice().sort((a, b) => a.name.localeCompare(b.name))
}

export function getStoreSnapshot(): AppStore {
  return loadStore()
}

export function setPaths(gameInstallPath: string | null, documentsPath: string | null): AppStore {
  const store = loadStore()
  if (gameInstallPath !== undefined) store.gameInstallPath = gameInstallPath
  if (documentsPath !== undefined) store.documentsPath = documentsPath
  // Validate quickly
  resolvePaths(store.gameInstallPath, store.documentsPath)
  saveStore(store)
  return store
}

export function createProfile(input: CreateProfileInput): ModProfile {
  const store = loadStore()
  const name = input.name.trim()
  if (!name) throw new Error('Profile name is required.')
  if (store.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`A profile named "${name}" already exists.`)
  }

  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  const mods = input.captureCurrent === false
    ? []
    : captureModsFromDisk(store)

  const enabledIds = new Set(mods.filter((m) => m.enabled).map((m) => m.id))
  const requiresBlse =
    discovery.blse.installed &&
    (enabledIds.has('Bannerlord.Harmony') || enabledIds.has('Bannerlord.ButterLib'))

  const capturing = input.captureCurrent !== false
  const profile: ModProfile = {
    id: randomUUID(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    gameVersion: capturing
      ? discovery.detectedGameVersion || input.gameVersion || 'unknown'
      : input.gameVersion || discovery.detectedGameVersion || 'unknown',
    steamBetaBranch: capturing
      ? discovery.steamBetaBranch || ''
      : input.steamBetaBranch ?? '',
    mods,
    settings: {
      ...DEFAULT_PROFILE_SETTINGS,
      requiresBlse: capturing ? requiresBlse : false,
      preferredLauncher: capturing && requiresBlse ? 'blse' : 'steam',
    },
    loadOrderUndo: null,
  }

  store.profiles.push(profile)
  if (!store.activeProfileId) store.activeProfileId = profile.id
  saveStore(store)
  return profile
}

export function renameProfile(id: string, name: string): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name is required.')
  if (store.profiles.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`A profile named "${trimmed}" already exists.`)
  }
  profile.name = trimmed
  profile.updatedAt = nowIso()
  saveStore(store)
  return profile
}

export function deleteProfile(id: string): AppStore {
  const store = loadStore()
  store.profiles = store.profiles.filter((p) => p.id !== id)
  if (store.activeProfileId === id) {
    store.activeProfileId = store.profiles[0]?.id ?? null
  }
  saveStore(store)
  return store
}

export function updateProfile(
  id: string,
  patch: Partial<
    Pick<ModProfile, 'gameVersion' | 'steamBetaBranch' | 'mods'> & {
      settings: Partial<ProfileSettings>
    }
  >,
): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')

  if (patch.gameVersion != null) profile.gameVersion = patch.gameVersion
  if (patch.steamBetaBranch != null) profile.steamBetaBranch = patch.steamBetaBranch
  if (patch.mods != null) profile.mods = patch.mods
  if (patch.settings != null) {
    profile.settings = { ...profile.settings, ...patch.settings }
  }
  profile.updatedAt = nowIso()
  // Settings/version saves from the UI are intentional persists — clear Unsaved.
  if (patch.gameVersion != null || patch.steamBetaBranch != null || patch.settings != null) {
    if (patch.mods == null) profile.dirty = false
  }
  saveStore(store)
  return profile
}

export function setActiveProfile(id: string | null): AppStore {
  const store = loadStore()
  if (id && !store.profiles.some((p) => p.id === id)) {
    throw new Error('Profile not found.')
  }
  store.activeProfileId = id
  saveStore(store)
  return store
}

export function refreshProfileFromDisk(id: string): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  profile.mods = captureModsFromDisk(store)
  profile.gameVersion = discovery.detectedGameVersion || profile.gameVersion
  profile.steamBetaBranch = discovery.steamBetaBranch ?? profile.steamBetaBranch
  profile.updatedAt = nowIso()
  saveStore(store)
  return profile
}

export function reorderMods(
  id: string,
  orderedIds: string[],
  options?: { saveUndo?: boolean },
): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  if (options?.saveUndo) {
    profile.loadOrderUndo = [...profile.mods]
      .sort((a, b) => a.order - b.order)
      .map((m) => m.id)
  }
  const byId = new Map(profile.mods.map((m) => [m.id, m]))
  const next: ModEntry[] = []
  orderedIds.forEach((modId, order) => {
    const mod = byId.get(modId)
    if (mod) {
      next.push({ ...mod, order })
      byId.delete(modId)
    }
  })
  // Keep any leftover mods at the end
  for (const leftover of byId.values()) {
    next.push({ ...leftover, order: next.length })
  }
  profile.mods = next
  profile.updatedAt = nowIso()
  profile.dirty = true
  saveStore(store)
  return profile
}

export function undoLoadOrder(id: string): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  if (!profile.loadOrderUndo?.length) {
    throw new Error('No load-order undo available for this profile.')
  }
  const previous = profile.loadOrderUndo
  profile.loadOrderUndo = null
  saveStore(store)
  return reorderMods(id, previous)
}

export function setModEnabled(id: string, modId: string, enabled: boolean): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  const mod = profile.mods.find((m) => m.id === modId)
  if (!mod) throw new Error('Mod not found in profile.')
  mod.enabled = enabled
  profile.updatedAt = nowIso()
  profile.dirty = true
  saveStore(store)
  return profile
}

/** Append Modules present on disk but missing from the profile (disabled). Refresh metadata for known mods. */
export function syncModsFromDisk(id: string): { profile: ModProfile; added: number } {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')

  const discovery = discoverGame(store.gameInstallPath, store.documentsPath)
  const byId = new Map(profile.mods.map((m) => [m.id, m]))
  let order = profile.mods.length
  let added = 0

  for (const disc of discovery.mods) {
    const existing = byId.get(disc.id)
    if (existing) {
      existing.folderName = disc.folderName
      existing.name = disc.name
      if (!existing.version || existing.version === 'unknown') {
        existing.version = disc.version
      }
      continue
    }
    profile.mods.push({
      id: disc.id,
      folderName: disc.folderName,
      name: disc.name,
      version: disc.version,
      enabled: false,
      order: order++,
    })
    added += 1
  }

  profile.updatedAt = nowIso()
  saveStore(store)
  return { profile, added }
}

export function addModulesToProfile(
  id: string,
  modules: Array<{ folderName: string; id: string; name: string; version: string; source?: ModEntry['source']; sourceId?: string }>,
  enabled = true,
): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  const byId = new Map(profile.mods.map((m) => [m.id, m]))
  let order = profile.mods.length
  for (const mod of modules) {
    const existing = byId.get(mod.id)
    if (existing) {
      existing.folderName = mod.folderName
      existing.name = mod.name
      existing.version = mod.version
      if (mod.source) existing.source = mod.source
      if (mod.sourceId) existing.sourceId = mod.sourceId
      continue
    }
    profile.mods.push({
      id: mod.id,
      folderName: mod.folderName,
      name: mod.name,
      version: mod.version,
      enabled,
      order: order++,
      source: mod.source,
      sourceId: mod.sourceId,
    })
  }
  profile.updatedAt = nowIso()
  profile.dirty = true
  saveStore(store)
  return profile
}

/** Add vault modules (SubModule.xml present) that are missing from the profile. */
export function addVaultModulesToProfile(id: string): { profile: ModProfile; added: number } {
  const folders = listVaultModules()
  const before = loadStore().profiles.find((p) => p.id === id)?.mods.length ?? 0
  const modules = folders.map((folderName) => {
    const sub = path.join(getVaultPath(), folderName, 'SubModule.xml')
    const meta = parseSubModuleXml(sub)
    return {
      folderName,
      id: meta?.id || folderName,
      name: meta?.name || folderName,
      version: meta?.version || 'unknown',
      source: 'local' as const,
    }
  })
  const profile = addModulesToProfile(id, modules, true)
  return { profile, added: Math.max(0, profile.mods.length - before) }
}

export function setProfileDirty(id: string, dirty: boolean): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  profile.dirty = dirty
  saveStore(store)
  return profile
}

export function setAllowSteamBetaKeyWrite(allow: boolean): AppStore {
  const store = loadStore()
  store.allowSteamBetaKeyWrite = allow
  saveStore(store)
  return store
}

export function setShowNexusBrowserDuringCollection(show: boolean): AppStore {
  const store = loadStore()
  store.showNexusBrowserDuringCollection = Boolean(show)
  saveStore(store)
  return store
}

export function setCollectionDownloadsPath(dir: string | null): AppStore {
  const store = loadStore()
  const trimmed = typeof dir === 'string' ? dir.trim() : ''
  store.collectionDownloadsPath = trimmed ? trimmed : null
  saveStore(store)
  return store
}

export function setVaultPath(dir: string | null): AppStore {
  const store = loadStore()
  const trimmed = typeof dir === 'string' ? dir.trim() : ''
  store.vaultPath = trimmed ? trimmed : getVaultRoot()
  applyVaultRootFromStore(store)
  ensureAppDirs()
  saveStore(store)
  return store
}

export function duplicateProfile(id: string, newName?: string): ModProfile {
  const store = loadStore()
  const source = store.profiles.find((p) => p.id === id)
  if (!source) throw new Error('Profile not found.')

  let name = (newName ?? `${source.name} copy`).trim()
  if (!name) name = `${source.name} copy`
  const existing = new Set(store.profiles.map((p) => p.name.toLowerCase()))
  if (existing.has(name.toLowerCase())) {
    let n = 2
    while (existing.has(`${name} ${n}`.toLowerCase())) n += 1
    name = `${name} ${n}`
  }

  const profile: ModProfile = {
    id: randomUUID(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    gameVersion: source.gameVersion,
    steamBetaBranch: source.steamBetaBranch,
    mods: source.mods.map((m) => ({ ...m })),
    settings: { ...source.settings },
  }
  store.profiles.push(profile)
  saveStore(store)
  return profile
}

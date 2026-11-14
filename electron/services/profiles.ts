import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  AppStore,
  CreateProfileInput,
  ModEntry,
  ModProfile,
  ProfileSettings,
} from '../types'
import { DEFAULT_PROFILE_SETTINGS, EMPTY_STORE } from '../types'
import { discoverGame } from './discovery'
import {
  modsFromLauncherData,
  readLauncherData,
} from './launcherData'
import { ensureAppDirs, getStorePath, resolvePaths } from './paths'

function nowIso(): string {
  return new Date().toISOString()
}

export function loadStore(): AppStore {
  ensureAppDirs()
  const storePath = getStorePath()
  if (!fs.existsSync(storePath)) {
    const store = { ...EMPTY_STORE }
    saveStore(store)
    return store
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as AppStore
    return {
      ...EMPTY_STORE,
      ...raw,
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    }
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

  const profile: ModProfile = {
    id: randomUUID(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    gameVersion: input.gameVersion || discovery.detectedGameVersion || 'unknown',
    steamBetaBranch: discovery.steamBetaBranch || '',
    mods,
    settings: { ...DEFAULT_PROFILE_SETTINGS },
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
  patch: Partial<Pick<ModProfile, 'gameVersion' | 'steamBetaBranch' | 'mods' | 'settings'>>,
): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')

  if (patch.gameVersion != null) profile.gameVersion = patch.gameVersion
  if (patch.steamBetaBranch != null) profile.steamBetaBranch = patch.steamBetaBranch
  if (patch.mods != null) profile.mods = patch.mods
  if (patch.settings != null) {
    profile.settings = { ...profile.settings, ...patch.settings } as ProfileSettings
  }
  profile.updatedAt = nowIso()
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

export function reorderMods(id: string, orderedIds: string[]): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
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
  saveStore(store)
  return profile
}

export function setModEnabled(id: string, modId: string, enabled: boolean): ModProfile {
  const store = loadStore()
  const profile = store.profiles.find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')
  const mod = profile.mods.find((m) => m.id === modId)
  if (!mod) throw new Error('Mod not found in profile.')
  mod.enabled = enabled
  profile.updatedAt = nowIso()
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

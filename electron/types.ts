export interface ModEntry {
  id: string
  folderName: string
  name: string
  version: string
  enabled: boolean
  order: number
}

export interface ProfileSettings {
  notes: string
  autoBackupLauncherData: boolean
  preferredLauncher: 'official' | 'blse' | 'steam'
}

export interface ModProfile {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  gameVersion: string
  /** Optional Steam beta branch name to request on activate (best-effort). */
  steamBetaBranch: string
  mods: ModEntry[]
  settings: ProfileSettings
}

export interface AppPaths {
  gameInstallPath: string | null
  modulesPath: string | null
  documentsPath: string | null
  launcherDataPath: string | null
  storePath: string
  backupsPath: string
}

export interface DiscoveredMod {
  id: string
  folderName: string
  name: string
  version: string
  path: string
}

export interface GameDiscovery {
  installPath: string | null
  modulesPath: string | null
  documentsPath: string | null
  launcherDataPath: string | null
  detectedGameVersion: string | null
  steamAppManifestPath: string | null
  steamBetaBranch: string | null
  mods: DiscoveredMod[]
  warnings: string[]
}

export interface AppStore {
  version: 1
  activeProfileId: string | null
  gameInstallPath: string | null
  documentsPath: string | null
  profiles: ModProfile[]
  lastActivatedAt: string | null
  lastActivationNotes: string[]
}

export interface ActivateResult {
  ok: boolean
  profileId: string
  backupPath: string | null
  launcherDataPath: string
  versionNotes: string[]
  warnings: string[]
}

export interface CreateProfileInput {
  name: string
  captureCurrent?: boolean
  gameVersion?: string
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  notes: '',
  autoBackupLauncherData: true,
  preferredLauncher: 'official',
}

export const EMPTY_STORE: AppStore = {
  version: 1,
  activeProfileId: null,
  gameInstallPath: null,
  documentsPath: null,
  profiles: [],
  lastActivatedAt: null,
  lastActivationNotes: [],
}

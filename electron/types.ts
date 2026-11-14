export interface ModEntry {
  id: string
  folderName: string
  name: string
  version: string
  enabled: boolean
  order: number
  /** Where the mod was sourced from when known. */
  source?: 'local' | 'nexus' | 'steam' | 'moddb' | 'manual'
  sourceId?: string
}

export interface ProfileSettings {
  notes: string
  autoBackupLauncherData: boolean
  /** If true, Launch button uses BLSE; otherwise Steam. */
  requiresBlse: boolean
  preferredLauncher: 'blse' | 'steam'
  /** Prefer directory junctions from vault (faster) vs full copy. */
  vaultDeployMode: 'junction' | 'copy'
}

export interface ModProfile {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  gameVersion: string
  /** Steam beta branch / BetaKey to request on activate (e.g. "v1.3.15"). */
  steamBetaBranch: string
  mods: ModEntry[]
  settings: ProfileSettings
  /** True when UI edits differ from last saved/activated snapshot (renderer-tracked, persisted lightly). */
  dirty?: boolean
  /** Previous mod id order for undoing a load-order scan. */
  loadOrderUndo?: string[] | null
}

export interface AppPaths {
  gameInstallPath: string | null
  modulesPath: string | null
  documentsPath: string | null
  launcherDataPath: string | null
  storePath: string
  backupsPath: string
  vaultPath: string
}

export interface DiscoveredMod {
  id: string
  folderName: string
  name: string
  version: string
  path: string
  official: boolean
}

export interface BlseInfo {
  installed: boolean
  launcherPath: string | null
  launcherExPath: string | null
  standalonePath: string | null
}

export interface GameDiscovery {
  installPath: string | null
  modulesPath: string | null
  documentsPath: string | null
  launcherDataPath: string | null
  detectedGameVersion: string | null
  steamAppManifestPath: string | null
  steamBetaBranch: string | null
  steamExePath: string | null
  blse: BlseInfo
  mods: DiscoveredMod[]
  warnings: string[]
}

export interface SecretsStatus {
  nexusApiKeySet: boolean
  steamWebApiKeySet: boolean
  moddbUsernameSet: boolean
  moddbPasswordSet: boolean
  nexusAppIdSet: boolean
  /** Paths / env hints for Stephen. */
  hooks: {
    secretsFile: string
    envNexus: string
    envSteam: string
    envModdbUser: string
    envModdbPass: string
    envNexusAppId: string
  }
}

export interface StoreSearchResult {
  store: 'nexus' | 'steam' | 'moddb'
  id: string
  name: string
  summary: string
  author?: string
  url: string
  downloads?: number
  imageUrl?: string
  /** Download possible in-app without browser. */
  canDownloadInApp: boolean
  note?: string
}

export interface StoreSearchResponse {
  ok: boolean
  results: StoreSearchResult[]
  error?: string
  needsKey?: boolean
  needsPremium?: boolean
  manualUrl?: string
}

export interface AppStore {
  version: 2
  activeProfileId: string | null
  gameInstallPath: string | null
  documentsPath: string | null
  profiles: ModProfile[]
  lastActivatedAt: string | null
  lastActivationNotes: string[]
  /** Opt-in: allow rewriting Steam appmanifest BetaKey when user confirms version switch. */
  allowSteamBetaKeyWrite: boolean
}

export interface ActivateOptions {
  /** User confirmed the version-switch modal (Continue). */
  confirmVersionSwitch?: boolean
  /** If current active profile is dirty, save it under this name before switching. */
  saveUnsavedAs?: string | null
  /** Attempt Steam BetaKey write after user Continue. */
  attemptSteamVersionSwitch?: boolean
}

export interface ActivateResult {
  ok: boolean
  profileId: string
  backupPath: string | null
  launcherDataPath: string
  versionNotes: string[]
  warnings: string[]
  vaultNotes: string[]
  /** True when caller must show the version-switch modal before proceeding. */
  needsVersionSwitchConfirm?: boolean
  requiredVersion?: string
  currentVersion?: string | null
  steamVersionSwitchAttempted?: boolean
  steamVersionSwitchOk?: boolean
}

export interface CreateProfileInput {
  name: string
  captureCurrent?: boolean
  gameVersion?: string
  steamBetaBranch?: string
}

export interface SteamVersionOption {
  label: string
  gameVersion: string
  steamBetaBranch: string
  source: 'current' | 'public' | 'manifest-history' | 'profile-history' | 'steamcmd' | 'known'
  note?: string
}

export interface LoadOrderScanResult {
  orderedIds: string[]
  warnings: string[]
  notes: string[]
}

export interface LaunchResult {
  ok: boolean
  mode: 'blse' | 'steam'
  command: string
  message: string
}

export const OFFICIAL_MODULE_IDS = [
  'Native',
  'SandBoxCore',
  'Sandbox',
  'StoryMode',
  'CustomBattle',
  'BirthAndDeath',
  'Multiplayer',
] as const

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  notes: '',
  autoBackupLauncherData: true,
  requiresBlse: false,
  preferredLauncher: 'steam',
  vaultDeployMode: 'junction',
}

export const EMPTY_STORE: AppStore = {
  version: 2,
  activeProfileId: null,
  gameInstallPath: null,
  documentsPath: null,
  profiles: [],
  lastActivatedAt: null,
  lastActivationNotes: [],
  allowSteamBetaKeyWrite: true,
}

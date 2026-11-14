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

export type CollectionInstallItemStatus =
  | 'pending'
  | 'downloading'
  | 'waiting-user'
  | 'importing'
  | 'done'
  | 'skipped'
  | 'error'

export interface CollectionInstallItem {
  modId: number
  fileId: number
  name: string
  version: string
  optional: boolean
  status: CollectionInstallItemStatus
  message: string
  error: string | null
  method: 'premium' | 'slow-download' | null
}

export type CollectionInstallStage =
  | 'idle'
  | 'resolving'
  | 'installing'
  | 'waiting-download'
  | 'paused'
  | 'done'
  | 'cancelled'

export interface CollectionInstallProgress {
  active: boolean
  stage: CollectionInstallStage
  collectionName: string | null
  collectionUrl: string | null
  profileId: string | null
  total: number
  completed: number
  index: number
  currentModId: string | null
  currentModName: string | null
  message: string
  items: CollectionInstallItem[]
  downloadsPath: string | null
  error: string | null
}

export interface NexusCollectionModDto {
  modId: number
  fileId: number
  name: string
  version: string
  optional: boolean
  author?: string
  url: string
}

export interface NexusCollectionInfoDto {
  slug: string
  domain: string
  name: string
  revision: number
  summary?: string
  url: string
  mods: NexusCollectionModDto[]
  source: 'graphql' | 'scrape'
  notes: string[]
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

export type ActivateProgressPhase =
  | 'saving'
  | 'installing-version'
  | 'waiting-steam'
  | 'activating-mods'
  | 'writing-launcher'
  | 'done'
  | 'error'

export interface ActivateProgressEvent {
  phase: ActivateProgressPhase
  message: string
}

/**
 * Global operation block: true when Modunary Activate is running OR Steam is
 * installing/validating/updating Bannerlord (app 261550). Survives modal close.
 */
export interface ActivateLockState {
  /** @deprecated use `blocked` — kept as alias for older UI checks */
  active: boolean
  blocked: boolean
  source: 'none' | 'activate' | 'steam' | 'both'
  profileId: string | null
  profileName: string | null
  phase: ActivateProgressPhase | null
  message: string | null
  startedAt: string | null
  steamUpdatePending: boolean
  activateInProgress: boolean
  steamBusy: boolean
  steamDetail: string | null
  /** Hover / menu explanation when blocked. */
  tooltip: string | null
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
  /** Primary UI label — always leads with a concrete version, e.g. "1.5.7 (Public)". */
  label: string
  gameVersion: string
  steamBetaBranch: string
  source: 'current' | 'public' | 'manifest-history' | 'profile-history' | 'steamcmd' | 'known'
  note?: string
  /** ISO timestamp when known (from steamcmd timeupdated or curated dates). */
  releasedAt?: string
  /** Secondary line under the primary label in the picker. */
  secondaryLabel?: string
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

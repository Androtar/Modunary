import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ActivateLockState,
  ActivateProgressEvent,
  ActivateProgressPhase,
  ActivateResult,
  AppStore,
  GameDiscovery,
  ModProfile,
  SecretsStatus,
  SteamVersionOption,
  StoreSearchResult,
} from '../electron/types'
import { EMPTY_STORE } from '../electron/types'
import './App.css'

const logoUrl = '/modunary-logo.png'

type Tab = 'mods' | 'stores' | 'settings' | 'about'
type StoreKind = 'nexus' | 'steam' | 'moddb'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export default function App() {
  const [store, setStore] = useState<AppStore | null>(null)
  const [discovery, setDiscovery] = useState<GameDiscovery | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('mods')
  const [busy, setBusy] = useState(false)
  const [activateLock, setActivateLock] = useState<ActivateLockState | null>(null)
  const activateLaunchBlocked = Boolean(activateLock?.blocked)
  const activateLaunchTip =
    activateLock?.tooltip ||
    (activateLaunchBlocked
      ? 'Steam is installing/validating/updating Bannerlord (or Modunary activate in progress)'
      : undefined)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(
    null,
  )
  const [filter, setFilter] = useState('')
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null)
  const [vaultCount, setVaultCount] = useState(0)

  // Version switch modal
  const [versionModal, setVersionModal] = useState<{
    profileId: string
    requiredVersion: string
    currentVersion: string | null
    stage: 'confirm' | 'progress' | 'done' | 'error'
    progressPhase: ActivateProgressPhase | null
    progressMessage: string
    error: string | null
    summary: string | null
  } | null>(null)
  const [saveAsName, setSaveAsName] = useState('')

  // Stores tab
  const [storeKind, setStoreKind] = useState<StoreKind>('nexus')
  const [storeQuery, setStoreQuery] = useState('')
  const [storeResults, setStoreResults] = useState<StoreSearchResult[]>([])
  const [storeError, setStoreError] = useState<string | null>(null)
  const [storeManualUrl, setStoreManualUrl] = useState<string | null>(null)

  // Electron does not support window.prompt / window.confirm — use in-app modals.
  const [nameModal, setNameModal] = useState<{
    mode: 'create' | 'rename'
    value: string
    captureCurrent: boolean
    gameVersion: string
    steamBetaBranch: string
  } | null>(null)
  const [steamVersions, setSteamVersions] = useState<SteamVersionOption[]>([])
  const [steamVersionNotes, setSteamVersionNotes] = useState<string[]>([])
  const [confirmModal, setConfirmModal] = useState<{
    mode: 'delete' | 'capture'
    title: string
    body: string
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!window.bannerlord) {
      throw new Error(
        'Preload API missing (window.bannerlord). The Electron preload script failed — restart npm run dev.',
      )
    }

    // Load store first so the shell becomes usable even if discovery is slow/fails.
    const nextStore = await withTimeout(window.bannerlord.getStore(), 15000, 'getStore')
    setStore(nextStore)
    setSelectedId((prev) => {
      if (prev && nextStore.profiles.some((p) => p.id === prev)) return prev
      return nextStore.activeProfileId ?? nextStore.profiles[0]?.id ?? null
    })

    const secondary = await Promise.allSettled([
      withTimeout(window.bannerlord.getDiscovery(), 30000, 'getDiscovery'),
      withTimeout(window.bannerlord.getSecretsStatus(), 10000, 'getSecretsStatus'),
      withTimeout(window.bannerlord.listVault(), 10000, 'listVault'),
    ])

    const warnings: string[] = []
    if (secondary[0].status === 'fulfilled') setDiscovery(secondary[0].value)
    else warnings.push(`Discovery: ${secondary[0].reason}`)
    if (secondary[1].status === 'fulfilled') setSecrets(secondary[1].value)
    else warnings.push(`Secrets: ${secondary[1].reason}`)
    if (secondary[2].status === 'fulfilled') setVaultCount(secondary[2].value.length)
    else warnings.push(`Vault: ${secondary[2].reason}`)

    if (warnings.length) {
      setMessage({
        kind: 'warn',
        text: `App loaded with warnings:\n${warnings.join('\n')}`,
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setBooting(true)
    setBootError(null)
    refresh()
      .catch((err: unknown) => {
        if (cancelled) return
        const text = err instanceof Error ? err.message : String(err)
        setBootError(text)
        setMessage({ kind: 'error', text })
        // Fall back to an empty in-memory store so create actions can still render.
        // IPC create will still require a working preload.
        setStore((prev) => prev ?? { ...EMPTY_STORE })
      })
      .finally(() => {
        if (!cancelled) setBooting(false)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  const selected = useMemo(
    () => store?.profiles.find((p) => p.id === selectedId) ?? null,
    [store, selectedId],
  )

  const activeProfile = useMemo(
    () => store?.profiles.find((p) => p.id === store.activeProfileId) ?? null,
    [store],
  )

  const filteredMods = useMemo(() => {
    if (!selected) return []
    const q = filter.trim().toLowerCase()
    const mods = [...selected.mods].sort((a, b) => a.order - b.order)
    if (!q) return mods
    return mods.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.folderName.toLowerCase().includes(q),
    )
  }, [selected, filter])

  const launchLabel =
    selected?.settings.requiresBlse || selected?.settings.preferredLauncher === 'blse'
      ? 'Launch via BLSE'
      : 'Launch via Steam'

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  function summarizeActivate(result: ActivateResult, name: string) {
    const lines = [
      `Activated "${name}".`,
      `Wrote: ${result.launcherDataPath}`,
      result.backupPath ? `Backup: ${result.backupPath}` : null,
      ...result.versionNotes,
      ...result.vaultNotes,
      ...result.warnings,
    ].filter(Boolean)
    setMessage({
      kind: result.warnings.length ? 'warn' : 'ok',
      text: lines.join('\n'),
    })
  }

  async function runActivate(
    profileId: string,
    options?: {
      confirmVersionSwitch?: boolean
      saveUnsavedAs?: string | null
      attemptSteamVersionSwitch?: boolean
    },
  ) {
    const profile = store?.profiles.find((p) => p.id === profileId)
    if (!profile) return
    const result = await window.bannerlord.activateProfile(profileId, options)
    if (result.needsVersionSwitchConfirm) {
      setVersionModal({
        profileId,
        requiredVersion: result.requiredVersion || profile.gameVersion,
        currentVersion: result.currentVersion ?? null,
        stage: 'confirm',
        progressPhase: null,
        progressMessage: '',
        error: null,
        summary: null,
      })
      setSaveAsName('')
      return
    }
    setVersionModal(null)
    await refresh()
    summarizeActivate(result, profile.name)
  }

  async function onActivate() {
    if (!selected) return
    if (activateLaunchBlocked) {
      setMessage({
        kind: 'warn',
        text: activateLaunchTip || 'Activate blocked while Steam/Modunary is busy.',
      })
      return
    }
    await withBusy(async () => {
      await runActivate(selected.id)
    })
  }

  async function onVersionContinue() {
    if (!versionModal || !store || versionModal.stage !== 'confirm') return
    const current = store.profiles.find((p) => p.id === store.activeProfileId)
    const needsSave =
      current &&
      current.id !== versionModal.profileId &&
      (current.dirty || false)

    let saveUnsavedAs: string | null = null
    if (needsSave) {
      const name = saveAsName.trim()
      if (!name) {
        setMessage({
          kind: 'warn',
          text: 'Current profile has unsaved changes. Enter a name to save them as a separate profile, or clear dirty state first.',
        })
        return
      }
      saveUnsavedAs = name
    }

    const profile = store.profiles.find((p) => p.id === versionModal.profileId)
    const profileId = versionModal.profileId
    const requiredVersion = versionModal.requiredVersion

    // Immediately leave confirm UI — no Cancel mid-flight.
    setVersionModal({
      profileId,
      requiredVersion,
      currentVersion: versionModal.currentVersion,
      stage: 'progress',
      progressPhase: saveUnsavedAs ? 'saving' : 'installing-version',
      progressMessage: saveUnsavedAs
        ? 'Saving current profile…'
        : `Installing version ${requiredVersion.replace(/^v/i, '')}…`,
      error: null,
      summary: null,
    })
    setBusy(true)
    setMessage(null)

    const unsub = window.bannerlord.onActivateProgress((ev: ActivateProgressEvent) => {
      setVersionModal((prev) =>
        prev && (prev.stage === 'progress' || prev.stage === 'confirm')
          ? {
              ...prev,
              stage: 'progress',
              progressPhase: ev.phase === 'done' || ev.phase === 'error' ? prev.progressPhase : ev.phase,
              progressMessage: ev.message,
            }
          : prev,
      )
    })

    try {
      const result = await window.bannerlord.activateProfile(profileId, {
        confirmVersionSwitch: true,
        saveUnsavedAs,
        attemptSteamVersionSwitch: true,
      })
      await refresh()
      const lines = [
        profile ? `Activated "${profile.name}".` : 'Activated profile.',
        `Wrote: ${result.launcherDataPath}`,
        result.backupPath ? `Backup: ${result.backupPath}` : null,
        ...result.versionNotes,
        ...result.vaultNotes,
        ...result.warnings,
      ].filter(Boolean)
      const summary = lines.join('\n')
      setVersionModal({
        profileId,
        requiredVersion,
        currentVersion: versionModal.currentVersion,
        stage: 'done',
        progressPhase: 'done',
        progressMessage: 'Done',
        error: null,
        summary,
      })
      setMessage({
        kind: result.warnings.length ? 'warn' : 'ok',
        text: summary,
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setVersionModal((prev) => ({
        profileId,
        requiredVersion,
        currentVersion: versionModal.currentVersion,
        stage: 'error',
        progressPhase:
          prev?.progressPhase && prev.progressPhase !== 'done' && prev.progressPhase !== 'error'
            ? prev.progressPhase
            : 'installing-version',
        progressMessage: 'Failed',
        error: text,
        summary: null,
      }))
      setMessage({ kind: 'error', text })
    } finally {
      unsub()
      setBusy(false)
    }
  }

  function onVersionCancel() {
    if (versionModal && versionModal.stage !== 'confirm') return
    setVersionModal(null)
    setMessage({
      kind: 'ok',
      text: 'Version switch cancelled. Nothing was changed.',
    })
  }

  function onVersionClose() {
    setVersionModal(null)
  }

  async function onLaunch() {
    if (!selected) return
    if (activateLaunchBlocked) {
      setMessage({
        kind: 'warn',
        text: activateLaunchTip || 'Launch blocked while Steam/Modunary is busy.',
      })
      return
    }
    await withBusy(async () => {
      // Ensure activated first if not active
      if (store?.activeProfileId !== selected.id) {
        setMessage({
          kind: 'warn',
          text: 'Activate this profile before launching so vault + load order match.',
        })
        return
      }
      const result = await window.bannerlord.launchProfile(selected.id)
      setMessage({
        kind: result.ok ? 'ok' : 'error',
        text: result.message,
      })
    })
  }

  function defaultNewProfileName(): string {
    const n = (store?.profiles.length ?? 0) + 1
    return `Profile ${n}`
  }

  async function openCreateModal() {
    if (!window.bannerlord) {
      setMessage({
        kind: 'error',
        text: 'Cannot create profile — preload API is unavailable. Restart the app.',
      })
      return
    }
    let versions: SteamVersionOption[] = []
    let notes: string[] = []
    try {
      const listed = await window.bannerlord.listSteamVersions()
      versions = listed.options
      notes = listed.notes
      setSteamVersions(versions)
      setSteamVersionNotes(notes)
    } catch (err) {
      setMessage({
        kind: 'warn',
        text: `Could not list Steam versions: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    const current = versions.find((v) => v.source === 'current')
    setNameModal({
      mode: 'create',
      value: defaultNewProfileName(),
      captureCurrent: true,
      gameVersion: current?.gameVersion || discovery?.detectedGameVersion || '',
      steamBetaBranch: current?.steamBetaBranch || discovery?.steamBetaBranch || '',
    })
  }

  async function submitNameModal() {
    if (!nameModal) return
    const name = nameModal.value.trim() || defaultNewProfileName()
    if (nameModal.mode === 'create') {
      const captureCurrent = nameModal.captureCurrent
      const gameVersion = nameModal.gameVersion
      const steamBetaBranch = nameModal.steamBetaBranch
      if (!captureCurrent && !String(gameVersion).trim()) {
        setMessage({ kind: 'warn', text: 'Pick a Bannerlord / Steam version for the new profile.' })
        return
      }
      setNameModal(null)
      await withBusy(async () => {
        const profile = await window.bannerlord.createProfile({
          name,
          captureCurrent,
          gameVersion: captureCurrent ? undefined : gameVersion.trim() || 'unknown',
          steamBetaBranch: captureCurrent ? undefined : steamBetaBranch,
        })
        await refresh()
        setSelectedId(profile.id)
        setBootError(null)
        setMessage({
          kind: 'ok',
          text: captureCurrent
            ? `Created "${profile.name}" from current LauncherData / Modules (${profile.mods.length} mods).`
            : `Created "${profile.name}" targeting ${profile.gameVersion}${profile.steamBetaBranch ? ` / ${profile.steamBetaBranch}` : ' (public)'} (empty mod list).`,
        })
      })
      return
    }
    if (!selected) {
      setNameModal(null)
      return
    }
    if (name === selected.name) {
      setNameModal(null)
      return
    }
    setNameModal(null)
    await withBusy(async () => {
      await window.bannerlord.renameProfile(selected.id, name)
      await refresh()
      setMessage({ kind: 'ok', text: `Renamed to "${name}".` })
    })
  }

  function onCreate() {
    void openCreateModal()
  }

  function onRename() {
    if (!selected) return
    setNameModal({
      mode: 'rename',
      value: selected.name,
      captureCurrent: false,
      gameVersion: selected.gameVersion,
      steamBetaBranch: selected.steamBetaBranch,
    })
  }

  async function onScanLoadOrder() {
    if (!selected) return
    await withBusy(async () => {
      const scan = await window.bannerlord.scanLoadOrder(selected.id)
      await window.bannerlord.reorderMods(selected.id, scan.orderedIds, { saveUndo: true })
      await refresh()
      setMessage({
        kind: scan.warnings.length ? 'warn' : 'ok',
        text: [
          'Applied dependency load order.',
          ...scan.notes,
          ...scan.warnings,
          'Use “Undo load order” to restore the previous order.',
        ].join('\n'),
      })
    })
  }

  async function onUndoLoadOrder() {
    if (!selected) return
    await withBusy(async () => {
      await window.bannerlord.undoLoadOrder(selected.id)
      await refresh()
      setMessage({ kind: 'ok', text: 'Restored previous load order.' })
    })
  }

  function onDelete() {
    if (!selected) return
    setConfirmModal({
      mode: 'delete',
      title: 'Delete profile',
      body: `Delete profile "${selected.name}"? This cannot be undone.`,
    })
  }

  function onRefreshFromDisk() {
    if (!selected) {
      void openCreateModal()
      setMessage({
        kind: 'warn',
        text: 'No profile selected — create one from current Modules/LauncherData.',
      })
      return
    }
    setConfirmModal({
      mode: 'capture',
      title: 'Capture current Modules',
      body: `Replace "${selected.name}" mods/order/enabled with the current LauncherData + Modules snapshot?`,
    })
  }

  async function submitConfirmModal() {
    if (!confirmModal) return
    const mode = confirmModal.mode
    setConfirmModal(null)
    if (mode === 'delete') {
      if (!selected) return
      const deletedName = selected.name
      await withBusy(async () => {
        await window.bannerlord.deleteProfile(selected.id)
        await refresh()
        setMessage({ kind: 'ok', text: `Deleted "${deletedName}".` })
      })
      return
    }
    if (mode === 'capture') {
      if (!selected) return
      await withBusy(async () => {
        await window.bannerlord.refreshProfileFromDisk(selected.id)
        await refresh()
        setMessage({
          kind: 'ok',
          text: 'Pulled current LauncherData + Modules into this profile.',
        })
      })
    }
  }

  async function onSyncMods() {
    if (!selected) return
    await withBusy(async () => {
      const { added } = await window.bannerlord.syncModsFromDisk(selected.id)
      await refresh()
      setMessage({
        kind: 'ok',
        text:
          added > 0
            ? `Synced Modules: added ${added} mod(s) (disabled). Existing order/enabled kept.`
            : 'Synced Modules: no new mods on disk; metadata refreshed.',
      })
    })
  }

  async function onDuplicate() {
    if (!selected) return
    await withBusy(async () => {
      const profile = await window.bannerlord.duplicateProfile(selected.id)
      await refresh()
      setSelectedId(profile.id)
      setMessage({ kind: 'ok', text: `Duplicated as "${profile.name}".` })
    })
  }

  async function onToggleMod(modId: string, enabled: boolean) {
    if (!selected) return
    await withBusy(async () => {
      await window.bannerlord.setModEnabled(selected.id, modId, enabled)
      await refresh()
    })
  }

  async function moveMod(modId: string, direction: -1 | 1) {
    if (!selected) return
    const ordered = [...selected.mods].sort((a, b) => a.order - b.order)
    const index = ordered.findIndex((m) => m.id === modId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ordered.length) return
    const next = ordered.map((m) => m.id)
    ;[next[index], next[target]] = [next[target], next[index]]
    await withBusy(async () => {
      await window.bannerlord.reorderMods(selected.id, next)
      await refresh()
    })
  }

  async function saveProfileFields(patch: Partial<ModProfile>) {
    if (!selected) return
    await withBusy(async () => {
      await window.bannerlord.updateProfile(selected.id, {
        gameVersion: patch.gameVersion,
        steamBetaBranch: patch.steamBetaBranch,
        settings: patch.settings,
      })
      await refresh()
      setMessage({ kind: 'ok', text: 'Profile saved.' })
    })
  }

  async function pickGamePath() {
    const dir = await window.bannerlord.pickDirectory('Select Bannerlord install folder')
    if (!dir) return
    await withBusy(async () => {
      await window.bannerlord.setPaths(dir, store?.documentsPath ?? null)
      await refresh()
    })
  }

  async function pickDocsPath() {
    const dir = await window.bannerlord.pickDirectory('Select Bannerlord Documents folder')
    if (!dir) return
    await withBusy(async () => {
      await window.bannerlord.setPaths(store?.gameInstallPath ?? null, dir)
      await refresh()
    })
  }

  async function clearGamePath() {
    await withBusy(async () => {
      await window.bannerlord.setPaths(null, store?.documentsPath ?? null)
      await refresh()
    })
  }

  async function onSearchStore() {
    await withBusy(async () => {
      const res = await window.bannerlord.searchStore(storeKind, storeQuery)
      setStoreResults(res.results)
      setStoreError(res.error || null)
      setStoreManualUrl(res.manualUrl || null)
      if (!res.ok && res.needsKey) {
        setMessage({ kind: 'warn', text: res.error || 'API key required.' })
      }
    })
  }

  async function addImportedToProfile(
    modules: Array<{ folderName: string; id: string; name: string; version: string }>,
    source: 'nexus' | 'steam' | 'moddb' | 'manual',
    sourceId?: string,
  ) {
    if (!selected || modules.length === 0) return
    await window.bannerlord.addModules(
      selected.id,
      modules.map((m) => ({ ...m, source, sourceId })),
      true,
    )
    await refresh()
  }

  async function onImportZip() {
    const zip = await window.bannerlord.pickZip()
    if (!zip) return
    await withBusy(async () => {
      const res = await window.bannerlord.importZip(zip)
      if (!res.ok) throw new Error(res.error || 'Import failed')
      await addImportedToProfile(
        res.modules as Array<{ folderName: string; id: string; name: string; version: string }>,
        'manual',
      )
      setMessage({
        kind: 'ok',
        text: `Imported ${(res.modules as unknown[]).length} module(s) into vault and profile.`,
      })
    })
  }

  async function onImportFolder() {
    const dir = await window.bannerlord.pickDirectory('Select module folder')
    if (!dir) return
    await withBusy(async () => {
      const res = await window.bannerlord.importFolder(dir)
      if (!res.ok) throw new Error(res.error || 'Import failed')
      await addImportedToProfile(
        res.modules as Array<{ folderName: string; id: string; name: string; version: string }>,
        'manual',
      )
      setMessage({
        kind: 'ok',
        text: `Imported ${(res.modules as unknown[]).length} module(s) into vault and profile.`,
      })
    })
  }

  async function onImportModulesToVault() {
    await withBusy(async () => {
      const res = await window.bannerlord.importModulesToVault()
      await refresh()
      setMessage({
        kind: 'ok',
        text: `Vaulted ${res.imported.length} module folder(s) from Modules (official skipped: ${res.skipped.length}).`,
      })
    })
  }

  useEffect(() => {
    if (!window.bannerlord?.onActivateLock) return
    return window.bannerlord.onActivateLock((state) => setActivateLock(state))
  }, [])

  useEffect(() => {
    if (!window.bannerlord?.onUiCommand) return
    return window.bannerlord.onUiCommand((command) => {
      if (command === 'newProfile') void openCreateModal()
      if (command === 'captureCurrent') onRefreshFromDisk()
      if (command === 'renameProfile') onRename()
      if (command === 'activateProfile') void onActivate()
      if (command === 'launchProfile') void onLaunch()
    })
    // Rebind when selection/lock changes so menu actions use current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, store?.profiles.length, activateLaunchBlocked, activateLock?.message])

  const nameAndConfirmModals = (
    <>
      {nameModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{nameModal.mode === 'create' ? 'New Profile' : 'Rename profile'}</h2>
            <p className="sub">
              {nameModal.mode === 'create'
                ? 'Name this loadout. Capture uses the current install version; uncheck Capture to pick a Steam Bannerlord version.'
                : 'Choose a new name for this profile.'}
            </p>
            <div className="field" style={{ margin: '0.75rem 0' }}>
              <label htmlFor="profileNameBoot">Profile name</label>
              <input
                id="profileNameBoot"
                autoFocus
                value={nameModal.value}
                onChange={(e) => setNameModal({ ...nameModal, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitNameModal()
                  if (e.key === 'Escape') setNameModal(null)
                }}
                placeholder="Profile name"
              />
            </div>
            {nameModal.mode === 'create' && (
              <>
                <label className="check-row" style={{ paddingTop: 0, marginBottom: '0.9rem' }}>
                  <input
                    type="checkbox"
                    checked={nameModal.captureCurrent}
                    onChange={(e) => {
                      const captureCurrent = e.target.checked
                      if (captureCurrent) {
                        setNameModal({ ...nameModal, captureCurrent })
                        return
                      }
                      const match =
                        steamVersions.find(
                          (v) =>
                            v.steamBetaBranch === nameModal.steamBetaBranch &&
                            v.gameVersion === nameModal.gameVersion,
                        ) || steamVersions[0]
                      setNameModal({
                        ...nameModal,
                        captureCurrent,
                        gameVersion: match?.gameVersion || nameModal.gameVersion || '1.5.7',
                        steamBetaBranch: match?.steamBetaBranch ?? nameModal.steamBetaBranch,
                      })
                    }}
                  />
                  Capture current Modules / LauncherData
                </label>
                {!nameModal.captureCurrent && (
                  <div className="field version-picker-field" style={{ marginBottom: '0.9rem' }}>
                    <label id="steamVersionPickLabel">Bannerlord / Steam version</label>
                    <div
                      className="version-picker"
                      role="radiogroup"
                      aria-labelledby="steamVersionPickLabel"
                    >
                      {steamVersions.length === 0 && (
                        <label className="version-option">
                          <input
                            type="radio"
                            name="steamVersionPick"
                            checked={
                              nameModal.steamBetaBranch === '' &&
                              (nameModal.gameVersion === 'public' || !nameModal.gameVersion)
                            }
                            onChange={() =>
                              setNameModal({
                                ...nameModal,
                                steamBetaBranch: '',
                                gameVersion: 'public',
                              })
                            }
                          />
                          <span className="version-option-text">
                            <span className="version-option-label">public (Public)</span>
                            <span className="version-option-sub">Steam live branch</span>
                          </span>
                        </label>
                      )}
                      {steamVersions.map((opt) => {
                        const selected =
                          nameModal.steamBetaBranch === opt.steamBetaBranch &&
                          nameModal.gameVersion === opt.gameVersion
                        const dateLabel = opt.releasedAt
                          ? new Date(
                              opt.releasedAt.includes('T')
                                ? opt.releasedAt
                                : `${opt.releasedAt}T12:00:00Z`,
                            ).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              timeZone: 'UTC',
                            })
                          : null
                        return (
                          <label
                            key={`${opt.source}-${opt.steamBetaBranch}-${opt.gameVersion}-${opt.label}`}
                            className={`version-option ${selected ? 'selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="steamVersionPick"
                              checked={selected}
                              onChange={() =>
                                setNameModal({
                                  ...nameModal,
                                  steamBetaBranch: opt.steamBetaBranch,
                                  gameVersion: opt.gameVersion,
                                })
                              }
                            />
                            <span className="version-option-text">
                              <span className="version-option-label">{opt.label}</span>
                              <span className="version-option-sub">
                                {opt.secondaryLabel || opt.note || opt.source}
                              </span>
                            </span>
                            {dateLabel ? (
                              <span className="version-option-date">{dateLabel}</span>
                            ) : null}
                          </label>
                        )
                      })}
                    </div>
                    <p className="sub" style={{ marginTop: '0.45rem' }}>
                      Newest first. Persists as gameVersion / steamBetaBranch.
                      {steamVersionNotes[0] ? ` ${steamVersionNotes[0]}` : ''}
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="toolbar-group">
              <button className="btn primary" disabled={busy} onClick={() => void submitNameModal()}>
                {nameModal.mode === 'create' ? 'Create' : 'Rename'}
              </button>
              <button className="btn" disabled={busy} onClick={() => setNameModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{confirmModal.title}</h2>
            <p>{confirmModal.body}</p>
            <div className="toolbar-group" style={{ marginTop: '0.9rem' }}>
              <button
                className={`btn ${confirmModal.mode === 'delete' ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={() => void submitConfirmModal()}
              >
                {confirmModal.mode === 'delete' ? 'Delete' : 'Capture'}
              </button>
              <button className="btn" disabled={busy} onClick={() => setConfirmModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (booting && !store) {
    return (
      <>
        <div className="boot-shell">
          <div className="brand">
            <div className="brand-row">
              <img className="brand-logo" src={logoUrl} alt="" />
              <div>
                <h1>Modunary</h1>
                <p>Starting…</p>
              </div>
            </div>
          </div>
          <div className="empty">Loading Modunary…</div>
          <button className="btn primary" disabled={busy} onClick={() => void openCreateModal()}>
            New Profile
          </button>
          <button
            className="btn"
            onClick={() => {
              setBooting(true)
              setBootError(null)
              void refresh()
                .catch((err: unknown) => {
                  setBootError(err instanceof Error ? err.message : String(err))
                  setStore((prev) => prev ?? { ...EMPTY_STORE })
                })
                .finally(() => setBooting(false))
            }}
          >
            Retry
          </button>
        </div>
        {nameAndConfirmModals}
      </>
    )
  }

  if (!store) {
    return (
      <>
        <div className="boot-shell">
          <div className="brand">
            <div className="brand-row">
              <img className="brand-logo" src={logoUrl} alt="" />
              <div>
                <h1>Modunary</h1>
                <p>Could not finish startup</p>
              </div>
            </div>
          </div>
          {bootError && <div className="callout error">{bootError}</div>}
          <div className="toolbar-group">
            <button className="btn primary" onClick={() => void openCreateModal()}>
              New Profile
            </button>
            <button
              className="btn"
              onClick={() => {
                setBooting(true)
                setBootError(null)
                void refresh()
                  .catch((err: unknown) => {
                    setBootError(err instanceof Error ? err.message : String(err))
                    setStore((prev) => prev ?? { ...EMPTY_STORE })
                  })
                  .finally(() => setBooting(false))
              }}
            >
              Retry load
            </button>
          </div>
        </div>
        {nameAndConfirmModals}
      </>
    )
  }

  const dirtyCurrent =
    activeProfile &&
    versionModal &&
    activeProfile.id !== versionModal.profileId &&
    Boolean(activeProfile.dirty)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-row">
            <img className="brand-logo" src={logoUrl} alt="" />
            <div>
              <h1>Modunary</h1>
              <p>Bannerlord mod profiles · Steam / Nexus / ModDB</p>
            </div>
          </div>
        </div>

        {bootError && <div className="callout error">{bootError}</div>}

        <div className="create-hero">
          <button className="btn primary create-btn" disabled={busy} onClick={onCreate}>
            New Profile
          </button>
          <button className="btn" disabled={busy || !selected} onClick={onRefreshFromDisk}>
            Capture current Modules
          </button>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              setBooting(true)
              void refresh()
                .catch((err: unknown) =>
                  setMessage({
                    kind: 'error',
                    text: err instanceof Error ? err.message : String(err),
                  }),
                )
                .finally(() => setBooting(false))
            }}
          >
            Refresh
          </button>
        </div>

        <div className="profile-list">
          {store.profiles.length === 0 && (
            <div className="empty">No profiles yet. Create one from your current mod setup.</div>
          )}
          {store.profiles
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => (
              <button
                key={p.id}
                type="button"
                title="Click to select · Double-click to rename"
                className={`profile-item ${p.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(p.id)}
                onDoubleClick={() => {
                  setSelectedId(p.id)
                  setNameModal({
                    mode: 'rename',
                    value: p.name,
                    captureCurrent: false,
                    gameVersion: p.gameVersion,
                    steamBetaBranch: p.steamBetaBranch,
                  })
                }}
              >
                <span className="name">{p.name}</span>
                <span className="meta">
                  v{p.gameVersion} · {p.mods.filter((m) => m.enabled).length}/{p.mods.length} ·{' '}
                  {p.settings.requiresBlse ? 'BLSE' : 'Steam'}
                </span>
                {store.activeProfileId === p.id && <span className="badge">Active</span>}
                {p.dirty && <span className="badge dirty">Unsaved</span>}
              </button>
            ))}
        </div>

        <div className="callout">
          Detected game: {discovery?.detectedGameVersion ?? 'unknown'}
          {'\n'}
          Steam beta: {discovery?.steamBetaBranch || '(public / none)'}
          {'\n'}
          Mods on disk: {discovery?.mods.length ?? 0} · Vault: {vaultCount}
          {'\n'}
          BLSE: {discovery?.blse.installed ? 'installed' : 'not found'}
        </div>
      </aside>

      <main className="main">
        {!selected ? (
          <div className="panel empty">Select or create a profile to get started.</div>
        ) : (
          <>
            <div className="toolbar">
              <div className="title-row">
                <h2 style={{ margin: 0, fontFamily: 'var(--font-display)' }}>{selected.name}</h2>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={onRename}
                  title="Rename profile (F2)"
                >
                  Rename
                </button>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', width: '100%' }}>
                  {store.activeProfileId === selected.id ? 'Currently active · ' : ''}
                  Updated {new Date(selected.updatedAt).toLocaleString()}
                  {' · '}
                  Double-click a sidebar profile to rename
                </div>
              </div>
              <div className="toolbar-group">
                <button
                  className="btn primary"
                  disabled={busy || activateLaunchBlocked}
                  title={activateLaunchBlocked ? activateLaunchTip : 'Activate this profile'}
                  onClick={() => void onActivate()}
                >
                  Activate profile
                </button>
                <button
                  className="btn primary"
                  disabled={busy || activateLaunchBlocked}
                  title={activateLaunchBlocked ? activateLaunchTip : launchLabel}
                  onClick={() => void onLaunch()}
                >
                  {launchLabel}
                </button>
                <button className="btn" disabled={busy} onClick={onRefreshFromDisk}>
                  Capture current
                </button>
                <button className="btn" disabled={busy} onClick={onSyncMods}>
                  Sync Modules
                </button>
                <button className="btn" disabled={busy} onClick={onDuplicate}>
                  Duplicate
                </button>
                <button className="btn danger" disabled={busy} onClick={onDelete}>
                  Delete
                </button>
              </div>
            </div>

            {activateLaunchBlocked && activateLock?.message && (
              <div className="callout warn" title={activateLock.tooltip || undefined}>
                {activateLock.source === 'steam' || activateLock.source === 'both'
                  ? activateLock.message
                  : activateLock.message}
                {activateLock.steamDetail && activateLock.steamBusy
                  ? `\nSteam: ${activateLock.steamDetail}`
                  : ''}
                {'\n'}
                Activate and Launch stay disabled until Steam is idle and Modunary finishes.
              </div>
            )}
            {message && <div className={`callout ${message.kind}`}>{message.text}</div>}
            {discovery?.warnings?.length ? (
              <div className="callout warn">{discovery.warnings.join('\n')}</div>
            ) : null}

            <div className="toolbar-group">
              {(['mods', 'stores', 'settings', 'about'] as Tab[]).map((t) => (
                <button
                  key={t}
                  className={`btn ${tab === t ? 'primary' : 'ghost'}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'mods'
                    ? 'Mods'
                    : t === 'stores'
                      ? 'Mod stores'
                      : t === 'settings'
                        ? 'Paths & version'
                        : 'How it works'}
                </button>
              ))}
            </div>

            {tab === 'mods' && (
              <section className="panel">
                <h2>Mod load order</h2>
                <p className="sub">
                  Activate deploys this profile’s modules from the vault into Modules (junctions by
                  default), parks other community mods, then writes LauncherData.xml. Vortex is
                  ignored.
                </p>
                <div className="toolbar-group" style={{ marginBottom: '0.75rem' }}>
                  <button
                    className="btn primary"
                    disabled={busy || selected.mods.length === 0}
                    onClick={() => void onScanLoadOrder()}
                    title="Scan SubModule.xml dependencies and apply a topological load order"
                  >
                    Scan &amp; apply load order
                  </button>
                  <button
                    className="btn"
                    disabled={busy || !selected.loadOrderUndo?.length}
                    onClick={() => void onUndoLoadOrder()}
                    title="Restore the order from before the last scan/apply"
                  >
                    Undo load order
                  </button>
                </div>
                {selected.loadOrderUndo?.length ? (
                  <div className="callout" style={{ marginBottom: '0.75rem' }}>
                    Undo available — previous order saved ({selected.loadOrderUndo.length} mods).
                  </div>
                ) : null}
                <div className="field" style={{ marginBottom: '0.75rem' }}>
                  <label htmlFor="filter">Filter</label>
                  <input
                    id="filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Search mods…"
                  />
                </div>
                <div className="mods-scroll">
                  <table className="mods-table">
                    <thead>
                      <tr>
                        <th style={{ width: 70 }}>On</th>
                        <th style={{ width: 90 }}>Order</th>
                        <th>Mod</th>
                        <th>Version</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMods.map((m) => (
                        <tr key={m.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={m.enabled}
                              disabled={busy}
                              onChange={(e) => onToggleMod(m.id, e.target.checked)}
                            />
                          </td>
                          <td>
                            <div className="order-btns">
                              <button
                                className="btn ghost"
                                disabled={busy}
                                onClick={() => moveMod(m.id, -1)}
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                className="btn ghost"
                                disabled={busy}
                                onClick={() => moveMod(m.id, 1)}
                                title="Move down"
                              >
                                ↓
                              </button>
                            </div>
                          </td>
                          <td>
                            <div>{m.name}</div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                              {m.id}
                              {m.source ? ` · ${m.source}` : ''}
                            </div>
                          </td>
                          <td>{m.version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {tab === 'stores' && (
              <section className="panel">
                <h2>Mod stores</h2>
                <p className="sub">
                  Search Steam Workshop, Nexus Mods, and ModDB. Keys live in encrypted app secrets
                  (or env vars). Downloads that need Premium/manual steps open the browser.
                </p>

                <div className="toolbar-group" style={{ marginBottom: '0.75rem' }}>
                  {(['nexus', 'steam', 'moddb'] as StoreKind[]).map((k) => (
                    <button
                      key={k}
                      className={`btn ${storeKind === k ? 'primary' : 'ghost'}`}
                      onClick={() => setStoreKind(k)}
                    >
                      {k === 'nexus' ? 'Nexus' : k === 'steam' ? 'Steam Workshop' : 'ModDB'}
                    </button>
                  ))}
                </div>

                <div className="path-row" style={{ marginBottom: '0.75rem' }}>
                  <input
                    value={storeQuery}
                    onChange={(e) => setStoreQuery(e.target.value)}
                    placeholder={`Search ${storeKind}…`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onSearchStore()
                    }}
                  />
                  <button className="btn primary" disabled={busy} onClick={onSearchStore}>
                    Search
                  </button>
                  {storeManualUrl && (
                    <button
                      className="btn"
                      onClick={() => window.bannerlord.openExternal(storeManualUrl)}
                    >
                      Open in browser
                    </button>
                  )}
                </div>

                <div className="toolbar-group" style={{ marginBottom: '0.75rem' }}>
                  <button className="btn" disabled={busy} onClick={onImportZip}>
                    Import ZIP → vault
                  </button>
                  <button className="btn" disabled={busy} onClick={onImportFolder}>
                    Import folder → vault
                  </button>
                  <button className="btn" disabled={busy} onClick={onImportModulesToVault}>
                    Vault current Modules
                  </button>
                </div>

                {storeError && <div className="callout warn">{storeError}</div>}

                <div className="store-results">
                  {storeResults.map((r) => (
                    <div key={`${r.store}-${r.id}`} className="store-card">
                      <div>
                        <strong>{r.name}</strong>
                        <div className="meta">{r.summary || r.note}</div>
                      </div>
                      <div className="toolbar-group">
                        <button
                          className="btn"
                          onClick={() => window.bannerlord.openExternal(r.url)}
                        >
                          Open
                        </button>
                        {r.store === 'steam' && (
                          <>
                            <button
                              className="btn"
                              disabled={busy}
                              onClick={() =>
                                withBusy(async () => {
                                  await window.bannerlord.openSteamWorkshop(r.id)
                                  setMessage({
                                    kind: 'ok',
                                    text: 'Opened in Steam. Subscribe, then Import Workshop.',
                                  })
                                })
                              }
                            >
                              Steam subscribe
                            </button>
                            <button
                              className="btn primary"
                              disabled={busy || !selected}
                              onClick={() =>
                                withBusy(async () => {
                                  const res = await window.bannerlord.importWorkshop(r.id)
                                  if (!res.ok) throw new Error(res.error || 'Import failed')
                                  await addImportedToProfile(
                                    res.modules as Array<{
                                      folderName: string
                                      id: string
                                      name: string
                                      version: string
                                    }>,
                                    'steam',
                                    r.id,
                                  )
                                  setMessage({
                                    kind: 'ok',
                                    text: `Imported workshop item ${r.id} into vault/profile.`,
                                  })
                                })
                              }
                            >
                              Import Workshop
                            </button>
                          </>
                        )}
                        {r.store === 'nexus' && (
                          <button
                            className="btn primary"
                            disabled={busy || !selected}
                            onClick={() =>
                              withBusy(async () => {
                                const files = await window.bannerlord.listNexusFiles(r.id)
                                if (!files.ok || !files.files.length) {
                                  await window.bannerlord.openExternal(r.url)
                                  throw new Error(
                                    files.error ||
                                      'Could not list files — opened Nexus page for manual download.',
                                  )
                                }
                                const file = files.files[0]
                                const dl = await window.bannerlord.downloadNexusFile(
                                  r.id,
                                  String(file.id),
                                )
                                if (!dl.ok) {
                                  await window.bannerlord.openExternal(r.url)
                                  throw new Error(
                                    dl.error ||
                                      'Nexus download unavailable — opened mod page (Premium often required).',
                                  )
                                }
                                const modules =
                                  (dl.imported?.modules as Array<{
                                    folderName: string
                                    id: string
                                    name: string
                                    version: string
                                  }>) || []
                                await addImportedToProfile(modules, 'nexus', r.id)
                                setMessage({
                                  kind: 'ok',
                                  text: `Downloaded Nexus mod ${r.id} → vault/profile.`,
                                })
                              })
                            }
                          >
                            Download / install
                          </button>
                        )}
                        {r.store === 'moddb' && (
                          <button
                            className="btn"
                            onClick={() => window.bannerlord.openExternal(r.url)}
                          >
                            Manual download
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {tab === 'settings' && (
              <section className="panel">
                <h2>Paths, version & accounts</h2>
                <p className="sub">
                  Override paths, pin Steam beta/version, store API credentials, and BLSE launch
                  preference.
                </p>

                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="gameVersion">Target Bannerlord version</label>
                    <input
                      id="gameVersion"
                      defaultValue={selected.gameVersion}
                      key={`gv-${selected.id}-${selected.updatedAt}`}
                      onBlur={(e) => {
                        if (e.target.value !== selected.gameVersion) {
                          void saveProfileFields({ gameVersion: e.target.value })
                        }
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="beta">Steam BetaKey / branch</label>
                    <input
                      id="beta"
                      defaultValue={selected.steamBetaBranch}
                      key={`beta-${selected.id}-${selected.updatedAt}`}
                      placeholder="e.g. v1.3.15 (matches Steam Betas)"
                      onBlur={(e) => {
                        if (e.target.value !== selected.steamBetaBranch) {
                          void saveProfileFields({ steamBetaBranch: e.target.value })
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="grid-2" style={{ marginTop: '0.9rem' }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selected.settings.requiresBlse}
                      disabled={busy}
                      onChange={(e) => {
                        void saveProfileFields({
                          settings: {
                            ...selected.settings,
                            requiresBlse: e.target.checked,
                            preferredLauncher: e.target.checked ? 'blse' : 'steam',
                          },
                        })
                      }}
                    />
                    Profile requires BLSE (Launch via BLSE)
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selected.settings.autoBackupLauncherData !== false}
                      disabled={busy}
                      onChange={(e) => {
                        void saveProfileFields({
                          settings: {
                            ...selected.settings,
                            autoBackupLauncherData: e.target.checked,
                          },
                        })
                      }}
                    />
                    Backup LauncherData.xml before activate
                  </label>
                </div>

                <div className="grid-2" style={{ marginTop: '0.5rem' }}>
                  <div className="field">
                    <label htmlFor="vaultMode">Vault deploy mode</label>
                    <select
                      id="vaultMode"
                      value={selected.settings.vaultDeployMode}
                      disabled={busy}
                      onChange={(e) => {
                        void saveProfileFields({
                          settings: {
                            ...selected.settings,
                            vaultDeployMode: e.target.value as 'junction' | 'copy',
                          },
                        })
                      }}
                    >
                      <option value="junction">Junction (fast)</option>
                      <option value="copy">Full copy</option>
                    </select>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={store.allowSteamBetaKeyWrite !== false}
                      disabled={busy}
                      onChange={(e) => {
                        void withBusy(async () => {
                          await window.bannerlord.setAllowSteamBetaKeyWrite(e.target.checked)
                          await refresh()
                        })
                      }}
                    />
                    Allow Steam BetaKey write on confirmed version switch
                  </label>
                </div>

                <div className="field" style={{ marginTop: '0.9rem' }}>
                  <label>Game install path</label>
                  <div className="path-row">
                    <input
                      readOnly
                      value={discovery?.installPath ?? store.gameInstallPath ?? '(not found)'}
                    />
                    <button className="btn" onClick={pickGamePath}>
                      Browse
                    </button>
                    <button className="btn ghost" onClick={clearGamePath}>
                      Auto
                    </button>
                  </div>
                </div>

                <div className="field" style={{ marginTop: '0.75rem' }}>
                  <label>Documents path</label>
                  <div className="path-row">
                    <input
                      readOnly
                      value={discovery?.documentsPath ?? store.documentsPath ?? '(not found)'}
                    />
                    <button className="btn" onClick={pickDocsPath}>
                      Browse
                    </button>
                  </div>
                </div>

                <div className="field" style={{ marginTop: '0.75rem' }}>
                  <label htmlFor="notes">Notes</label>
                  <textarea
                    id="notes"
                    rows={3}
                    defaultValue={selected.settings.notes}
                    key={`notes-${selected.id}-${selected.updatedAt}`}
                    onBlur={(e) => {
                      if (e.target.value !== selected.settings.notes) {
                        void saveProfileFields({
                          settings: { ...selected.settings, notes: e.target.value },
                        })
                      }
                    }}
                  />
                </div>

                <h2 style={{ marginTop: '1.25rem' }}>Store credentials</h2>
                <p className="sub">
                  Stored via Electron safeStorage when available. Env fallbacks:{' '}
                  {secrets?.hooks.envNexus}, {secrets?.hooks.envSteam},{' '}
                  {secrets?.hooks.envModdbUser}/{secrets?.hooks.envModdbPass}. Nexus SSO app id
                  optional ({secrets?.hooks.envNexusAppId}) after Stephen registers the app on Nexus.
                </p>
                <div className="grid-2">
                  <SecretField
                    label={`Nexus API key ${secrets?.nexusApiKeySet ? '(set)' : '(missing)'}`}
                    placeholder="Paste Nexus API key"
                    onSave={(v) =>
                      withBusy(async () => {
                        setSecrets(await window.bannerlord.setSecrets({ nexusApiKey: v }))
                      })
                    }
                  />
                  <SecretField
                    label={`Steam Web API key ${secrets?.steamWebApiKeySet ? '(set)' : '(missing)'}`}
                    placeholder="Paste Steam Web API key"
                    onSave={(v) =>
                      withBusy(async () => {
                        setSecrets(await window.bannerlord.setSecrets({ steamWebApiKey: v }))
                      })
                    }
                  />
                  <SecretField
                    label={`ModDB username ${secrets?.moddbUsernameSet ? '(set)' : ''}`}
                    placeholder="Optional ModDB username"
                    onSave={(v) =>
                      withBusy(async () => {
                        setSecrets(await window.bannerlord.setSecrets({ moddbUsername: v }))
                      })
                    }
                  />
                  <SecretField
                    label={`ModDB password ${secrets?.moddbPasswordSet ? '(set)' : ''}`}
                    placeholder="Optional ModDB password"
                    password
                    onSave={(v) =>
                      withBusy(async () => {
                        setSecrets(await window.bannerlord.setSecrets({ moddbPassword: v }))
                      })
                    }
                  />
                </div>
                <div className="toolbar-group" style={{ marginTop: '0.75rem' }}>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      withBusy(async () => {
                        const v = await window.bannerlord.validateNexus()
                        setMessage({
                          kind: v.ok ? 'ok' : 'error',
                          text: v.ok
                            ? `Nexus OK: ${v.name} (Premium: ${v.isPremium ? 'yes' : 'no'})`
                            : v.error || 'Nexus validate failed',
                        })
                      })
                    }
                  >
                    Validate Nexus key
                  </button>
                  <button
                    className="btn ghost"
                    onClick={async () => {
                      const p = await window.bannerlord.getVaultPath()
                      await window.bannerlord.showItemInFolder(p)
                    }}
                  >
                    Open vault folder
                  </button>
                </div>
              </section>
            )}

            {tab === 'about' && (
              <section className="panel">
                <h2>How Modunary works</h2>
                <div className="callout">
                  {`1. Each profile stores gameVersion / steamBetaBranch, BLSE requirement, vaulted mod set, order, enabled flags.
2. New Profile with capture on infers version from the install; with capture off you pick a Steam version (current, public, backups, steamcmd, known branches).
3. Activate parks non-profile community modules into the vault, deploys the profile set (junction/copy), writes LauncherData.xml.
4. If the target game version differs, a modal asks to Continue (opt-in BetaKey write + validate) or Cancel (no changes).
5. Mods tab → Scan & apply load order reads SubModule.xml DependedModules / Metadatas and applies a topo order (Undo restores the previous order).
6. Launch uses BLSE when the profile requires it; otherwise Steam.
7. Stores: Nexus (API key; Premium for CDN), Steam Workshop (Web API key + subscribe/import), ModDB (no official API — browser + ZIP import).
8. Vortex is ignored entirely.`}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {versionModal && (
        <div className="modal-backdrop">
          <div className="modal">
            {versionModal.stage === 'confirm' ? (
              <>
                <h2>Version switch required</h2>
                <p>
                  This profile requires version <strong>{versionModal.requiredVersion}</strong>,
                  switching now.
                </p>
                <p className="sub">
                  Current install reports {versionModal.currentVersion ?? 'unknown'}. Continue will
                  deactivate the current profile, activate this one (vault deploy + LauncherData), and
                  attempt a Steam BetaKey switch.
                </p>
                {dirtyCurrent && (
                  <div className="field" style={{ margin: '0.75rem 0' }}>
                    <label htmlFor="saveAs">
                      Current profile “{activeProfile?.name}” has unsaved changes — save as:
                    </label>
                    <input
                      id="saveAs"
                      value={saveAsName}
                      onChange={(e) => setSaveAsName(e.target.value)}
                      placeholder="New profile name"
                    />
                  </div>
                )}
                <div className="toolbar-group">
                  <button className="btn primary" disabled={busy} onClick={() => void onVersionContinue()}>
                    Continue
                  </button>
                  <button className="btn" disabled={busy} onClick={onVersionCancel}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>
                  {versionModal.stage === 'error'
                    ? 'Activation failed'
                    : versionModal.stage === 'done'
                      ? 'Activation complete'
                      : 'Activating…'}
                </h2>
                <p className="sub">
                  Target version <strong>{versionModal.requiredVersion.replace(/^v/i, '')}</strong>
                  {versionModal.currentVersion
                    ? ` · was ${versionModal.currentVersion}`
                    : ''}
                </p>
                <ul className="activate-progress">
                  {(
                    [
                      ['saving', 'Saving current profile…'],
                      ['installing-version', `Installing version ${versionModal.requiredVersion.replace(/^v/i, '')}…`],
                      ['waiting-steam', 'Waiting for Steam to finish…'],
                      ['activating-mods', 'Activating mods…'],
                      ['writing-launcher', 'Writing launcher data…'],
                      ['done', 'Done'],
                    ] as const
                  ).map(([phase, label]) => {
                    const order = [
                      'saving',
                      'installing-version',
                      'waiting-steam',
                      'activating-mods',
                      'writing-launcher',
                      'done',
                    ] as const
                    const currentIdx = versionModal.progressPhase
                      ? order.indexOf(
                          versionModal.progressPhase === 'error'
                            ? 'installing-version'
                            : (versionModal.progressPhase as (typeof order)[number]),
                        )
                      : -1
                    const phaseIdx = order.indexOf(phase)
                    const isFailedStep =
                      versionModal.stage === 'error' && versionModal.progressPhase === phase
                    const isCurrent =
                      versionModal.stage === 'progress' && versionModal.progressPhase === phase
                    const isDone =
                      versionModal.stage === 'done' ||
                      (currentIdx >= 0 && phaseIdx >= 0 && phaseIdx < currentIdx)
                    return (
                      <li
                        key={phase}
                        className={
                          isFailedStep
                            ? 'error'
                            : isCurrent
                              ? 'current'
                              : isDone
                                ? 'done'
                                : 'pending'
                        }
                      >
                        <span className="activate-progress-mark" aria-hidden>
                          {isFailedStep ? '!' : isDone && !isCurrent ? '✓' : isCurrent ? '●' : '○'}
                        </span>
                        <span>{label}</span>
                      </li>
                    )
                  })}
                </ul>
                {versionModal.stage === 'progress' && (
                  <p className="activate-progress-live">{versionModal.progressMessage}</p>
                )}
                {versionModal.stage === 'error' && versionModal.error && (
                  <div className="callout error">{versionModal.error}</div>
                )}
                {versionModal.stage === 'done' && versionModal.summary && (
                  <div className="callout ok" style={{ whiteSpace: 'pre-wrap' }}>
                    {versionModal.summary}
                  </div>
                )}
                <div className="toolbar-group" style={{ marginTop: '0.9rem' }}>
                  {(versionModal.stage === 'done' || versionModal.stage === 'error') && (
                    <button className="btn primary" onClick={onVersionClose}>
                      Close
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {nameAndConfirmModals}
    </div>
  )
}

function SecretField({
  label,
  placeholder,
  password,
  onSave,
}: {
  label: string
  placeholder: string
  password?: boolean
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <div className="field">
      <label>{label}</label>
      <div className="path-row">
        <input
          type={password ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => {
            onSave(value)
            setValue('')
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ActivateResult,
  AppStore,
  GameDiscovery,
  ModProfile,
} from '../electron/types'
import './App.css'

type Tab = 'mods' | 'settings' | 'about'

export default function App() {
  const [store, setStore] = useState<AppStore | null>(null)
  const [discovery, setDiscovery] = useState<GameDiscovery | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('mods')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(
    null,
  )
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    const [nextStore, nextDiscovery] = await Promise.all([
      window.bannerlord.getStore(),
      window.bannerlord.getDiscovery(),
    ])
    setStore(nextStore)
    setDiscovery(nextDiscovery)
    setSelectedId((prev) => {
      if (prev && nextStore.profiles.some((p) => p.id === prev)) return prev
      return nextStore.activeProfileId ?? nextStore.profiles[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    refresh().catch((err: unknown) => {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    })
  }, [refresh])

  const selected = useMemo(
    () => store?.profiles.find((p) => p.id === selectedId) ?? null,
    [store, selectedId],
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

  async function onCreate() {
    const name = window.prompt('New profile name')
    if (!name?.trim()) return
    await withBusy(async () => {
      const profile = await window.bannerlord.createProfile({
        name: name.trim(),
        captureCurrent: true,
      })
      await refresh()
      setSelectedId(profile.id)
      setMessage({
        kind: 'ok',
        text: `Created "${profile.name}" from current LauncherData / Modules (${profile.mods.length} mods).`,
      })
    })
  }

  async function onRename() {
    if (!selected) return
    const name = window.prompt('Rename profile', selected.name)
    if (!name?.trim() || name.trim() === selected.name) return
    await withBusy(async () => {
      await window.bannerlord.renameProfile(selected.id, name.trim())
      await refresh()
    })
  }

  async function onDelete() {
    if (!selected) return
    if (!window.confirm(`Delete profile "${selected.name}"? This cannot be undone.`)) return
    await withBusy(async () => {
      await window.bannerlord.deleteProfile(selected.id)
      await refresh()
      setMessage({ kind: 'ok', text: `Deleted "${selected.name}".` })
    })
  }

  async function onActivate() {
    if (!selected) return
    await withBusy(async () => {
      const result: ActivateResult = await window.bannerlord.activateProfile(selected.id)
      await refresh()
      const lines = [
        `Activated "${selected.name}".`,
        `Wrote: ${result.launcherDataPath}`,
        result.backupPath ? `Backup: ${result.backupPath}` : null,
        ...result.versionNotes,
        ...result.warnings,
      ].filter(Boolean)
      setMessage({
        kind: result.warnings.length ? 'warn' : 'ok',
        text: lines.join('\n'),
      })
    })
  }

  async function onRefreshFromDisk() {
    if (!selected) return
    if (
      !window.confirm(
        `Replace "${selected.name}" mods/order/enabled with the current LauncherData + Modules snapshot?`,
      )
    ) {
      return
    }
    await withBusy(async () => {
      await window.bannerlord.refreshProfileFromDisk(selected.id)
      await refresh()
      setMessage({ kind: 'ok', text: 'Pulled current LauncherData + Modules into this profile.' })
    })
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

  if (!store) {
    return <div className="empty">Loading Bannerlord Mod Profiles…</div>
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Bannerlord Mod Profiles</h1>
          <p>Switch loadouts, order, and target game version</p>
        </div>

        <div className="sidebar-actions">
          <button className="btn primary" disabled={busy} onClick={onCreate}>
            New profile
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => refresh()}>
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
                className={`profile-item ${p.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="name">{p.name}</span>
                <span className="meta">
                  v{p.gameVersion} · {p.mods.filter((m) => m.enabled).length}/{p.mods.length} enabled
                </span>
                {store.activeProfileId === p.id && <span className="badge">Active</span>}
              </button>
            ))}
        </div>

        <div className="callout">
          Detected game: {discovery?.detectedGameVersion ?? 'unknown'}
          {'\n'}
          Mods on disk: {discovery?.mods.length ?? 0}
        </div>
      </aside>

      <main className="main">
        {!selected ? (
          <div className="panel empty">Select or create a profile to get started.</div>
        ) : (
          <>
            <div className="toolbar">
              <div>
                <h2 style={{ margin: 0, fontFamily: 'var(--font-display)' }}>{selected.name}</h2>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                  {store.activeProfileId === selected.id ? 'Currently active · ' : ''}
                  Updated {new Date(selected.updatedAt).toLocaleString()}
                </div>
              </div>
              <div className="toolbar-group">
                <button className="btn primary" disabled={busy} onClick={onActivate}>
                  Activate profile
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
                <button className="btn" disabled={busy} onClick={onRename}>
                  Rename
                </button>
                <button className="btn danger" disabled={busy} onClick={onDelete}>
                  Delete
                </button>
              </div>
            </div>

            {message && <div className={`callout ${message.kind}`}>{message.text}</div>}
            {discovery?.warnings?.length ? (
              <div className="callout warn">{discovery.warnings.join('\n')}</div>
            ) : null}

            <div className="toolbar-group">
              {(['mods', 'settings', 'about'] as Tab[]).map((t) => (
                <button
                  key={t}
                  className={`btn ${tab === t ? 'primary' : 'ghost'}`}
                  onClick={() => setTab(t)}
                >
                  {t === 'mods' ? 'Mods' : t === 'settings' ? 'Paths & version' : 'How it works'}
                </button>
              ))}
            </div>

            {tab === 'mods' && (
              <section className="panel">
                <h2>Mod load order</h2>
                <p className="sub">
                  Order and enabled flags are written to LauncherData.xml on activate. Modules stay
                  in the game folder; disabled mods remain installed but unchecked.
                </p>
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

            {tab === 'settings' && (
              <section className="panel">
                <h2>Paths & version</h2>
                <p className="sub">
                  Override auto-detected Steam/common paths when needed. Version is remembered per
                  profile; Steam owns binary switches.
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
                    <label htmlFor="beta">Steam beta branch (optional)</label>
                    <input
                      id="beta"
                      defaultValue={selected.steamBetaBranch}
                      key={`beta-${selected.id}-${selected.updatedAt}`}
                      placeholder="e.g. beta, or leave blank for public"
                      onBlur={(e) => {
                        if (e.target.value !== selected.steamBetaBranch) {
                          void saveProfileFields({ steamBetaBranch: e.target.value })
                        }
                      }}
                    />
                  </div>
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

                <div className="grid-2" style={{ marginTop: '0.9rem' }}>
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
                  <div className="field">
                    <label htmlFor="launcher">Preferred launcher (hint)</label>
                    <select
                      id="launcher"
                      value={selected.settings.preferredLauncher}
                      disabled={busy}
                      onChange={(e) => {
                        void saveProfileFields({
                          settings: {
                            ...selected.settings,
                            preferredLauncher: e.target.value as
                              | 'official'
                              | 'blse'
                              | 'steam',
                          },
                        })
                      }}
                    >
                      <option value="official">Official launcher</option>
                      <option value="blse">BLSE</option>
                      <option value="steam">Steam</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: '0.9rem' }} className="callout">
                  LauncherData: {discovery?.launcherDataPath ?? 'n/a'}
                  {'\n'}
                  Modules: {discovery?.modulesPath ?? 'n/a'}
                  {'\n'}
                  Steam beta now: {discovery?.steamBetaBranch || '(public / none)'}
                </div>
              </section>
            )}

            {tab === 'about' && (
              <section className="panel">
                <h2>How profiles work</h2>
                <p className="sub">Safe activation model for this first pass.</p>
                <div className="callout">
                  {`1. Each profile stores: name, target game version, optional Steam beta branch, mod list (id/order/enabled), and notes.
2. Activate writes Documents/Mount and Blade II Bannerlord/Configs/LauncherData.xml from the profile.
3. A backup of the previous LauncherData is saved under the app userData/backups folder.
4. A copy is also mirrored to Documents/.../Configs/ModProfiles/<profile name>/.
5. Mods themselves stay in <Game>/Modules — this pass does not copy/delete module folders.
6. Version switching: if the installed version mismatches the profile, the app warns and can open Steam. It does not rewrite Steam manifests by default.`}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

# Bannerlord Mod Profiles

Desktop app for managing Mount & Blade II: Bannerlord **mod profiles** — each profile remembers game version, mods, load order, enabled/disabled state, and notes. Activating a profile deploys that loadout to the official launcher config.

## Stack

- **Electron** + **Vite** + **React** + **TypeScript**
- Local JSON store under Electron `userData`
- Reads/writes Bannerlord `LauncherData.xml`

## Requirements

- Windows
- Node.js 20+ (LTS recommended)
- Mount & Blade II: Bannerlord installed (Steam recommended; path override supported)

## Run locally

```powershell
cd E:\BannerlordModApp
npm install
npm run dev
```

`npm run dev` starts Vite and Electron together via `vite-plugin-electron`.

## What works in this pass

| Feature | Status |
| --- | --- |
| Create / rename / delete / list / duplicate profiles | Implemented |
| Capture current mods + order + enabled from `LauncherData.xml` | Implemented |
| Sync newly installed Modules into a profile (keep order) | Implemented |
| Edit enabled flags and load order | Implemented |
| Activate → backup + write `LauncherData.xml` | Implemented |
| Remember target Bannerlord version per profile | Implemented |
| Auto-detect Steam libraries / Modules / Documents | Implemented |
| Manual path overrides | Implemented |
| Mirror profile copy under Documents `Configs/ModProfiles` | Implemented |
| Steam/GOG binary version switch | **Best-effort warn only** (does not rewrite Steam manifests) |
| Copy/symlink different module folder sets per profile | Stubbed / not in this pass |
| Launch BLSE / Steam after activate | Stubbed (preference stored only) |

## Key paths

| What | Typical location |
| --- | --- |
| App store | `%APPDATA%\bannerlord-mod-profiles\store.json` |
| Activation backups | `%APPDATA%\bannerlord-mod-profiles\backups\` |
| Game modules | `<Bannerlord>\Modules\` |
| Launcher loadout | `%USERPROFILE%\Documents\Mount and Blade II Bannerlord\Configs\LauncherData.xml` |
| Profile mirrors | `...\Configs\ModProfiles\<name>\LauncherData.xml` |

## Project layout

```
electron/           Main process, IPC, discovery, profiles, activate
src/                React UI
docs note (Context) Project store: docs/bannerlord-mod-profiles.md
```

## Safety notes

- Activation **backs up** the current `LauncherData.xml` before overwriting mod selection/order.
- Existing non-mod sections in `LauncherData.xml` (e.g. DLL check data) are preserved when possible.
- Module folders are **not** deleted or moved. Disabled mods stay on disk, unchecked in the launcher.
- Changing Bannerlord **binaries** requires Steam (Betas / depot) or your storefront. This app records the desired version and warns on mismatch.

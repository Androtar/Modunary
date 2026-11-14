# Modunary

Desktop app for Mount & Blade II: Bannerlord **mod profiles** with per-profile **module vaulting**, opt-in **Steam version switch**, **BLSE/Steam launch**, **Steam version pick on create**, **load-order scan**, and **Steam / Nexus / ModDB** browsing.

## Stack

- Electron + Vite + React + TypeScript
- JSON store + vault under Electron `userData` (`%APPDATA%\modunary`, migrated from `bannerlord-mod-profiles`)
- Secrets via Electron `safeStorage` (env fallbacks supported)

## Run

```powershell
cd E:\BannerlordModApp
npm install
npm run dev
```

## What works

| Feature | Status |
| --- | --- |
| Profile CRUD / duplicate / dirty / rename | Implemented |
| Create with capture → infer version from install | Implemented |
| Create without capture → Steam version picker | Implemented |
| Load-order scan (SubModule.xml deps) + undo | Implemented |
| Per-profile vault deploy on activate (junction/copy) | Implemented |
| LauncherData backup + write | Implemented |
| Version-switch modal (Continue / Cancel + optional save-as) | Implemented |
| Opt-in Steam BetaKey write + validate | Implemented |
| Launch via BLSE / Launch via Steam | Implemented |
| Nexus search + Premium CDN download | Implemented (key required; Premium for CDN) |
| Steam Workshop search + subscribe/import | Implemented (Web API key required) |
| ModDB search | Best-effort scrape + browser; ZIP/folder import |
| Vortex | **Ignored by design** |

## Keys Stephen may need to provide

- `NEXUS_API_KEY` (and Premium for one-click Nexus downloads)
- Optional `NEXUS_APP_ID` after registering the app for Nexus SSO
- `STEAM_WEB_API_KEY` from https://steamcommunity.com/dev/apikey
- Optional ModDB username/password (no official API)

Paste in **Paths & version → Store credentials**, or set env vars before launch.

## Key paths

| What | Location |
| --- | --- |
| App store | `%APPDATA%\modunary\store.json` |
| Module vault | `%APPDATA%\modunary\vault\modules\` |
| Secrets | `%APPDATA%\modunary\secrets.enc.json` |
| Backups | `%APPDATA%\modunary\backups\` |
| Game Modules | `<Bannerlord>\Modules\` |
| LauncherData | `Documents\...\Configs\LauncherData.xml` |

## Project layout

```
electron/           Main process, IPC, vault, stores, activate, launch, Steam versions, load order
src/                React UI (profiles, stores, version modal)
public/             Modunary logo / favicon
build/              Packaged app icon
```

Architecture note (Project Context): `docs/bannerlord-mod-profiles.md`

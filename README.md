# Bannerlord Mod Profiles

Desktop app for Mount & Blade II: Bannerlord **mod profiles** with per-profile **module vaulting**, opt-in **Steam version switch**, **BLSE/Steam launch**, and **Steam / Nexus / ModDB** browsing.

## Stack

- Electron + Vite + React + TypeScript
- JSON store + vault under Electron `userData`
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
| Profile CRUD / duplicate / dirty flag | Implemented |
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
| App store | `%APPDATA%\bannerlord-mod-profiles\store.json` |
| Module vault | `%APPDATA%\bannerlord-mod-profiles\vault\modules\` |
| Secrets | `%APPDATA%\bannerlord-mod-profiles\secrets.enc.json` |
| Backups | `%APPDATA%\bannerlord-mod-profiles\backups\` |
| Game Modules | `<Bannerlord>\Modules\` |
| LauncherData | `Documents\...\Configs\LauncherData.xml` |

## Project layout

```
electron/           Main process, IPC, vault, stores, activate, launch
src/                React UI (profiles, stores, version modal)
```

Architecture note (Project Context): `docs/bannerlord-mod-profiles.md`

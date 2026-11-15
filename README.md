# Compact Time Tracker (Super Productivity plugin)

Compact time tracking on its own page: search a task, start/stop, and a chronological list with corrections.

## Requirements
| Super Productivity | Status |
|---|---|
| **20.0.0 or newer** | **recommended**, full feature set |
| 19.3.x | works, with limitations (see below) |
| older than 19.3 | not supported (installation is rejected) |

Limitations on 19.3.x:
- Start/stop use the permitted action `setCurrentTask`. `startTracking`/`stopTracking` only exist from 20.0.
- The start of the logical day is read from the configuration. From 20.0 it comes from `getDayContext`, and day changes are reported by the `dayChange` hook.
- After switching the theme or light/dark mode, the plugin page has to be reopened. From 20.0 it picks up the colours automatically.

## Installation
1. Download `plugin.zip` from the latest [release](https://github.com/jelko/sp-compact-time-tracker-plugin/releases), or build it yourself (see [Development](#development)).
2. In Super Productivity, open **Settings → Plugins → Choose Plugin File** and pick `plugin.zip`. The same plugin `id` replaces an installed version.
3. "Compact Time Tracker" appears in the left menu (the name is localised).

The background part (`plugin.js`) runs in the app window with the same permissions as the app. Super Productivity asks for confirmation on upload.

## Data
**`task.timeSpentOnDay` is always authoritative.** Daily totals, the weekly total and Super Productivity's reports are based on it alone.
- **Timer:** Super Productivity tracks the running time itself. Entries never change `timeSpentOnDay`.
- **Corrections:** `timeSpentOnDay` only changes through your explicit corrections: duration, from/to, moving, deleting, manual entry.
  - The plugin books exactly the difference and reads the value fresh immediately before.
  - Only then is the entry saved. If saving the entry fails, `timeSpentOnDay` is still correct.
- **Checkpoint:**
  - Super Productivity on its own persists running time only every 5 minutes or on stop.
  - The plugin therefore persists it every minute: it calls `updateTask` with the unchanged `timeSpentOnDay`, and Super Productivity first persists the pending time.
  - On quit or crash, at most about one minute is lost.

**From–to entries** are stored with `persistDataSynced` and synced by Super Productivity.
- **Keys:** one key per logical day and app session, `seg-<YYYY-MM-DD>-<session>`. Content: `{"v":1,"segs":[{id,taskId,start,end,seen,base}]}`.
- **Why separate keys:** Sync resolves conflicts per key by "last write wins". With a key per session, two devices do not overwrite each other, and no entry reaches the 256 KB limit.
- **Running entry:** saved immediately on start and updated every minute with a checkpoint timestamp (`seen`).
- **After a crash or quit:** on the next start, an open entry whose last checkpoint is older than 2.5 minutes ends at that checkpoint. Up to that point the time is also persisted in `timeSpentOnDay`.
- **Idle time:** if Super Productivity discards idle time, the entry's end is moved earlier accordingly when it stops.
- **Retention:** old entries are not deleted automatically.

**Reconciliation in the list** (per task and day):
- More time tracked than entries cover (e.g. time from version 1.x, time tracked in Super Productivity itself, or a duration without time of day): the difference appears as a **"no time of day"** row.
- Entries longer than the tracked time (e.g. after a change in Super Productivity or on another device): a red **"entries > tracked"** row appears. The tracked time stays authoritative; adjust or delete the entry.

## Compact view
The layout follows the width of the plugin area, not the window.
- **680 px and narrower:** the search field gets its own row, with the timer or manual entry and the mode switch below it. List rows show the title on top, with time, duration and actions underneath.
- **440 px and narrower:** manual entry wraps onto several rows.
- Tested at widths of 600, 420 and 360 px.

## Languages
English and German are supported; any other app language falls back to English. The language follows Super Productivity's setting and changes without reloading (`languageChange` hook).
- **Text source:** `i18n/en.json` and `i18n/de.json`, in the format of the plugin i18n guide. The menu name (`PLUGIN.NAME`) also comes from there.
- **Embedding:** the iframe is not served any other files, so `scripts/embed-i18n.mjs` copies the texts into `index.html` (between the `/*I18N-START*/` and `/*I18N-END*/` markers). It also checks that every language has exactly the keys of `en.json`. Run `npm run build` after changing translations; `npm run pack` does it automatically.
- **Adding a language:** create `i18n/<code>.json`, add the code to `i18n.languages` in `manifest.json`, and run `npm run build`.
- **Date and time:** dates follow the app language. Time fields (24 h / AM-PM) follow the system language; the plugin cannot change that.

## Appearance
All colours come from Super Productivity's theme variables (`--card-bg`, `--text-color`, `--divider-color`, `--c-primary`, `--c-warn`, and from 20.0 also `--input-bg` and others).
- **Derived surfaces:** backgrounds of day headers and input fields are mixed from the text and card colours, so they work with any theme.
- **Native controls:** date and time fields follow light/dark mode.

## Plugin rules
The plugin uses only methods and hooks defined in the PluginAPI's `types.ts`. It does not use `localStorage` and nothing bypasses the API.
- **Storage:** entries are stored and read with `persistDataSynced`, `loadSyncedData` and `listSyncedDataKeys`.
- **Exception for 19.3.x:** there the plugin starts and stops via `dispatchAction` with the permitted action `[Task] SetCurrentTask`. From 20.0 it uses `startTracking`/`stopTracking`.

## Limitations
- **Running timer when the page opens:** the page detects it from the entry's last checkpoint. If a timer is running on another device at the same time, its entry may appear as "running" until you start or stop on this device.
- **Plugin loaded late:** if tracking starts before the plugin has loaded, no entry is created for that run. The time then appears as "no time of day".
- **Simultaneous corrections on two devices:** if the same entry is corrected on two devices at the same time, the last change wins after sync.

## Development
Requires Node.js 20.15 or newer. There are no dependencies.

| Command | What it does |
|---|---|
| `npm run build` | Embeds `i18n/*.json` into `index.html` |
| `npm run pack` | Runs `build`, then writes `plugin.zip` and prints its SHA-256 |

Files:
- `manifest.json`: plugin metadata.
- `plugin.js`: background part (recording, checkpoints).
- `index.html`: the page, with all CSS and JavaScript inline.
- `i18n/`: translations.
- `scripts/`: build and pack tools; not part of the ZIP.

Try changes on test data, not your real tasks: use a separate browser profile with the web app, or <https://test-app.super-productivity.com>.

### Releases
1. Set `version` in `manifest.json` (and `package.json`).
2. Commit and push a tag matching the version, e.g. `v2.0.0`.

The release workflow (`.github/workflows/release.yml`) embeds the translations, packs `plugin.zip`, and attaches it to the GitHub release. The release notes show the SHA-256 for a `community-plugins.json` listing.

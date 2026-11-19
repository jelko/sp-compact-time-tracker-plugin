# Compact Time Tracker (Super Productivity plugin)

Compact time tracking in Super Productivity's right side panel: search a task, start/stop, and a chronological list with corrections.

<img width="1270" height="934" alt="sp-compact-time-tracker-v1-full-width" src="https://github.com/user-attachments/assets/432d7eb3-e5ae-441b-933a-4f99d3825b7b" />

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
3. A "Compact Time Tracker" button appears with the side panel buttons; it opens the plugin in the right side panel (the name is localised). The panel can be resized by dragging its edge.

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
- **Under one minute:** an entry shorter than one minute (e.g. an accidental start or a quick switch) is discarded when it stops, and its seconds are taken back from `timeSpentOnDay`. The same applies to bookings under one minute from the inactivity dialog. Manual input under one minute is rejected. Not affected: the split of a running entry at the start of a new day.
- **Keys:** one key per entry, `seg-<YYYY-MM-DD>-<entryId>` (logical day). Content: `{"v":2,"seg":{id,taskId,start,end,seen,base}}`.
- **Why one key per entry:** every key has a single writer at a time. The background part writes only the running entry, the page only finished ones, so no write can overwrite another. Sync resolves conflicts per key by "last write wins", so devices never overwrite each other's entries either.
- **Older format:** keys from 1.0.x (`seg-<day>-<session>` with `{"v":1,"segs":[...]}`) are migrated automatically when the plugin starts.
- **Running entry:** saved immediately on start and updated every minute with a checkpoint timestamp (`seen`).
- **Device:** each entry records the device it was tracked on (`dev`). The device id is kept with `setSecret`, which is local to the device and never synced.
- **Quitting the app stops all timers:** Super Productivity does not resume tracking after a restart. When the plugin starts, it finishes every open entry recorded on this device at its last checkpoint. If only the plugin was reloaded while a timer kept running (update, disable/enable), it detects the running timer (its task's `timeSpentOnDay` keeps growing) and continues that entry. Open entries from other devices are left alone and shown as running while they keep checkpointing.
- **After a crash or quit:** an open entry ends at its last checkpoint; up to that point its time is also persisted in `timeSpentOnDay`. Entries of this device are finished on the next start (see above). Open entries without any checkpoint for 15 minutes, e.g. from a device that stopped syncing, are finished as well. An open entry is never shown as ending "now" unless it is actually running.
- **Inactivity:** after a period of inactivity Super Productivity stops the timer and asks in a dialog how to book the idle time. The running entry ends where the inactivity began. Whatever you book in the dialog becomes entries with times of day, one after another from the start of the inactivity: one per task, including a task created in the dialog. Time you do not book (e.g. a break) creates no entry. The plugin learns about these steps from the `action` hook; `timeSpentOnDay` is not changed by it.
- **Retention:** old entries are not deleted automatically.

**Reconciliation in the list** (per task and day):
- More time tracked than entries cover (e.g. time tracked before the plugin was installed, time tracked in Super Productivity itself, or a duration without time of day): the difference appears as a **"no time of day"** row.
- Entries longer than the tracked time (e.g. after a change in Super Productivity or on another device): a red **"entries > tracked"** row appears. The tracked time stays authoritative. Two ways to resolve it:
  - If the entries are right: **"Add X to tracked time"** in the row's menu.
  - If the tracked time is right: **"Shorten last entry by X"** in the row's menu. It moves the end of the last entry earlier; if that entry is shorter than the difference, it is removed and the one before is shortened. The tracked time stays unchanged; a running entry is left alone.
  - Or edit or delete a specific entry yourself. Shortening or deleting first uses up the excess, so fixing a wrong entry never reduces the tracked time.

## Compact view
The layout follows the width of the plugin area, not the window, so it fits the side panel (320 px by default, 250 px minimum).
- **680 px and narrower:** the search field gets its own row, with the timer or manual entry and the mode switch below it. List rows show the title on top, with time, duration and actions underneath.
- **440 px and narrower:** manual entry wraps onto several rows.
- **340 px and narrower (side panel):** smaller controls; list rows show title and duration on top, time, continue and menu underneath.
- Tested at widths of 600, 420, 360, 340, 320 and 250 px.

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
- **Storage:** entries are stored and read with `persistDataSynced`, `loadSyncedData` and `listSyncedDataKeys`. The device id uses `setSecret`/`getSecret` (local-only storage).
- **Exception for 19.3.x:** there the plugin starts and stops via `dispatchAction` with the permitted action `[Task] SetCurrentTask`. From 20.0 it uses `startTracking`/`stopTracking`.

## Limitations
- **Running timer when the page opens:** the page detects a timer on this device within about 1.5 seconds (its task's tracked time grows). Entries running on another device are shown as running as long as their checkpoints arrive by sync.
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
2. Commit and push a tag matching the version, e.g. `v1.0.0`.

The release workflow (`.github/workflows/release.yml`) embeds the translations, packs `plugin.zip`, and attaches it to the GitHub release. The release notes show the SHA-256 for a `community-plugins.json` listing.

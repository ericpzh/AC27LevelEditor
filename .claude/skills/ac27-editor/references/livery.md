# Livery Editor — subskill reference

Custom aircraft livery page (`Body`/`BaseMap`/`base.png` only) plus the legacy
realistic-pack installer. Screens: browser header **Livery** button →
`screen === 'livery'` (`src/App.jsx` `ScreenRouter` + `UpdateOverlay` wrapper).

## On-disk format

- Own pack: `<gameRoot>/Mods/AC27 Custom Liveries/` (created if missing;
  constant `OWN_PACK` in `electron/livery.js`, `OWN_PACK_NAME` in
  `src/utils/constants/livery.js`). Never write into
  `AC27 Realistic Aircraft Livery` (read-only reference).
- One livery = `<MODS>/<PACK>/<SHORT>_<AIRLINE>/` with exactly:
  `aircraft_livery_manifest.json` + `base.png` (2048×2048).
- Manifest template:
  `{id: "<folder-lower>_default", name: "<SHORT> <AIRLINE> Default Livery",
  airline, targetPlaneId, liveryType: "airline", liverySource: "user",
  targetModelVer: "1",
  parts: [{partName: "Body", textures: [{property: "BaseMap",
  fileName: "base.png"}]}]}` — builder `buildManifest()` in both
  `src/utils/constants/livery.js` (ESM) and `electron/livery.js` (CJS, keep in sync).

## Short-code table (hardcoded, 14 rows — no scan, no cache)

`SHORT_CODE_TO_PLANE_ID`: `A19N→AIRBUS A-319neo`, `A20N→AIRBUS A-320neo`,
`A21N→AIRBUS A-321neo`, `A319→AIRBUS A-319ceo`, `A320→AIRBUS A-320ceo`,
`A333→AIRBUS A-330-300`, `A359→AIRBUS A-350-900`, `A388→AIRBUS A-380-800`,
`B38M→BOEING 737 MAX 8`, `B738→BOEING 737-800`, `B748→BOEING 747-8I`,
`B77W→BOEING 777-300ER`, `B789→BOEING 787-9`, `C919→COMAC C-919`.
Folder regex `LIVERY_FOLDER_RE = /^[A-Z0-9]{3,4}_[A-Z]{3}$/`; `TEXTURE_SIZE = 2048`;
`folderFor(shortCode, airline)` joins `{SHORT}_{AIRLINE}`.

## Components (`src/components/LiveryScreen/`)

- `LiveryScreen.jsx` — header (back → `setScreen('browser')`, help `?` button →
  `LiveryHelpOverlay`), 3-tab bar (`mine`/`create`/`install`, local `useState`,
  tooltips via shared `useTooltip`), unsaved-painter guard:
  CreateTab paint mode registers `window.__liveryPaintGuard = { isDirty() }`;
  tab/back consult it and prompt via `useAppStore.showModal`. No store change
  (`setScreen` accepts any string).
- `MyLiveriesTab.jsx` — `listLiveries` on mount; mine + reference merged into one
  folder set grouped by aircraft type (collapsible sections; header: short
  code · plane id + count badge; unknown `targetPlaneId` sorts last).
  Reference rows share the folders with a lock read-only mark (`IoLockClosed`,
  `livery_tip_readonly` tooltip, no action buttons). Mine rows: thumbnails via
  `readLiveryImage`, Edit → `CreateTab.prefill` + create tab, Export →
  `exportLivery` + `saveLiveryDialog`, copy folder name, Delete → confirm
  modal → `deleteLivery` → refresh. Closes with share help text.
- `CreateTab.jsx` — upload mode (drop-zone/file input → `normalizeToTexture`
  → preview; airline datalist from `AIRLINE_CODE_MAP` + free 3-letter input;
  aircraft select with `SHORT ↔ id` hint; `submitCreate` → `createLivery` →
  toast + `onCreated`) and paint mode (base-source radio blank/existing,
  `LiveryCanvas` via ref `exportPNG()` → same `createLivery`; prefill from
  `CreateTab.prefill` starts in paint). Load-from-ZIP entry → `loadLiveryZip`
  → normalize + prefill → Install reuses `createLivery`.
- `InstallPackTab.jsx` — legacy download/install/fallback flow moved from
  `BrowserScreen.jsx` with an explanatory panel (what it does, `Mods/` target
  path, one-click button with tooltip); renders
  `../BrowserScreen/LiveryInstallOverlay`.
- `LiveryHelpOverlay.jsx` — help overlay (tabs / paint-tools / sharing
  sections, Escape/backdrop/X close), i18n `livery_help_*`.
- `LiveryCanvas.jsx` — fixed 2048² backing store, CSS-scaled view, zoom
  25/50/100%/fit, space-/middle-drag pan, coalesced strokes, rAF overlay.
  Tools (one active): brush (color+hex/size 1–200/opacity/soft-hard), eraser
  (destination-out; CSS checkerboard shows transparency), eyedropper,
  fill (tolerance, pure `floodFill` in `src/utils/liveryPaint.js`), shapes
  (line/rect/ellipse, width, fill toggle), text (click-place input, Enter
  commits to raster), sticker (import via `selectLiveryImage`/`readDiskImage`,
  drag/resize/rotate handles, commit flattens, Del removes). Undo/redo via
  `createUndoStack`/`pushUndo`/`undoStep`/`redoStep` (cap `MAX_UNDO = 20`
  ImageData snapshots). Clear/reset via confirm modal. Export
  (`exportPNG()`) flattens over the base fill. Unsaved flag via `onDirty`.

## IPC (`electron/livery.js` ← `electron/main.js` handlers ← `electron/preload.js`)

Pure logic in `electron/livery.js` (unit-tested); `main.js` only resolves
gameRoot/dialog and delegates. Channels: `list-liveries` →
`{mine, reference}` rows `{folder, id, name, airline, targetPlaneId,
hasBasePng, mtime}` (skip non-dirs; corrupt manifest → row with `error`,
never abort); `read-livery-image(folder, pack)` → PNG data-URL;
`create-livery({imageDataUrl, airline, targetPlaneId, shortCode})` →
validates (airline `/^[A-Z]{3}$/`, `SHORT→id` match, PNG data-URL, IHDR =
2048²) → writes `base.png` + manifest (**silent overwrite, no `.bak`**);
`delete-livery(folder)` (own-pack only, containment-checked `rm -rf`);
`select-livery-image` (png/jpg dialog) + `read-disk-image(filePath)`;
`export-livery(folder)` → `createZip` to temp `<folder>.zip` with
**folder-prefixed entries**; `save-livery-dialog({sourcePath,
suggestedName})` → save dialog + copy + temp cleanup;
`load-livery-zip()` → open dialog → temp extract → `{folder, shortCode,
manifest, imageDataUrl}` (temp cleaned). Errors: `NO_GAME_ROOT` /
`BAD_AIRLINE` / `BAD_PLANE` / `BAD_IMAGE` / `BAD_IMAGE_DIMENSIONS` /
`BAD_FOLDER` / `BAD_MANIFEST` / `IMAGE_MISSING` / `BAD_ZIP` / `ZIP_MISSING`
— renderer maps via `livery_err_*` i18n keys. PNG size via IHDR bytes 16–23;
containment via `path.relative`. ZIP via `src/utils/zipUtils.js` (no new deps);
image normalize in renderer canvas (`src/utils/liveryImage.js`, zero new deps).

## Image rules (locked)

Shrink-to-fit inside 2048², aspect preserved, centered over base fill; smaller
images as-is (never upscale). Main only writes bytes + checks IHDR.
Overwrite always, no `.bak`, no confirm (delete keeps its confirm).

## Share contract

Export ZIP = `<FOLDER>.zip` with `<FOLDER>/aircraft_livery_manifest.json` +
`<FOLDER>/base.png`. Recipient: Create → Load from ZIP, or unzip straight into
`<gameRoot>/Mods/AC27 Custom Liveries/`. Round-trip test:
`tests/electron/livery-ipc.test.js` "share round-trip" (byte-identical
`base.png` + manifest deep-equal).

## Tests

- `tests/utils/livery.test.js` (table/regex/manifest), `tests/utils/liveryPaint.test.js`
  (undo depth ≥20, flood fill), `tests/electron/livery-ipc.test.js` (temp-gameRoot
  list/create/delete/export/load, traversal, IHDR, reference read-only).
- `tests/components/LiveryScreen/` (screen tabs/back/install overlay, upload
  validation + create payload, delete modal, export/save-cancel/copy, canvas
  tools/stroke/text/sticker/save payload with stubbed 2d context).
- In-game acceptance (manual): create via UI → launch game → livery on model
  (validates the own-pack-dir assumption).

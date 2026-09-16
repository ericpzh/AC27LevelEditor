# Livery Editor — subskill reference

Custom aircraft livery page (`Body`/`BaseMap`/`base.png` only) plus the legacy
realistic-pack installer. Screens: browser header **Livery** button →
`screen === 'livery'` (`src/App.jsx` `ScreenRouter` + `UpdateOverlay` wrapper).
Two views (`mine` list / `create` painter, local `useState`, **no tab bar**):
the list view has a single header bar (LHS: Back, Help `?`, Pack; RHS: New,
Select All / Deselect All, Export, Delete, Find); the painter view hides the
header and has its own top bar. The help overlay is **page-scoped** — each view
documents only its own buttons.

## On-disk format

- Own pack: `<gameRoot>/Mods/AC27 Custom Liveries/` (created if missing;
  constant `OWN_PACK` in `electron/livery.js`, `OWN_PACK_NAME` in
  `src/utils/constants/livery.js`). Never write into
  `AC27 Realistic Aircraft Livery` (read-only reference).
- The pack root carries a `mod_info.json` — the game only treats a folder
  under `Mods/` as a mod when it has one. `ensureModInfo()` (called by
  `ensureOwnPackDir`, i.e. on create, and by `listLiveries`, i.e. on load)
  writes it when it is missing/unreadable **or still carries a foreign
  `modName`**: the official pack ZIP ships a copy naming the *reference* pack
  (`Airline_Realistic_Liveries`), which this repairs. Best-effort (never
  throws). Fields mirror the working reference mod: `modName` +
  `modNameEn`/`modNameZhHans`/`modDescriptionEn`/`modDescriptionZhHans`
  (`OWN_PACK_MOD_INFO`); the file is pack-level, never inside a livery folder
  and never part of a share ZIP.
- One livery = one folder under the pack dir containing exactly
  `aircraft_livery_manifest.json` + `base.png` (2048×2048). The **folder name
  is an opaque storage key** — the app never parses meaning out of it (it is
  free-form, filesystem-safe only) and the game reads the manifest instead.
- Manifest template:
  `{id: "<sanitized-folder>_default", name: "<SHORT> <AIRLINE> Default Livery",
  airline, targetPlaneId, liveryType: "airline", liverySource: "user",
  targetModelVer: "1",
  parts: [{partName: "Body", textures: [{property: "BaseMap",
  fileName: "base.png"}]}]}` — builder `buildManifest()` in both
  `src/utils/constants/livery.js` (ESM) and `electron/livery.js` (CJS, keep in sync).
  `id` is derived by lowercasing the folder and collapsing non-alphanumerics
  to `_` (so a conventional `A20N_CCA` still yields `a20n_cca_default`, and a
  free-form `My First Livery 01` yields `my_first_livery_01_default`).

## Short-code table (hardcoded, 14 rows — no scan, no cache)

`SHORT_CODE_TO_PLANE_ID` (+ reverse `PLANE_ID_TO_SHORT_CODE`): `A19N→AIRBUS A-319neo`, `A20N→AIRBUS A-320neo`,
`A21N→AIRBUS A-321neo`, `A319→AIRBUS A-319ceo`, `A320→AIRBUS A-320ceo`,
`A333→AIRBUS A-330-300`, `A359→AIRBUS A-350-900`, `A388→AIRBUS A-380-800`,
`B38M→BOEING 737 MAX 8`, `B738→BOEING 737-800`, `B748→BOEING 747-8I`,
`B77W→BOEING 777-300ER`, `B789→BOEING 787-9`, `C919→COMAC C-919`.
The short code is **only a display/default-name convenience derived from
`targetPlaneId`** — never parsed from a folder name. `TEXTURE_SIZE = 2048`;
`folderFor(planeId, airline)` maps the plane id back to its short code and
builds the conventional `{SHORT}_{AIRLINE}` default shown as the Save As
prefill (unknown plane ids fall back to the raw id).

Folder names are free-form, filesystem-safe only (`LIVERY_FOLDER_SAFE_RE` —
no `\ / : * ? " < > |`, no leading/trailing dot/space, max 64 chars), used
verbatim as the storage key and never parsed into parts. Path traversal is
additionally rejected by `containmentCheck`.

`createLivery(gameRoot, { imageDataUrl, airline, targetPlaneId, folder })` —
only manifest-truth fields plus the free-form folder; the short code and the
manifest id are derived inside. `loadLiveryZip` returns `{folder, shortCode,
manifest, imageDataUrl}` with `shortCode` resolved from `manifest.targetPlaneId`.

## Components (`src/components/LiveryScreen/`)

- `LiveryScreen.jsx` — hub. Two views via local `useState` `tab`
  (`'mine'` list / `'create'` painter). The list view renders a single header
  bar and passes `search` + `mineCmdRef`/`onBarState` to `MyLiveriesTab`; the
  painter view hides the header entirely (`livery-screen--painter`) and lets
  `CreateTab` use `livery-content--painter`. Header buttons (LHS group): Back
  (`goBack`: create → mine, mine → browser), Help `?` (`#livery-help-btn`,
  icon-only, moved left of Pack to match the painter's top bar) → page-scoped
  `LiveryHelpOverlay`, Pack (`handleInstallPack` → `InstallPackTab` in an app
  modal); (RHS group): New, Select All/Deselect All, **Export**
  (`FaFileExport`, enabled with exactly one selected) and Delete Selected (both
  icon + label, greyed via `.btn-sm:disabled`), Find input
  (`IoSearchOutline`). `LiveryHelpOverlay` gets
  `page={isCreate ? 'painter' : 'list'}`. Header bar state
  (`{mineCount, selectedCount, allSelected, oneSelected}`) + commands are
  published by `MyLiveriesTab` through `onBarState` / `mineCmdRef`
  (`toggleSelectAll`/`exportSelected`/`deleteSelected`). Unsaved-painter guard: `CreateTab`
  registers `window.__liveryPaintGuard = { isDirty() }`; Back/Create call
  `guardLeave` and prompt via `useAppStore.showModal`. `CreateTab.prefill`
  holds the clicked row (or null); the create `key` includes
  `{folder, pack}` so switching origins remounts the painter.
- `MyLiveriesTab.jsx` — `listLiveries` on mount; own + reference merged into
  one folder set grouped by aircraft type (collapsible sections; header =
  plane id + count badge; unknown `targetPlaneId` sorts last). Reference rows
  share the folders with a lock read-only mark (`IoLockClosed`,
  `livery_tip_readonly`). Cards are **clickable to open the painter** for both
  packs (`onEdit({...row, pack, imageDataUrl})`, also Enter/Space; clicks on
  buttons/inputs/selects/anchors/labels are ignored). Own cards carry no
  per-card action buttons — only a selection checkbox **inside the card,
  pinned over the thumbnail** (`.livery-thumb .livery-check`). Cards show only
  the readable airline name (`airlineDisplayName(code, lang)` from
  `src/utils/constants/airlines.js` — inverted `AIRLINE_CODE_MAP`, zh picks
  the CJK name; unknown codes fall back to the raw code); the
  `{SHORT}_{AIRLINE}` folder stays internal (payloads, toasts, painter
  prefill). Header actions live in `LiveryScreen` and reach this component via
  `cmdRef`: **Export** (enabled with exactly one selected → `exportLivery` +
  `saveLiveryDialog`) and **Delete** (≥1 selected → count confirm
  `livery_delete_multi_body`, or the single `livery_delete_confirm_body`, then
  `deleteLivery` per folder → `livery_deleted` / `livery_deleted_multi`). The
  header Find filters rows by folder / airline code+name / aircraft / manifest
  name (empty result shows `livery_search_empty`; empty pack shows
  `livery_empty_mine`). Renders `TooltipPortal`.
- `CreateTab.jsx` — the **painter page** (upload mode is gone; default export
  takes `{ onCreated, onCancel, onHelp }`). Given `CreateTab.prefill` it
  snapshots an `origin` `{folder, airline, planeId, pack, imageDataUrl}` with
  `pack` `'mine'` / `'reference'`; the canvas starts primed with the origin
  picture (lazy `readLiveryImage` when the thumbnail was not ready) and the
  background is **always transparent**. Form: a custom airline dropdown
  (`lp-airline-*` — full list, never text-filtered, unlike a native
  `<datalist>`) + plane-id `<select>`; `folderPreview = folderFor(planeId,
  airline)` is only the Save As prefill. Actions:
  - **Import image** (`IoImageOutline`) → `fileToDataUrl` + `normalizeToTexture`
    (`'transparent'`) → new canvas base.
  - **Import livery** (`FaFileImport`) → `loadLiveryZip` → normalize + prime
    airline/planeId from the manifest.
  - **Export livery** (`FaFileExport`) → writes the canvas via `createLivery`
    then `exportLiveryToDir` (directory picker; cancel leaves the saved
    livery, success `livery_exported` with `<folder>.zip`).
  - **Save** (`IoSaveOutline`, disabled for reference) → naming dialog
    prefilled with the origin folder, keeps the origin airline/aircraft.
  - **Save As** (`MdSaveAs`) → naming dialog prefilled with the conventional
    form folder, uses the live form airline/aircraft.
  Save/Save As share `SaveNameDialog` (typed name = folder verbatim,
  `LIVERY_FOLDER_SAFE_RE` gated, buttons inside the modal body). On confirm,
  `confirmOverride(folder, isSaveAs, proceed)` checks `listLiveries()` for a
  `mine` folder with that name (case-insensitive — Windows paths): a collision
  pops an **Overwrite** confirm (`livery_override_title`/`_body`,
  Cancel/`modal_btn_overwrite`). Only plain **Save** re-writing the current
  livery's own origin folder is exempt — **Save As always asks**, including
  when its prefill equals the origin folder; fresh names save straight through
  and an unreadable list falls through. Both then
  funnel through `submitCreate(imageDataUrl, airline, planeId, folder)` →
  `createLivery` → toast + `onCreated`. On success it also fires
  `showModHint()`: unless the `liveryModHintDismissed` cache flag is set
  (`get-cache-flag`), it opens the **Enable the Mod in Game** prompt
  (`livery_mod_hint_title`/`_body`, OK = `modal_btn_ok`) telling the user to
  enable **AC27 Custom Liveries** on the in-game "More Liveries" page, with a
  *Don't show again* checkbox that persists via `set-cache-flag` (stored in the
  cache.json `flags` bag; `CACHE_VERSION` bumped for the new key). Cancel (back arrow) runs
  `confirmDiscard` then `onCancel`; the help button calls `onHelp`.
- `InstallPackTab.jsx` — legacy download/install/fallback flow (NOT a tab:
  opened from the header Pack button inside an app modal) with an explanatory
  panel, the `Mods/` target path (`livery-install-*` classes) and a Close
  (`modal_btn_close`); renders `../BrowserScreen/LiveryInstallOverlay`
  (z-index above the app modal).
- `LiveryHelpOverlay.jsx` — help overlay driven by a `BUTTONS` registry
  (icon + label key + optional description key per button). Takes a `page`
  prop (`'list'` default / `'painter'`) and renders **only that page's**
  sections: `LIST_SECTIONS` = Header bar (`back`/`pack`/`create`/`selectAll`/
  `exportSelected`/`delete`/`search`); `PAINTER_SECTIONS` = Painter
  (`back`/`importImage`/`importZip`/`exportZip`/`saveAs`/`save`) + Paint tools
  (`color`/`brush`/`eraser`/`eyedropper`/`fill`/`line`/`rect`/`ellipse`/`text`/
  `sticker`/`select`/`clear`). Each item renders as "icon + label —
  description"; the self-referential Help chip, and the undo/redo/zoom/fit and
  duplicate/remove-sticker chips, are not listed. Escape/backdrop/X close; i18n
  `livery_help_*` (zh + en).
- `LiveryCanvas.jsx` — fixed 2048² backing store, **transparent** (no base
  fill), CSS-scaled view. Layout: Photoshop-style **left icon rail** +
  contextual options bar + bottom zoom status bar.
  - Tools `TOOLS`: `select` (`FaArrowPointer`, V), brush (B), eraser (E),
    eyedropper (I), fill (G), line (L), rect (R), ellipse (O), text (T).
    `TOOL_META` advertises the shortcut; the keyboard map mirrors it.
  - Options bar (`TOOLS_WITH_OPTIONS`; select/eyedropper have none):
    brush/eraser size + (brush only) opacity + hard/soft; fill tolerance;
    line/rect/ellipse width + fill toggle; text font (`FONT_OPTIONS`) + size +
    bold/italic. Colour lives on the rail (`lp-rail-color`).
  - Zoom ladder `ZOOM_STEPS` (0.125…2) with +/- buttons + Fit; mouse-wheel
    zoom anchored at the cursor. Brush/eraser draw a true-size cursor ring
    (`lp-cursor-ring`).
  - Sticker is a **live, non-destructive object** (`stickerRef`): import via
    `selectLiveryImage`/`readDiskImage` from the rail or `importSticker()`.
    With the Select tool: click to select/move, drag handles to scale/rotate,
    Escape / click-away to deselect, `Delete`/`Backspace` to remove. The rail
    also has **Flip Horizontal / Flip Vertical** buttons
    (`livery_paint_flip_h`/`_v`, `LuFlipHorizontal`/`LuFlipVertical`,
    disabled without a sticker) → `flipSticker('flipX'|'flipY')` toggles the
    `st.flipX`/`st.flipY` flags; every draw/flatten path wraps `drawImage` in
    `ctx.save(); ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1); …; ctx.restore()`.
    Ref methods `importSticker`/`removeSticker`/`duplicateSticker`; duplicate
    stamps the current sticker onto the base (transform included) and leaves a
    nudged copy. Only `exportPNG()` flattens it (over the transparent base).
  - Undo/redo via `createUndoStack`/`pushSnapshot` (cap `MAX_UNDO = 20`
    ImageData snapshots). Clear/reset via confirm modal. Unsaved flag via
    `onDirty`. Text commits to raster on Enter.
- Display names: `airlineDisplayName(code, lang)` +
  `AIRLINE_CODE_TO_NAMES` live in `src/utils/constants/airlines.js`
  (derived from `AIRLINE_CODE_MAP`; CJK name picked for `zh`, otherwise the
  English name; unknown codes return the raw code).

## IPC (`electron/livery.js` ← `electron/main.js` handlers ← `electron/preload.js`)

Pure logic in `electron/livery.js` (unit-tested); `main.js` only resolves
gameRoot/dialog/cleanup and delegates. Channels: `list-liveries` →
`{mine, reference}` rows `{folder, id, name, airline, targetPlaneId,
hasBasePng, mtime}` (skip non-dirs; corrupt manifest → row with `error`,
never abort; also creates the own pack dir + repairs `mod_info.json`);
`read-livery-image(folder, pack)` → PNG data-URL;
`create-livery({imageDataUrl, airline, targetPlaneId, folder})` → validates
(airline `/^[A-Z]{3}$/`, plane id resolves through `PLANE_ID_TO_SHORT_CODE`,
PNG data-URL, IHDR = 2048², folder matches `LIVERY_FOLDER_SAFE_RE` +
containment) and derives the short code + manifest id → writes `base.png` +
manifest (**silent overwrite, no `.bak`** — the renderer's Save As override
prompt is the guard, see `CreateTab`), returns `{success, folder}`;
`delete-livery(folder)` (own-pack only, containment-checked `rm -rf`);
`select-livery-image` (png/jpg dialog) + `read-disk-image(filePath)`;
`export-livery(folder)` → `createZip` to temp `<folder>.zip` with
**folder-prefixed entries**; `export-livery-to-dir(folder)` → `exportLivery`
then a **directory** picker, copies to `<dir>/<folder>.zip` (cancel/failure
calls `cleanExportTemp`); `save-livery-dialog({sourcePath, suggestedName})` →
save dialog + copy + temp cleanup; `load-livery-zip()` → open dialog → temp
extract → `{folder, shortCode, manifest, imageDataUrl}` where `shortCode` is
derived from `manifest.targetPlaneId` (temp cleaned). Errors: `NO_GAME_ROOT` /
`BAD_AIRLINE` / `BAD_PLANE` / `BAD_IMAGE` / `BAD_IMAGE_DIMENSIONS` /
`BAD_FOLDER` / `BAD_MANIFEST` / `IMAGE_MISSING` / `BAD_ZIP` / `ZIP_MISSING`
— renderer maps via `livery_err_*` i18n keys. PNG size via IHDR bytes 16–23;
containment via `path.relative`. ZIP via `src/utils/zipUtils.js` (no new deps);
image normalize in renderer canvas (`src/utils/liveryImage.js`, zero new deps).
Preload exposes `exportLiveryToDir(folder)` alongside the others;
`tests/setup.js` stubs it.

## Image rules (locked)

Base texture is **transparent** — the painter no longer paints a base fill
(`LiveryCanvas` clear is `clearRect`, `normalizeToTexture(dataUrl,
'transparent')`). Shrink-to-fit inside 2048², aspect preserved, centered;
smaller images as-is (never upscale). Main only writes bytes + checks IHDR.
Overwrite always on the backend, no `.bak` (delete keeps its confirm). The
renderer guards the naming dialog (Save / Save As): a folder name that already
exists pops a confirm/cancel prompt (`confirmOverride` in `CreateTab`), except
plain Save re-writing the livery's own folder. `handleExport` still writes
without a prompt.

## Share contract

Export ZIP = `<FOLDER>.zip` with `<FOLDER>/aircraft_livery_manifest.json` +
`<FOLDER>/base.png` (folder name free-form, so `exportLiveryToDir` writes
`<dir>/<FOLDER>.zip`). Recipient: Create → Import livery, or unzip straight
into `<gameRoot>/Mods/AC27 Custom Liveries/`. Round-trip test:
`tests/electron/livery-ipc.test.js` "share round-trip" (byte-identical
`base.png` + manifest deep-equal, and `shortCode` re-derived from the
manifest for a free-form zip folder).

## Tests

- `tests/utils/livery.test.js` (short-code table, `LIVERY_FOLDER_SAFE_RE`
  accept/reject + free-form id sanitization, manifest), `tests/utils/airlines.test.js`
  (`airlineDisplayName` en/zh + unknown fallback, `AIRLINE_CODE_TO_NAMES`
  dedup), `tests/utils/liveryPaint.test.js` (undo depth ≥20, flood fill),
  `tests/electron/livery-ipc.test.js` (temp-gameRoot list/create/delete/export/
  load, free-form folder accepted verbatim, unsafe folder rejected, traversal,
  IHDR, reference read-only, manifest-derived shortCode, `mod_info.json`
  created on load/create at the pack root, reference-name + corrupt-JSON
  repair, existing own file untouched, UTF-8 zh name round-trip).
- `tests/components/LiveryScreen/` (header actions/back/install overlay/search,
  in-card checkbox select driving the header Export/Delete commands + their
  disabled-until-selected states, single vs batch delete confirms, painter
  validation + save/save-as dialogs, Save As overwrite confirm (collision →
  prompt, Overwrite saves, Cancel aborts, fresh name + own-folder re-save skip
  it), post-save mod-enable hint (flag read/write, checkbox persistence,
  hidden once dismissed), free-form folder name, load-from-ZIP,
  import image, cancel, mine vs reference origin save rules, canvas
  tools/stroke/text/sticker/save payload with stubbed 2d context).
- In-game acceptance (manual): create via UI → launch game → livery on model
  (validates the own-pack-dir assumption).

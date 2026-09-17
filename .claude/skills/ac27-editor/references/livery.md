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
  `livery_empty_mine`). Thumbnails load lazily (sequential `readLiveryImage`
  over mine+reference) into a `thumbs[pack:folder]` map; `.livery-thumb`
  reserves a 2:1 box with a **solid `#222` placeholder** up front (`aspect-ratio`
  + `background`), so cards never reflow while the images trickle in and the
  `<img>` fades in on load. Renders `TooltipPortal`.
- `CreateTab.jsx` — the **painter page** (upload mode is gone; default export
  takes `{ onCreated, onCancel, onHelp }`). Given `CreateTab.prefill` it
  snapshots an `origin` `{folder, airline, planeId, pack, imageDataUrl}` with
  `pack` `'mine'` / `'reference'`; the canvas starts primed with the origin
  picture (lazy `readLiveryImage` when the thumbnail was not ready). The
  selected aircraft type's **built-in UV template** (see "Aircraft template"
  below) is fetched whenever a type is known — **including when editing a saved
  livery** — and held in `templateDataUrl`, passed to the canvas as
  `defaultLiveryDataUrl`. For a **new** livery it also becomes the canvas base
  (opaque background showing the real model shape); for a saved origin /
  imported image it never clobbers the base, but it is what **Clear** restores.
  A brand-new canvas is re-primed only while **untouched** — the template
  effect checks `dirtyRef.current` (and `base.isTemplate`) before swapping the
  base, so picking another Airline/Aircraft just updates the form and closes
  the dropdown and never discards in-progress painting. The airline combobox is
  wrapped in a **`<span>`, not a `<label>`** (a `<button>` inside a `<label>`
  makes Chromium refocus the labelled input, which re-fired `onFocus` and
  reopened the list right after a pick); each option also calls
  `onMouseDown={e => e.preventDefault()}` so the pick keeps focus without the
  refocus dance.
  Form: a custom airline dropdown
  (`lp-airline-*` — full list, never text-filtered, unlike a native
  `<datalist>`) + plane-id `<select>`; `folderPreview = folderFor(planeId,
  airline)` is only the Save As prefill. A brand-new livery **defaults to the
  first airline code + `AIRBUS A-319neo`** (`DEFAULT_AIRLINE`/`DEFAULT_PLANE_ID`)
  so the form is valid out of the box, and the type `<select>` has **no blank
  placeholder option** (an origin/zip still supplies its own pair). For a
  **reference (locked) origin** both the airline input (+ its toggle) and the
  type `<select>` are `disabled` and greyed (`.lp-locked`) — the pair is
  display-only, and Save As reuses it. Actions:
  - **Import image** (`IoImageOutline`) → `fileToDataUrl` + `normalizeToTexture`
    (default white fill) → new canvas base.
  - **Import livery** (`FaFileImport`) → `loadLiveryZip` → normalize + prime
    airline/planeId from the manifest.
  - **Export livery** (`FaFileExport`) → writes the canvas via `createLivery`
    then `exportLiveryToDir` (directory picker; cancel leaves the saved
    livery, success `livery_exported` with `<folder>.zip`).
  - **Delete** (`IoTrashOutline`, tooltip `livery_tip_delete` — or
    `livery_tip_readonly` for a reference) → confirm (`Confirm Delete` /
    `livery_delete_confirm_body`) then `delete-livery`; disabled without an
    origin folder (brand-new livery) and for a reference origin.
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
  (`back`/`importImage`/`importZip`/`exportZip`/`deleteThis`/`saveAs`/`save`) +
  Paint tools
  (`color`/`brush`/`eraser`/`eyedropper`/`fill`/`line`/`rect`/`ellipse`/`text`/
  `sticker`/`select`/`clear`). Each item renders as "icon + label —
  description"; the self-referential Help chip, and the undo/redo/zoom/fit and
  duplicate/remove-sticker chips, are not listed. Escape/backdrop/X close; i18n
  `livery_help_*` (zh + en).
- `LiveryCanvas.jsx` — fixed 2048² backing store, **opaque** base (the
  per-aircraft template image, or `DEFAULT_BASE_COLOR = '#ffffff'` when there
  is none), CSS-scaled view. Layout: Photoshop-style **left icon rail** +
  contextual options bar + bottom zoom status bar. Shared `clearBase`/
  `fillBase`/`drawBase(ctx, dataUrl, onDone)` helpers paint the base on mount
  and on **Clear**.
   - Tools `TOOLS`: `select` (`FaArrowPointer`, A), brush (B), eraser (E),
     eyedropper (I), fill (G), line (L), rect (R), ellipse (O), text (T).
     `TOOL_META` advertises the shortcut; rail buttons and letter shortcuts
     both go through `activateTool`, which settles any in-progress gesture
     first (see "Gesture settling" below).
     **Right-click** (any tool) is two-stage: right-button *press*
     (`onCanvasDown` button 2) selects the topmost live object under the
     cursor via `hitObjectAt` (same hit rule as Select — lines get a taller
     band), or — on empty canvas — picks the pixel colour via the shared
     `pickColorAt` (same as the Eyedropper, keeps the active tool); the full
     right-click (*press + release*, `onCanvasContextMenu`) then pins the
     **layer-order menu** on a hit object, or just dismisses the menu on
     empty canvas.
  - Options bar (`TOOLS_WITH_OPTIONS`; select/eyedropper have none of their own
    — but Select **does** render the text options while a text object is
    selected): brush/eraser size + (brush only) opacity + hard/soft; fill
    tolerance; line/rect/ellipse width + fill toggle; text font (`FONT_OPTIONS`)
    + size + bold/italic (bound to `shownText`, applying to the selected text
    object in Select mode). Colour lives on the rail (`lp-rail-color`).
  - Zoom ladder `ZOOM_STEPS` (0.125…2) with +/- buttons + Fit. Mouse-wheel
    steps the ladder **anchored to the cursor**: the wheel handler records the
    content point under the pointer (`cx/cy` = `scrollLeft + viewport offset`,
    `k` = next/cur) into `zoomAnchorRef`, and a `useLayoutEffect` on `[zoom]`
    re-applies `scrollLeft = cx*k - vx` after the new size is rendered (a plain
    rAF could race the DOM update). Brush/eraser draw a true-size cursor ring
    (`lp-cursor-ring`).
  - **Pan:** middle-drag or hold **Space** (`spaceRef`; mirrored to
    `spaceHeld` state) and drag the wrap. While Space is held the canvas cursor
    is hidden and a **hand icon** (`FaRegHandPaper`, `.lp-hand-cursor`,
    position:fixed) follows the pointer via `moveHand`.
  - **Live objects** (`objectsRef`, a stack — every object stays selectable):
    a sticker image (`kind:'sticker'`, `img`), a **text box** (`kind:'text'` —
    `text`, `font`, `size`, `bold`, `italic`, `color`), or a **shape**
    (`kind:'line'|'rect'|'ellipse'` — `color`, `width`, `filled`, `opacity`;
    centred on the bounding box, a line's `w` is its length / `h` its thickness
    / `rot` its angle, built by `makeShapeObject`). Each carries a unique `id`;
    the active one is `selIdRef` (selection is id-based, not a `selected` flag).
    Drawing a shape with the Line/Rect/Ellipse tool commits it as a selected
    live object (`commitShape`, ignores a zero-drag click) and keeps the shape
    tool active so several can be drawn in a row — no rasterisation, and the
    previously drawn shapes are **not** flattened (the topmost object under the
    cursor wins a Select-tool hit test). Import a sticker via
    `selectLiveryImage`/`readDiskImage` from the rail or `importSticker()`;
    commit text by clicking with the Text tool and typing — the draft is
    committed (announced same as Enter) on **Enter, the input losing focus
    (clicking away), switching tools (rail or keyboard), or clicking elsewhere
    on the canvas**; only Escape cancels. It is **not rasterised** but becomes
    a live object (the clicked point is the box's top-left; dimensions from
    `measureLiveText`). The draft + anchor are mirrored in refs
    (`textDraftRef`/`textAnchorRef`) so those handlers read fresh values;
    `commitText()` itself never changes the active tool (Enter/blur → Select,
    tool switch → the picked tool, canvas click → stays on Text). With the Select
    tool: click an object to select/move it, drag handles to scale/rotate (a
    text box scales its `size` with the frame), Escape / click-away to deselect,
    `Delete`/`Backspace` to remove the selected object. **Selecting a text box
    re-exposes the text options** (font/size/bold/italic) and edits that object
    in place via `applyTextOpt` (box re-measured, no new object); **double-click
    or Enter re-opens the inline editor prefilled** (`startTextEdit` sets
    `editingIdRef`; `commitText` then updates that object's content instead of
    adding a new one). The rail also has
    **Flip Horizontal / Flip Vertical** buttons (`livery_paint_flip_h`/`_v`,
    `LuFlipHorizontal`/`LuFlipVertical`, disabled without any object) →
    `flipSticker('flipX'|'flipY')` toggles the `flipX`/`flipY` flags on the
    selected (else last) object; every overlay/duplicate/export path funnels
    through `paintLiveObject` (`ctx.save(); translate; rotate;
    scale(flipX ? -1 : 1, flipY ? -1 : 1); drawImage|fillText; restore`). Ref
     methods `importSticker`/`removeSticker`/`duplicateSticker` (+
     `getObjectCount` for tests); duplicate stamps the target object onto the
     base (transform included) and leaves a nudged copy selected, while the other
     objects stay live. Only `exportPNG()` returns the flattened texture (base +
     every live object).
   - **Layer order** (`orderMenu` state + `orderMenuRef`, `hitObjectAt`,
     `reorderObject`, pure `reorderObjects(objs, id, dir)`): right-clicking a
     movable object pins a 4-item menu at the cursor (`lp-order-menu` +
     transparent `lp-order-backdrop`; `FaAnglesUp`/`FaAngleUp`/`FaAngleDown`/
     `FaAnglesDown`, i18n `livery_paint_to_front`/`_forward`/`_backward`/
     `_to_back` = 置顶/上移一层/下移一层/置底) with the at-an-end moves
     disabled (a lone object disables all four). `reorderObjects` moves inside
     the bottom→top stack (`front` = to the top end, `forward`/`backward` =
     one step, `back` = to the bottom start; out-of-range ids and no-op moves
     return the input array untouched). `reorderObject` snapshots for undo,
     keeps the moved object selected and closes the menu. Ref methods
     `reorderObject` + `getObjectIds` (for tests). The menu closes on: picking
     a move, left-click, right-click on empty canvas, backdrop pointerdown,
     `Escape` (handled before deselect), `removeSticker`, or any tool/undo/
     redo shortcut (via settling). `Delete`/`Backspace` = `removeSticker()`
     (selected object, else the topmost — no selection required).
   - **Gesture settling (keyboard parity):** a toolbar click can never land
     mid-gesture (pointer capture forces release first) but a shortcut can, so
     `settleGesture()` ends a stroke, commits a shape preview (`commitShape`),
     ends an object drag, commits the text draft and dismisses the order menu
     exactly as releasing the pointer would — and `activateTool` (rail buttons
     + letter shortcuts) / `doUndo` / `doRedo` all call it first, so shortcuts
     act on a stable canvas identically to clicking the matching button.
  - Undo/redo via `createUndoStack`/`pushSnapshot` (cap `MAX_UNDO = 20`
    `{img, objects, selId}` snapshots — the base raster **and** the live-object
    layer, so undo also removes/re-instates objects). **Clear**
    (`AiOutlineClear`, `react-icons/ai`) opens a
    confirm modal and re-paints the base via
    `drawBase(ctx, defaultLiveryRef.current || initialImageDataUrl)` — always
    the **selected aircraft type's built-in default livery**, even when editing
    a saved livery / reference / imported image; falls back to the neutral fill
    only when the type template is unavailable. The `defaultLiveryDataUrl` prop
    is mirrored into `defaultLiveryRef` so the modal closure reads the latest
    value. Unsaved flag via
    `onDirty`.
- Display names: `airlineDisplayName(code, lang)` +
  `AIRLINE_CODE_TO_NAMES` live in `src/utils/constants/airlines.js`
  (derived from `AIRLINE_CODE_MAP`; CJK name picked for `zh`, otherwise the
  English name; unknown codes return the raw code).

## Aircraft template (per-type painter background)

A livery PNG is a straight **1:1 square UV atlas** applied to the mesh's
`BaseMap` slot — the manifest's `parts[].partName` (`Body`, or `Fuselage`/
`Wing`/`Wingtip` for multi-mesh aircraft) binds each texture file to a part.
The game ships the neutral default livery for **every** type under
`GroundATC_Data/StreamingAssets/BuiltInAircraftLivery/AircraftDefaultLivery/
<PLANE_ID>/` (`base[_Part].dds` = BaseMap, DXT1/BC1, 2048² — C919 is 4096²;
plus `mask.dds` DXT5, `lit.dds` DXT1, `coat.dds` BC4U). That default IS the UV
template, so the painter uses it as the per-aircraft background instead of
being transparent, and as the target of the **Clear** button for every livery
(new, saved, reference or imported). **The shipped DDS BaseMaps are stored
bottom-up** — a raw decode is vertically mirrored from the PNG orientation the
engine and the community livery packs use (verified: `Mods/AC27 Realistic
Aircraft Livery/<TYPE>_<AIRLINE>/base.png` is a clean vertical flip of the
matching built-in `base.dds`), so the painter using the raw decode painted the
atlas upside down. `ddsToPngDataUrl` therefore flips Y; `decodeDds` itself
stays a raw decoder. `electron/dds.js` (pure, no deps) decodes the BaseMap
(`decodeDds` DXT1/DXT5/DXT3 → RGBA, `encodePng` minimal RGBA8 encoder) and
`electron/livery.js:readAircraftTemplate(gameRoot, planeId)` picks the
`Body`→`Fuselage`→first part, returns a PNG data-URL (`{success, imageDataUrl,
partName}`), caches successes per plane id, and reports `NO_TEMPLATE` when the
type has no built-in folder. A PNG base file is returned verbatim (no flip —
packs already ship the engine orientation). Multi-part aircraft only seed the
main (Fuselage/Body) canvas — Wing/Wingtip maps are not separately addressable
yet.

## IPC (`electron/livery.js` ← `electron/main.js` handlers ← `electron/preload.js`)

Pure logic in `electron/livery.js` (unit-tested); `main.js` only resolves
gameRoot/dialog/cleanup and delegates. Channels: `list-liveries` →
`{mine, reference}` rows `{folder, id, name, airline, targetPlaneId,
hasBasePng, mtime}` (skip non-dirs; corrupt manifest → row with `error`,
never abort; also creates the own pack dir + repairs `mod_info.json`);
`read-livery-image(folder, pack)` → PNG data-URL;
`get-aircraft-template(planeId)` → the built-in default BaseMap as a PNG
data-URL (`readAircraftTemplate`, see "Aircraft template" above);
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
`BAD_FOLDER` / `BAD_MANIFEST` / `IMAGE_MISSING` / `BAD_ZIP` / `ZIP_MISSING` /
`NO_TEMPLATE` / `BAD_TEMPLATE`
— renderer maps via `livery_err_*` i18n keys. PNG size via IHDR bytes 16–23;
containment via `path.relative`. ZIP via `src/utils/zipUtils.js` (no new deps);
image normalize in renderer canvas (`src/utils/liveryImage.js`, zero new deps);
DDS decode + PNG encode in `electron/dds.js` (zero new deps).
Preload exposes `exportLiveryToDir(folder)`/`getAircraftTemplate(planeId)`
alongside the others; `tests/setup.js` stubs them.

## Image rules (locked)

Base texture is **opaque** — the painter seeds a new canvas with the
per-aircraft built-in template (or a neutral `#ffffff` fill), so a saved
`base.png` never has transparent holes (a BaseMap replaces the model's own
texture). `LiveryCanvas` **Clear** always restores the selected aircraft type's
built-in default livery (`defaultLiveryDataUrl`), falling back to the opened
base image / `DEFAULT_BASE_COLOR` only when that template is unavailable; and
`normalizeToTexture(dataUrl)` fills white by default. Shrink-to-fit inside
2048², aspect preserved, centered; smaller images as-is (never upscale). Main
only writes bytes + checks IHDR.
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
  repair, existing own file untouched, UTF-8 zh name round-trip,
  `readAircraftTemplate` guards + DXT1→PNG decode + part preference + PNG/JPEG
  base passthrough + `parts[0]` fallback + no-parts/parse-error paths + cache),
  `tests/electron/dds.test.js` (`decodeDds` DXT1 block / DXT5 alpha + colour /
  DXT3 4-bit alpha / 1/3+2/3 blend when c0>c1 / transparent-black mode when
  c0<=c1 / bad magic / unsupported fourCC / truncated payload / dimension
  guards, `encodePng` IHDR + IDAT round-trip, `ddsToPngDataUrl` DXT1 + DXT5
  pixel round-trip + the Y-flip that matches the in-game BaseMap orientation).
- `tests/components/LiveryScreen/` (header actions/back/install overlay/search,
  in-card checkbox select driving the header Export/Delete commands + their
  disabled-until-selected states, single vs batch delete confirms, painter
  validation + save/save-as dialogs, Save As overwrite confirm (collision →
  prompt, Overwrite saves, Cancel aborts, fresh name + own-folder re-save skip
  it), post-save mod-enable hint (flag read/write, checkbox persistence,
  hidden once dismissed), free-form folder name, load-from-ZIP,
   import image, cancel, mine vs reference origin save rules, canvas
   tools/stroke/text/sticker/save payload with stubbed 2d context,
   right-click layer-order menu (`reorderObjects` pure moves + menu open/
   reorder/close/dismiss paths + disabled end states + right-press select +
   selection-less Delete + shortcut settling) and keyboard-parity gesture
   settling (shortcut commits a mid-drag shape).
- In-game acceptance (manual): create via UI → launch game → livery on model
  (validates the own-pack-dir assumption).

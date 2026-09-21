# Livery Editor — subskill reference

Custom aircraft livery page (`Body`/`Fuselage`/`BaseMap`/`base.png`) plus the legacy
realistic-pack installer. Screens: browser header **Livery** button →
`screen === 'livery'` (`src/App.jsx` `ScreenRouter` + `UpdateOverlay` wrapper).
Two views (`mine` list / `create` painter, local `useState`, **no tab bar**):
the list view has a single header bar (LHS: Back, Help `?`, Pack; RHS: New,
Select All / Deselect All, Export, Upload, Delete, Find); the painter view hides the
header and has its own top bar. The help overlay is **page-scoped** — each view
documents only its own buttons — and both pages end with the post-save
mod-enable warning as a highlighted tip (`#livery-help-tip`). `Ctrl+F` focuses
the list Find input (ignored while typing, with a modal open, or on the
painter page).

## On-disk format

- Own pack: `<gameRoot>/Mods/AC27 Custom Liveries/` (created if missing;
  constant `OWN_PACK` in `electron/livery.js`, `OWN_PACK_NAME` in
  `src/utils/constants/livery.js`). Never write into
  `AC27 Realistic Aircraft Livery` (read-only reference). The list exposes
  **three sources** — `mine` (own pack), `reference` (the realistic pack) and
  `workshop` (Steam Workshop, read-only); every `read-livery-*` channel takes a
  `pack` argument (`'mine'` default / `'reference'` / `'workshop'`) resolved by
  `_packDir(gameRoot, pack)`.
- **Steam Workshop liveries (best-effort discovery):**
  `workshopContentDir(gameRoot)` walks up ≤6 ancestors of the game root looking
  for a sibling `workshop/content` (the
  `<SteamLibrary>/steamapps/workshop/content` layout — `../../workshop` from
  `<steamapps>/common/<game>`), returning `null` on a non-Steam install
  (dev/portable/other stores). `listWorkshopLiveries(gameRoot)` scans
  `<content>/<appid>/<publishedfileid>/` for any directory holding an
  `aircraft_livery_manifest.json` (depth-bounded 4, `AircraftDefaultLivery`
  skipped; the item root may itself be a livery or a pack wrapper
  `Mods/<pack>/<livery>`), returning the same row shape as `listPackDir` but
  with `folder` as the '/'-joined path **relative to the content root**
  (e.g. `3328490/123456789/A20N_CCA`) so the containment-checked read helpers
  resolve it directly. A 10s `_workshopListCache` (keyed by content dir) keeps
  the whole-tree walk off repeated list refreshes. Workshop rows are
  **read-only** in the UI — `CreateTab` treats `pack:'workshop'` like reference
  (`isReadOnly`; Save/Delete disabled, Save As only) with a Steam badge
  (`FaSteam`) and `livery_tip_readonly_workshop`.
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
- One livery = one folder under the pack dir containing
  `aircraft_livery_manifest.json` + one or more BaseMap images. Single-part
  types ship `base.png` (2048×2048); **multi-image types (A388/B38M) ship one
  file per painted panel** — `base_Fuselage.png` + `base_Wing.png` (A380) /
  `base_Wingtip.png` (737 MAX) — and each paintable base must bind to the part
  name the aircraft's built-in default uses (`Fuselage`, not `Body`) or the
  game ignores the texture. The editor derives the file names from the built-in
  part names (`baseFileName(partName, total)` — `base.png` when there is one
  panel) and writes a `parts` entry per panel; a stale `base.png` left by an
  older single-image save is removed on the next multi-panel save. The **folder
  name is an opaque storage key** — the app never parses meaning out of it (it
  is free-form,
  filesystem-safe only) and the game reads the manifest instead.
  `readLiveryImage`/`listLiveries` resolve the image through the manifest
  (`_resolveLiveryImagePath`: the main part's BaseMap first, then any other
  part's BaseMap, then a legacy `base.png`), so a folder with no fixed
  `base.png` still previews; the data-URL MIME follows the file extension
  (PNG/JPEG). `exportLivery` includes **every** image in the folder, so a
  multi-part livery shares/round-trips as a whole.
- Manifest template:
  `{id: "<sanitized-folder>_default", name: "<SHORT> <AIRLINE> Default Livery",
  airline, targetPlaneId, liveryType: "airline", liverySource: "user",
  targetModelVer: "<built-in ver>",
  parts: [{partName: "<main part>", textures: [{property: "BaseMap",
  fileName: "base.png"}]}]}` — builder `buildManifest({..., partName,
  targetModelVer})` in both
  `src/utils/constants/livery.js` (ESM) and `electron/livery.js` (CJS, keep in sync).
  `targetModelVer` must match the aircraft's built-in default manifest or the
  game flags the livery as broken — the C919 model bumped `1→2` while every
  other type is still `1`. `createLivery` resolves it via
  `_builtInTargetModelVer(gameRoot, planeId)` (single reader
  `_readBuiltInManifest` shared with `_builtInMainPartName`; missing/
  unreadable/corrupt manifest, missing/`''` version, or a numeric version all
  normalize — fallback `'1'`, otherwise `String(v)`); the renderer copy just
  carries the explicit value through (default `'1'`). Deliberately never copies
  `variant` — no built-in manifest carries one. `createLivery` passes
  `_builtInMainPartName(gameRoot, planeId)` — the built-in
  default's `Body`/`Fuselage` part (the `_pickMainPartRef` Body→Fuselage→first
  order, `Body` as the fallback when there is no built-in folder) — so a custom
  A388/B38M livery binds to the mesh the game actually reads; the stored file
  name stays `base.png` (the editor's own container), only `partName` must match.
  `loadLiveryZip` previews the same main-part BaseMap file (not `parts[0]`) and
  derives the `shortCode` from `manifest.targetPlaneId`.
  `id` is derived by lowercasing the folder and collapsing non-alphanumerics
  to `_` (so a conventional `A20N_CCA` still yields `a20n_cca_default`, and a
  free-form `My First Livery 01` yields `my_first_livery_01_default`).
- **Workshop bookkeeping files (dot-files, never mod content):** an uploaded
  livery's folder also carries `.workshop.json` (the sidecar — records
  `publishedFileId`, `url`, title/description/visibility/tags, the saved
  preview file name, `lastUploadedAt`) and `.workshop-preview.<png|jpg>` (the
  exact image the Workshop item was published with, so repeat uploads reuse
  it). Both are skipped by the share ZIP, the `createLivery` image cleanup and
  the Workshop content packer; neither is counted as a texture.

## Short-code table (hardcoded, 20 rows — no scan, no cache)

`SHORT_CODE_TO_PLANE_ID` (+ reverse `PLANE_ID_TO_SHORT_CODE`): `A19N→AIRBUS A-319neo`, `A20N→AIRBUS A-320neo`,
`A21N→AIRBUS A-321neo`, `A319→AIRBUS A-319ceo`, `A320→AIRBUS A-320ceo`,
`A333→AIRBUS A-330-300`, `A359→AIRBUS A-350-900`, `A388→AIRBUS A-380-800`,
`B38M→BOEING 737 MAX 8`, `B738→BOEING 737-800`, `B748→BOEING 747-8I`,
`B77W→BOEING 777-300ER`, `B789→BOEING 787-9`, `CRJ7→BOMBARDIER CRJ700`,
`CRJ9→BOMBARDIER CRJ900`, `C750→CESSNA CITATION X`, `C919→COMAC C-919`,
`E170→EMBRAER E-JET 170`, `E190→EMBRAER E-JET 190`, `GLF6→GULFSTREAM 650`.
The short code is **only a display/default-name convenience derived from
`targetPlaneId`** — never parsed from a folder name. `TEXTURE_SIZE = 2048`;
`folderFor(planeId, airline)` maps the plane id back to its short code and
builds the conventional `{SHORT}_{AIRLINE}` default shown as the Save As
prefill (unknown plane ids fall back to the raw id).

## Aircraft-type dropdown (scanned, not the table)

The painter's aircraft `<select>` is compiled from the game's **built-in
default liveries** — `list-aircraft-types` → `livery.listAircraftTypes(gameRoot)`
scans `<gameRoot>/GroundATC_Data/StreamingAssets/BuiltInAircraftLivery/AircraftDefaultLivery/`
and returns `{ types: [{ planeId, shortCode }] }` for every subdirectory that
carries an `aircraft_livery_manifest.json` (the folder name IS the game's plane
id; `shortCode` comes from the table, `''` for an unknown type). A type is
accepted by `createLivery`/`readAircraftTemplate` when it is in the table **or**
has a built-in folder, so game updates that add aircraft show up without an
editor change; the hardcoded table keys are the renderer fallback when the scan
is unavailable, and an unknown-but-installed type falls back to an
alphanumeric code derived from its plane id for the manifest name.

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
   (`IoSearchOutline`, `searchRef`; a list-page `Ctrl+F`/`Cmd+F` keydown
   listener focuses it unless typing, a modal is open, or the painter tab is
   active). `LiveryHelpOverlay` gets
   `page={isCreate ? 'painter' : 'list'}`. Header bar state
  (`{mineCount, selectedCount, allSelected, oneSelected}`) + commands are
  published by `MyLiveriesTab` through `onBarState` / `mineCmdRef`
  (`toggleSelectAll`/`exportSelected`/`deleteSelected`). Unsaved-painter guard: `CreateTab`
  registers `window.__liveryPaintGuard = { isDirty() }`; Back/Create call
  `guardLeave` and prompt via `useAppStore.showModal`. `CreateTab.prefill`
  holds the clicked row (or null) — `onEdit(row)` for a card; `onCreate(planeId)`
  (the per-aircraft **add-livery card**) sets `prefill = { targetPlaneId }` with
  no folder, i.e. a brand-new livery with that type pre-selected. The create
  `key` includes `{folder, pack, targetPlaneId}` so switching origins (or types)
  remounts the painter.
- `MyLiveriesTab.jsx` — `listLiveries` on mount; own + reference + **workshop**
  merged into one folder set grouped by aircraft type (collapsible sections;
  header = plane id + count badge; unknown `targetPlaneId` sorts last).
  Reference rows share the folders with a lock read-only mark (`IoLockClosed`,
  `livery_tip_readonly`) and **workshop rows** with a Steam badge
  (`FaSteam` + `livery_workshop_badge`, tooltip `livery_tip_readonly_workshop`);
  thumbnail keys are `pack + ':' + folder`, so a workshop folder's
  '/'-joined relative path is the key verbatim. Cards are **clickable to open
  the painter** for all three packs (`onEdit({...row, pack, imageDataUrl})`,
  also Enter/Space; clicks on
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
  `livery_empty_mine`). Thumbnails load lazily from the **low-res
  `read-livery-thumbnail` channel** (a ~256px JPEG, ≈20KB vs several MB) — never
  the full 2048×2048 texture — for the currently-expanded, search-filtered rows
  only, 4 at a time; a `fetchedRef` Set tracks keys (never a mirror of the
  state object, which would mutate state in place and swallow the functional
  updater). If the channel is missing/rejects (main/preload predating it — Vite
  HMR only swaps the renderer) it falls back to `readLiveryImage`, and the whole
  run is discarded on search change (`cancelled`). `.livery-thumb` reserves a
  2:1 box up front with a **shimmer skeleton** (`:not(:has(img))` gradient,
  `livery-thumb-shimmer`) so a loading card never reads as a broken black box,
  then the `<img>` fades in on load. Cards open the painter with
  `imageDataUrl: null` — the 256px preview is never paintable, so `CreateTab`
  lazy-loads the full texture itself. It also calls `listAircraftTypes()`
  (best-effort) to
  build the **full folder set**: the union of every scanned aircraft type and
  every type present in the rows, so a type with **zero liveries** still gets a
  collapsible group (count `0 liveries`). Each group's grid ends with an
  **add-livery card** (`MdAdd`, `.livery-add-card`; i18n `livery_add_livery` /
  `livery_tip_add_for_type`) wired to `onCreate(planeId)`, falling back to
  `onEdit({ targetPlaneId })` when no `onCreate` is passed — opening a new-livery
  painter with that type pre-selected (see `LiveryScreen`/`CreateTab`). The
  unknown `''` type gets no add card. Under an active search an otherwise-empty
  folder is kept only when its type name matches the query (so the placeholder
  still shows for a no-match search). Renders `TooltipPortal`.
- `CreateTab.jsx` — the **painter page** (default export
  takes `{ onCreated, onCancel, onHelp }`). Given `CreateTab.prefill` it
  snapshots an `origin` `{folder, airline, planeId, pack, imageDataUrl}` with
  `pack` `'mine'` / `'reference'` / `'workshop'`; a `prefill` with **no folder but a
  `targetPlaneId`** (the add-card) leaves `origin` null and initialises the
  brand-new form with that type pre-selected — `knownPlanes` also accepts
  `prefill.targetPlaneId`, so the form is valid even when the built-in scan
  misses the type. The painter is **panel-based**: `panels` is derived from the
  selected type's built-in BaseMap parts (A388 → Fuselage + Wing, B38M →
  Fuselage + Wingtip, everything else one `Body` panel), and the canvas receives
  `panels`/`initialParts`/`defaultParts`/`activePanel`/`onActivePanel`. The
  canvas starts primed with the origin'**s own `parts` (the list passes no
  pixels, so it lazy-loads `readLiveryImages` — falling back to the single
  `readLiveryImage`); each panel falls back to the built-in UV template. A
  prefill that does carry pixels (`imageDataUrl`) seeds the primary panel. The
  selected type's **built-in UV template** (see "Aircraft template" below) is
  fetched whenever a type is known — **including when editing a saved livery**
  — held in `templates` and passed as `defaultParts` (what **Clear** restores).
  The canvas is only remounted (`canvasKey` + `panelSig` in the `key`) when the
  panel layout changes or the canvas is still **untouched** (`dirtyRef`); a
  painted canvas keeps its pixels when only the form's Airline/Aircraft changes.
  **Import image** targets the **active panel** (`overrides[panels[activeIdx]]`),
  so a square import replaces one part and a wide canvas can still be split per
  panel. The airline combobox is
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
  **read-only origin** (reference **or workshop**, `isReadOnly =
  isReference || isWorkshop`) both the airline input (+ its toggle) and the
  type `<select>` are `disabled` and greyed (`.lp-locked`) — the pair is
  display-only, and Save As reuses it. Actions:
  - **Open folder** (`FaRegFolderOpen`, first in the RHS group, left of Import
    image) → `reveal-livery-folder(origin.folder, origin.pack)` opens the
    livery folder in the OS file explorer. A saved livery (mine/reference/
    workshop) reveals its own folder; a brand-new unsaved livery passes `null`
    and the backend falls back to the own pack dir. Failure toasts the mapped
    `livery_err_*` (or `livery_open_folder_failed` for an OS error string).
  - **Import image** (`IoImageOutline`) → `fileToDataUrl` + `normalizeToTexture`
    (default white fill) → replaces the **active panel**'s base only.
  - **Import livery** (`FaFileImport`) → `loadLiveryZip` → normalize **each**
    BaseMap part (`parts`) + prime airline/planeId from the manifest.
  - **Export livery** (`FaFileExport`) → writes the canvas via `createLivery`
    then `exportLiveryToDir` (directory picker; cancel leaves the saved
    livery, success `livery_exported` with `<folder>.zip`).
  - **Delete** (`IoTrashOutline`, tooltip `livery_tip_delete` — or
    `livery_tip_readonly`/`livery_tip_readonly_workshop` for a read-only
    origin) → confirm (`Confirm Delete` /
    `livery_delete_confirm_body`) then `delete-livery`; disabled without an
    origin folder (brand-new livery) and for a reference/workshop origin.
  - **Save** (`IoSaveOutline`, disabled for a read-only origin) → naming dialog whose
    default name follows the live form: while Airline/Aircraft still match the
    origin it stays the origin folder (in-place overwrite, free-form name
    preserved); once either changed it prefills the new conventional
    `{TYPE}_{AIRLINE}` folder, and the live form airline/aircraft always feed
    the manifest (so a change updates `airline`/`targetPlaneId`/`name`). The
    user can retype the origin folder to update that livery in place.
  - **Save As** (`MdSaveAs`) → naming dialog prefilled with the conventional
    form folder, uses the live form airline/aircraft.
  **Keyboard**: `Ctrl+S` = Save, `Ctrl+Shift+S` = Save As (a `CreateTab`
  keydown listener; ignored while typing or while any modal is open).
  Save/Save As share `SaveNameDialog` (typed name = folder verbatim,
  `LIVERY_FOLDER_SAFE_RE` gated, buttons inside the modal body). On confirm,
  `confirmOverride(folder, isSaveAs, proceed)` checks `listLiveries()` for a
  `mine` folder with that name (case-insensitive — Windows paths): a collision
  pops an **Overwrite** confirm (`livery_override_title`/`_body`,
  Cancel/`modal_btn_overwrite`). Only plain **Save** re-writing the current
  livery's own origin folder is exempt — **Save As always asks**, including
  when its prefill equals the origin folder; fresh names save straight through
  and an unreadable list falls through. Both then
  funnel through `submitCreate(canvasRef.current.exportParts(), airline,
  planeId, folder)` → `createLivery({images})` → toast. **Save / Save As stay in
  the painter** — success does **not** call `onCreated` (no navigation); instead
  `CreateTab.prefill` is set to the saved `{folder, airline, targetPlaneId,
  pack:'mine'}` so the saved livery becomes the current origin (a later Save
  overwrites it in place) and the origin-images effect reloads the saved panels.
  `exportParts()` returns one `{partName, imageDataUrl}` per panel; a
  single-panel type yields a one-entry `Body` list → `base.png`. On success it also fires
  `showModHint()`: unless the `liveryModHintDismissed` cache flag is set
  (`get-cache-flag`), it opens the **Enable the Mod in Game** prompt
  (`livery_mod_hint_title`/`_body`, OK = `modal_btn_ok`) telling the user to
  enable **AC27 Custom Liveries** on the in-game "More Liveries" page — plus,
  when a new livery does not show, to bring its priority to the top on the
  "Livery Mod" page and click "Refresh list" — with a
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
   duplicate/remove-sticker chips, are not listed. Both pages end with the
   post-save mod-enable warning as a highlighted tip (`#livery-help-tip`,
   `livery_mod_hint_title`/`_body`). Escape/backdrop/X close; i18n
   `livery_help_*` (zh + en).
- `LiveryCanvas.jsx` — **N-panel** backing store: one 2048² panel per
  `panels` entry (multi-image A388/B38M → 2 panels), laid out horizontally
  with a `PANEL_GAP` (128px) `GAP_FILL` gutter, so the store is
  `N*2048 + (N-1)*128` × 2048 (`panelLayout(n)`), **opaque** base (each
  panel's image, or `DEFAULT_BASE_COLOR = '#ffffff'` when there is none),
  CSS-scaled view. Layout: Photoshop-style **left icon rail** + contextual
  options bar + bottom zoom status bar (**no panel tab strip** — see "Active
  panel by click" below). The active panel is highlighted on the overlay (blue
  outline; dividers around every panel). Shared `fillPanelBases(ctx,
  layout)`/`drawBase(ctx, layout, parts, onDone)` helpers paint every panel on
  mount and on **Clear** (all panels reset to `defaultParts`). `exportParts()`
  returns one 2048² PNG `{partName, imageDataUrl}` per panel (the `CreateTab`
  save payload); `exportPNG()` still returns the whole wide flattened texture.
  The mask, scratch, stroke and undo canvases are all `W×H`
  (the wide store), and pointer→texture mapping divides by `W`/`H`.
  - **Five stacked layers (`data-layer`)**: `base` (locked aircraft image,
    `baseCanvasRef`, opaque, painted only by `drawBase`) → `fill`
    (`fillCanvasRef`/`fillCtxRef`, the flood-fill underlay, BELOW every
    movable) → `objects` (live
    movables, `objectCanvasRef`) → `paint` (`canvasRef`/`ctxRef`, the pen:
    brush/eraser) → `chrome` (`overlayRef`, padded, selection outline +
    handles + previews). The pen layer draws ABOVE the movables while the fill
    sits UNDER them, both `pointer-events:none`; the chrome layer is the pointer
    surface. This is what
    makes the pen "always on top" of movables while they stay live and movable —
    no baking. Export/`pickColorAt`/`applyWandAt` composite base → fill →
    objects → paint.
  - **Padded chrome overlay + interaction surface (`OVERLAY_PAD = 256`)**: the
    chrome canvas is `(W+2·PAD)×(H+2·PAD)`, absolutely positioned at `-PAD*zoom`
    so it spills around the base bitmap, and `drawOverlay` clears the padded
    bitmap then draws with `setTransform(1,0,0,1,PAD,PAD)` (panel dividers use the
    same offset; `paintErasePreview` takes `ox/oy`). The chrome layer is the
    **pointer interaction surface**, so a live object's **selection box +
    scale/rotate knobs stay grabbable and a scale/rotate drag keeps registering
    outside the 2048 square** (pointer capture stays on the chrome canvas).
  - **Active panel by click**: there is no tab strip. A **left click anywhere in
    a panel** (`panelIndexAt(p.x)`; nearest panel in the gutter) makes it the
    active panel for every tool — and **keyboard shortcuts never change it**.
    `onActivePanel(idx)` is only called from the canvas pointerdown path, and
    the same click **also performs the active tool** on the panel it lands in
    (the handler does not return after switching), so painting a second panel is
    one click, not switch-then-paint. A no-drag brush release deposits one dab
    (see "Brush strokes" below) so the panel-switch click paints too.
    `activeRef` mirrors `active` and is written **synchronously** in that
    pointerdown, because the React `active` state update is async: the wand,
    fill and lasso read `activeRef.current` (their panel bound + `clipActivePanel`)
    so a single press in another panel targets the panel just clicked instead of
    the previous one (regression: wand must clip to `x=2176` on the first press
    into panel 1).
  - **Per-object panel clip (multi-image only, overlay AND export)**: each live
    object carries a persisted **`panel`** and renders/saves clipped to it via
    `paintObjectInPanel` → `layout.x(objectPanel(o))` in `drawOverlay`,
    `flattenToCanvas`, the wand sample and the eyedropper sample. The panel is
    **chosen by the pointer while dragging**: `onCanvasMove` writes
    `panel: panelIndexAt(p.x)` on every move of a `move` drag, so a big sticker
    grabbed by its edge follows the cursor into the next panel **before its own
    centre crosses the gutter** (so it never vanishes at the edge waiting for the
    centre to catch up). The panel
    is stored on the object at drop, so it is also the one it exports in (an
    object created without one falls back to the panel its centre is in —
    `objectPanel` clamps to the current panel count, so a later layout change
    cannot strand it). So an **unselected movable on another panel is still
    visible** and a sticker always saves into its own panel; a save can never
    move/lose it by active-panel state. Overflow past the object's own panel is
    not displayed (nor sampled by wand/eyedropper). The active panel only governs
    **placement** (sticker drop, import target), the blue outline, and where a
    newly committed object lands — not what is shown. Movement is **not
    bounded**: an object can be dragged across panels. Single-panel types have no
    clip (the base bitmap clips the pixels).
  - **Export uses the same per-object clip** (`flattenToCanvas`, used by Save /
    Save As / `exportPNG`): never the active panel. (Regression: `exportParts()`
    must clip to panel 1's rect, `x=2176`, while the active panel is 0 — and a
    movable dropped into panel 1 by the pointer must export there even when its
    centre is still in panel 0.) The
    imperative handle deps include `active`/`panelCount` so its closures are
    never stale.
   - Tools `TOOLS`: `select` (`FaArrowPointer`, A), brush (B), eraser (E),
     eyedropper (no shortcut — right-click picks), fill (G), line (U), rect (R),
     ellipse (M), text (T). `TOOL_META` advertises the shortcut; rail buttons and
     letter shortcuts both go through `activateTool`, which settles any
     in-progress gesture first (see "Gesture settling" below). **A / L / W are
     global Select sub-mode keys** (Object / Lasso / Magic Wand): pressed from
     any tool they switch to Select first (e.g. from the brush, `L` jumps to
     Lasso) — which is why Line moved to `U`. The rail **Import
     Sticker** button is `I` (`ACTION_KEYS.importSticker`); the Selection Pen
     sub-mode uses `LuLasso`.
     **Right-click** is two-stage and tool-gated: right-button *press*
     (`onCanvasDown` button 2) arms the movable's layer-order target **only in
     the Select tool's object sub-mode** — it selects the topmost live object
     under the cursor via `hitObjectAt` (same hit rule as Select, lines get a
     taller band) and the matching `onCanvasContextMenu` press+release pins the
     **layer-order menu**. In **every other tool/sub-mode (pen, wand, brush,
     shapes, …)** the right-click instead calls the shared `pickColorAt` (same
     as the Eyedropper, keeps the active tool) and never opens the movable
     menu — so the pen tool's right-click is a colour pick. The
     eyedropper composites the base raster with every live object through a
     lazily-created 1×1 scratch (`pickCanvasRef`/`getPickCanvas`) before reading
     the pixel, so a colour can be picked off **movables** (stickers / shapes /
     text) and not just the base — mirroring the overlay's `paintObjectWithErase`
     (a selection never clips a movable);
     it falls back to the raw base pixel when the composite is empty/transparent
     or there are no objects. Two tools consume the right-button *press*
     themselves: the **Line tool in Curve mode** with a draft pops the last
     control point (a lone point cancels the draft outright), and the **Text
     tool** with an open box commits it exactly like Enter. Both swallow the
     matching `contextmenu` release (`consumeRightRef`) so no order menu /
     colour pick follows.
     **The Line tool has Straight/Curve sub-modes** (`lineMode` state +
     `lineModeRef`, default `straight`): Straight drags out a line (as
     before); Curve appends a control point per click (`curveRef.pts`, hover
     rubber-band from the second point on) and **Enter / double-click commits
     a smooth `makeCurveObject` live object**, keeping the line tool in curve
     mode so several curves can be drawn in a row. Escape cancels the draft;
     a degenerate draft (<2 points) is discarded silently.
   - Options bar (`TOOLS_WITH_OPTIONS`; select/eyedropper have none of their own
     — but Select **does** render the text options while a text object is
     selected): brush/eraser size + (brush only) hard/soft; fill
     tolerance; line/rect/ellipse width + fill toggle (Line also gets a
     Straight/Curve `lp-seg` toggle, `livery_paint_line_mode`/`_straight`/
     `_curve`); text font (`FONT_OPTIONS`)
     + size + bold/italic (bound to `shownText`, applying to the selected text
     object in Select mode). Every slider value is also a typable numeric field
     (`NumberInput` beside the slider, sharing the same clamped state:
     brush/eraser size 1–200, fill/wand tolerance 0–255, shape width 1–200,
     font size 8–400, sticker opacity 0–100 with a `%` suffix; text draft, blur/
     Enter commits, out-of-range clamps, empty/garbage reverts, Escape discards
     the draft, slider follows). Colour lives on the rail (`lp-rail-color`).
  - **RGBA colour picker** (`LiveryColorPicker.jsx`, portal popover anchored to
    the rail swatch's client rect via `openColorPicker` — the rail scrolls and
    would clip an in-flow popover). The native `<input type="color">` dialog is
    opaque to the app and has no alpha channel, so the painter ships its own:
    a saturation/value square (HSV, hue kept in local state so dragging down the
    black edge doesn't reset the hue), a hue rail, an **alpha rail** (current
    colour fading to transparent over a checkerboard) and a hex field
    (`livery_paint_hue`/`_color_area`/`_hex`). The rail swatch is a button
    (`data-color`/`data-alpha` + `aria-expanded`) that toggles the popover;
    backdrop pointerdown, Escape and a second click all close it. Pure colour
    math (`hexToRgb`/`rgbToHex`/`rgbToHsv`/`hsvToRgb`) lives in
    `utils/liveryPaint.js`.
    `brush.opacity` is the single alpha the whole painter reads — `brushRgba(brush)`
    bakes it into the curve/shape previews, the flood fill colour and text
    objects (`opacity` on the live object, applied by `paintLiveObject`).
    **Brush strokes composite through a per-stroke layer** (`strokeLayerRef` +
    pristine `strokeBaseRef`): `beginStroke` clears the layer and copies the
    base, every dab is stroked into the layer **opaque**, and `flushStroke`
    (per pointermove event + at stroke end/settle) restores the dirty rect
    (`strokeBoundsRef`, grown by brush size + shadow spread) from the base copy
    and re-draws the layer with `globalAlpha = brush.opacity`. Drawing dabs
    straight onto the base with `globalAlpha` made consecutive round caps
    overlap (alpha = 1−(1−a)ⁿ), so a translucent brush went nearly opaque on
    any slow drag — the alpha appeared to do nothing. Per-rect flushes are
    idempotent (the base copy is never modified), and `putImageData` stays reserved
    for fills/mask clips. **The fill tool paints the bottom `fill` layer, under
    every movable** (`fillCtxRef`), but the flood region is computed from the
    VISIBLE composite (base → fill → movables → pen), exactly like the wand —
    the fill layer itself is mostly transparent, so flooding it directly always
    saw one uniform colour and filled the whole panel regardless of tolerance.
    `wandRegion` returns scanline spans (tolerance + active-panel bound) and the
    fill layer is rewritten with those spans (a `destination-out` cut then a
    `source-over` paint at the brush alpha), so a fill never lands on top of a
    sticker/shape/text and a later pen stroke still covers it.
    `constrainRastersToMask` clips the fill layer
    against the pre-fill snapshot. **The eraser is not a pen: it only removes.**
    It
    strokes BOTH raster layers (fill underlay + pen) with
    `globalCompositeOperation = 'destination-out'`
    (transparent), so the locked opaque base shows through wherever paint is
    removed — it never paints background-coloured pixels; cutting the pen layer
    alone would leave the fill underlay visible. `applyEraseGesture`
    makes one `destination-out` pass per gesture (deferred to release, only a
    dark preview during the drag) and routes the same trail into every live
    movable's `erase` holes, trimming stickers/shapes transparent in their own
    layer; a Shift-click segment (`drawEraserSegment`) reuses the same pass.
    **A brush click with no drag deposits one dab** (`paintBrushDab` on release
    when `strokeBoundsRef` is still null — a zero-length round-cap stroke, the
    same trick the eraser's single-point trail already used), so a click paints
    a dot instead of needing a micro-drag; `settleGesture` does the same for an
    interrupted stroke.
    **Shift-click straight lines (brush + eraser)**: a plain click deposits its
    dab and drops a `lineAnchorRef` anchor; each **Shift+click** paints a straight segment from
    the previous anchor to the click (brush: one `beginStroke`/`flushStroke`
    pass at the brush alpha; eraser: `applyEraseGesture` with a two-point
    trail) and re-anchors there, so repeated Shift+clicks chain a polyline.
    Each segment is one undo snapshot (`commitSegment`). **`[` / `]`** step the
    shared brush/eraser size by ∓5 (clamped 1–200) while either tool is active.
    **Layers: the pen is always on top, the fill always at the bottom —
    without baking.** Five stacked
    `<canvas>` layers inside `.lp-canvas-stage` (bottom → top):
    `base` (locked aircraft image, `baseCanvasRef`, opaque, `drawBase` only),
    `fill` (`fillCanvasRef`, the flood-fill underlay),
    `objects` (live
    movables, `objectCanvasRef`), `paint` (`canvasRef`/`ctxRef`, the pen:
    brush/eraser), `chrome` (`overlayRef`, padded, selection outline +
    handles + previews + the pointer surface). Both raster layers are `pointer-
    events:none`; the fill draws UNDER the movables and the pen draws ABOVE
    them, so a stroke always covers them while they stay live and movable. UI
    order is pinned by `data-layer` on each
    canvas (tests target
    `[data-layer="fill"|"paint"|"base"|"objects"|"chrome"]`).
    Export/`pickColorAt`/`applyWandAt` composite the same order (base → fill →
    objects → paint). Snapshots carry the pen layer plus a **shared reference**
    to the fill pixels (cached `fillPixelsRef`, invalidated on every fill-layer
    mutation) and to the
    last base pixels (`basePixelsRef`, refreshed when `drawBase` lands), so undo
    restores Clear/import bases and fills without copying a static layer per
    step.
  - Continuous zoom (0.05×…10×, `MIN_ZOOM`/`MAX_ZOOM`) with +/- buttons
    stepping ×1.25 (`ZOOM_STEP`) + Fit. Mouse-wheel zooms smoothly
    (exponential in `deltaY`, `WHEEL_ZOOM_SENSITIVITY`) **anchored to the
    cursor**: the wheel handler records the
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
     it drops at the **active panel's** centre (`layout.x(active) + TEXTURE/2`)
     and the tool **hands over to single-select (`setSelMode('object')` +
     `setTool('select')`)**, so the fresh sticker is selected and immediately
     moveable/scalable no matter which selection sub-mode was active before;
    commit text by clicking with the Text tool and typing — the draft is
    committed (announced same as Enter) on **Enter, the input losing focus
    (clicking away), switching tools (rail or keyboard), or clicking elsewhere
    on the canvas**; only Escape cancels. It is **not rasterised** but becomes
    a live object (the clicked point is the box's top-left; dimensions from
    `measureLiveText`). The draft + anchor are mirrored in refs
    (`textDraftRef`/`textAnchorRef`) so those handlers read fresh values;
    `commitText()` itself never changes the active tool (Enter/blur → Select,
    tool switch → the picked tool, canvas click → stays on Text). With the Select
     tool: click an object to select/move it, drag handles to scale/rotate.
     A corner drag is **free stretch by default** (each axis follows the pointer
     so `w`/`h` move independently) and **aspect-locked while Shift is held**
     (one factor for both axes — the original behaviour). Both scale about the
     object's centre through the pure helpers `objectLocal(o, p)` (translate +
     rotate only, no flip) and `resizeFactors(o, startP, p, shift)` (positive
     factors with a 0.02 floor, so dragging through the centre shrinks instead
     of mirroring). For a **text box** a Shift resize changes its `size` (glyphs
     follow the frame), while a free resize keeps the font and stores a
     per-axis `stretch` (`{sx, sy}`) that `paintLiveObjectContent` applies with
     `ctx.scale` and `measureLiveText(ctx, text, o, stretch)` folds into the
     measured w/h — so the box keeps hugging the glyphs and a later
     font/size/bold change preserves the stretch. Eraser holes and the
     part-erase boundary follow both axes (`scaleErase(k, erase, ky)` /
     `scaleFrame(k, frame, ky)`, the single brush width taking the geometric
     mean). Escape / click-away to deselect,
     `Delete`/`Backspace` to remove the selected object. **The movable chrome
     (blue box + rotate/scale handles + line/curve vertices) draws only in the
     Select tool's Object sub-mode** (`tool==='select' && selMode==='object'`) —
     pen/wand show just their selection outline, which is drawn after every
     movable so it stays on top. **Leaving Object mode cancels the movable
     selection** (`setSelMode` when `v!=='object'`, and `activateTool` when
     switching the tool away from Select while in Object mode), but a pen/wand
     mask selection is deliberately kept. **The Select box +
    handles are always drawn in the UNFLIPPED frame** (`drawOverlay` does
    `translate(x,y) · rotate(rot)` only), and the pointer→frame mapping
    (`stickerLocal` = `objectLocal` = `R(-rot) · (p − o)`) lands in that same frame — so the
    grab zones are exactly the drawn corner (`frame.x1, frame.y1`) and the
    rotate dot (`frame centre, frame.y0 − 40/z`) **regardless of `flipX`/
    `flipY`**. Mirroring those grab points through the flip (the removed
    `flipLocal`) put the hit zones on the opposite corner, so a flipped
    sticker/shape could not be scaled at all and its rotate dot never grabbed.
    Regression: `tests/components/LiveryScreen/LiveryCanvas.test.jsx`
    "live-object handles survive a flip" (sticker scale, shape scale, rotated
     handle grab, all after flipping both axes). **A selected sticker also gets
     an Opacity slider + numeric field on the options bar** (`livery_paint_opacity`, 0–100 with
     a `%` suffix) that writes the object's own `opacity`; `paintLiveObjectContent`'s
    image branch sets `globalAlpha` from it, so the overlay, the **export
    flatten** and a duplicate copy all carry the same alpha (the eraser scratch
    cache signature already includes `opacity`, so holes stay in sync), and 0%
    still keeps the object selectable so the slider can bring it back.
    Regression: "sticker opacity slider" (stores the value, redraws at that
    alpha, flattens at that alpha on export, and is offered only for a
    sticker). **Selecting a text box
    re-exposes the text options** (font/size/bold/italic) and edits that object
    in place via `applyTextOpt` (box re-measured, no new object); **double-click
    re-opens the inline editor prefilled** (`startTextEdit` sets
    `editingIdRef`; `commitText` then updates that object's content instead of
    adding a new one). **`Enter` clears the current selection** (like committing
    a text box) instead of re-opening the editor — the object stays in the stack
    and double-click still re-opens it. The rail also has
    **Flip Horizontal / Flip Vertical** buttons (`livery_paint_flip_h`/`_v`,
    `LuFlipHorizontal`/`LuFlipVertical`, disabled without any object; **`H` / `V`
    are the keyboard shortcuts**, mirrored in the canvas keydown handler; **the
    Duplicate Sticker button is `Ctrl+C`**) →
    `flipSticker('flipX'|'flipY')` toggles the `flipX`/`flipY` flags on the
    selected (else last) object; every overlay/duplicate/export path funnels
     through `paintLiveObject` (`ctx.save(); translate; rotate;
     scale(flipX ? -1 : 1, flipY ? -1 : 1); drawImage|fillText; restore`). Ref
     methods `importSticker`/`removeSticker`/`duplicateSticker` (+
     `getObjectCount` for tests); **`duplicateSticker` is a true copy** — it adds a
     nudged copy (deep-copied `pts`/`erase`) and **keeps the original live and
     selectable**, with nothing stamped onto the (wide) base, so a multi-image
     copy can never bleed into the other panel. Only `exportPNG()` returns the
     flattened texture (base + every live object).
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
     (selected object, else the topmost — no selection required). **All canvas
     shortcuts stay inert while any app modal is open** (save naming /
     overwrite / post-save mod hint): the window keydown handler returns early
     on `modal.open`, so keypresses behind a save popup never deselect, remove
     or mutate the live movable — the selection survives the save.
    - **Gesture settling (keyboard parity):** a toolbar click can never land
      mid-gesture (pointer capture forces release first) but a shortcut can, so
      `settleGesture()` ends a stroke (clipped to the selection first),
      commits a shape preview (`commitShape`), ends an object drag, commits
      the text draft, commits an in-progress lasso (`commitLasso`) and
      dismisses the order menu exactly as releasing the pointer would — and
      `activateTool` (rail buttons + letter shortcuts) / `doUndo` / `doRedo`
      all call it first, so shortcuts act on a stable canvas identically to
      clicking the matching button.
    - **Selection mask** (Select-tool sub-modes `selMode` state + `selModeRef`,
      default `'object'`): the options bar gains an icon-only `lp-seg` mode row
      (`FaArrowPointer`/`TbCircleDotted`/`BsMagic` with tooltips + aria-labels
      `livery_paint_select_object`/`_pen`/`_wand` = 对象/选择画笔/魔棒,
      `livery_paint_select_mode`). The tooltips advertise the sub-mode shortcuts
      via `withKey` (`Object (A)`, `Lasso (L)`, `Magic Wand (W)`); the canvas
      keydown handler maps **A/L/W globally to the sub-modes, switching to the
      Select tool from any other tool** (Line therefore uses `U`). Plus, outside object mode, an icon-only
      combine row (`TbLayersUnion`/`TbLayersDifference`/`TbLayersSelected`,
      `livery_paint_mask_combine`/`_erase`/`_replace` = 合并/擦除/替换,
       `livery_paint_mask_mode`, default combine), a Tolerance slider + numeric
       field reusing `fillTol` in wand mode, and a Deselect button (`livery_paint_deselect`)
      while a selection exists — its tooltip sits on a wrapper with the disabled
      button set to `pointer-events: none`, so it shows even before a selection.
      **Ctrl+D** is the Deselect shortcut in the
      canvas keydown handler (drops the mask first, else clears the selected
      object) — the same action as the button. The mask is a lazily-created `W×H` (whole-store) canvas
      (white-opaque = selected; `getMaskCtx`/`maskCanvasRef`) with a
      dotted-line outline (`maskOutlineRef`: pen → closed path, wand → region
      bounds = the latest region; live lasso draft from `lassoRef`), drawn
      as **tiny, dense round white dots with a hairline black border** at the end
      of `drawOverlay`: `drawDashed` strokes the same path twice with
      `lineCap='round'` and `setLineDash([0, 3/z])` (a zero-length dash + round
      cap = one dot per gap) — a wider black pass (`2/z`) under a narrower white
      pass (`1/z`).
      Pen: down/move/up collects `lassoRef.pts`, release closes
      the path into the mask (`commitLasso` ignores <3 pts / <2px span, same
      rule as curve commits); `Escape` cancels the draft. Wand: `applyWandAt`
      floods the contiguous **visible-colour** region (`wandRegion` spans, fill
      tolerance) sampled from the exact on-screen stack in a dedicated
      `wandCanvasRef` buffer: base image → fill underlay → each movable through
      `paintObjectForDisplay` (so a stamped `clipMask` clips invisible geometry
      out of the sample) → the pen layer on top. So a sticker/shape colour is
      selectable, but **invisible geometry never is**. **The fill tool reuses
      this exact sample** (base → fill → movables → pen) to pick its region, then
      writes only the matched spans into the fill layer — never flooding the
      transparent fill layer itself, which would ignore tolerance and fill the
      whole panel. **Multi-panel confinement:**
      for a multi-image type (`panelCount > 1`) both the lasso fill and the wand
      flood are restricted to the **active panel** — `applyLassoToMask`/
      `applyWandAt` `clipActivePanel(mctx, activeRef.current)` before compositing,
      and
      `wandRegion` takes an inclusive `region` (the active panel rect) that stops
      the flood at the gutter, so a selection can never cross into the
      neighbouring panel. `activeRef` carries the panel just clicked, so a
      single press into another panel runs the wand/fill/lasso there (the
      `active` state update is async). The spans are painted as white `fillRect` runs on a scratch canvas composited with
      `maskPaintOp(mode)` (`combine` = source-over, `erase` = destination-out,
      `replace` = clear first); erasing to empty clears the mask
      (`isMaskEmpty` → `clearMask`). Raster paints clip through
      `constrainRastersToMask()` (stroke end incl. settle, Shift segment, fill),
      which clips BOTH raster layers against the pre-gesture snapshot via
      `constrainLayerToMask`, using pure
      `constrainImageToMask` (mask alpha < 128 reverts to `before`).
      **Selection-stamped movables (`clipMask`)**: `addObject` (and
      `duplicateSticker`) copies the live mask onto a movable created while
      `hasMaskRef.current` is true (`getMaskCopy` — one shared immutable W×H copy
      per mask version, invalidated whenever the mask changes). The object is
      clipped to that **stamped** shape for good (`paintObjectForDisplay` →
      `paintObjectMasked(target, o, o.clipMask)`: object → full-store scratch →
      `destination-in` clip → blit) in the objects layer, `flattenToCanvas` and
      `pickColorAt`. Ctrl+D (or making a new selection) never un-clips or
      re-clips it — a movable added under a selection stays that partial shape
      permanently. A movable placed **before** any selection has no `clipMask`
      and always renders/exports whole (its own eraser holes only). The live mask
      itself is NOT in undo snapshots, the save payload or dirty tracking; Clear
      drops it. The Deselect tooltip advertises its **Ctrl+D** shortcut like the
      rail buttons.
      The visible dashed outline is re-traced from the already-unioned mask
      pixels by `traceMaskBorder(img)` → edge segments, chained into
      continuous loops by `chainBorderSegments(segs)`; each loop renders as
      one subpath so the dot dash runs continuously along it (an unchained dash
      restarts per 1px `moveTo`, which would clump the dots at every segment).
      The traced border is preferred and the vector outline is only a
      readback-unavailable fallback. The whole outline block (border + vector
      fallback + live lasso draft) is drawn **last** in `drawOverlay`, after the
      movables, panel dividers and eraser preview, so the pen/wand region always
      overdraws every other layer.
      **Del with a selection = the marquee eraser** (`eraseSelectionToTransparent`):
      when a mask exists, Delete/Backspace cuts the region out of BOTH raster
      layers (`destination-out` punch, so the locked base shows through —
      nothing is painted over it) and punches the
      same region out of every live movable it touches. The pen layer sits
      above the movables, so opaque restore pixels would bury the sticker holes
      and bake a fake-background ghost that stays behind when the sticker
      moves, so the punch is purely transparent (no fallback — `drawBase`
      always fills every panel opaque). The mask border is
      traced to loops and mapped into each object's **local** frame, stored as
      `erasePolys` (polygon holes filled `evenodd`, so a ring selection keeps
      its middle; scaled by `scaleErasePolys` on resize, deep-copied on
      duplicate). A fully-consumed object is dropped and a part-erased
      rect/ellipse/sticker re-frames, exactly like the eraser tool. With **no**
      selection Delete removes the selected object, else the topmost object).
      Pure core in `utils/liveryPaint.js` (`SELECT_MODES`, `MASK_OPS`,
      `maskPaintOp`, `lassoBounds`, `wandRegion`, `constrainImageToMask`,
      `isMaskEmpty`, `traceMaskBorder`, `chainBorderSegments`); help
      `livery_help_d_select` documents modes/ops/clip.
  - Undo/redo via `createUndoStack`/`pushSnapshot` (cap `MAX_UNDO = 20`
    `{img, objects, selId}` snapshots — the base raster **and** the live-object
    layer, so undo also removes/re-instates objects). **A direct-manipulation
    gesture (move / resize / rotate / vertex drag) is one undo step**:
    `ensureDragSnapshot()` pushes the pre-drag snapshot on the first
    `onCanvasMove` of the drag (guarded by `dragRef.snapshotted`), so Ctrl+Z
    reverts the whole transform — scaling included — in one step. **Clear**
    (`AiOutlineClear`, `react-icons/ai`) opens a
    confirm modal and re-paints **every** panel via `drawBase(ctx,
    layout, clearParts, scheduleOverlay)` where `clearParts` is
    `defaultPartsRef.current` when any panel carries pixels, else
    `initialPartsRef.current` — always the **selected aircraft type's built-in
    default livery**, even when editing a saved livery / reference / imported
    image; falls back to the neutral fill only when the type template is
    unavailable. The `defaultParts`/`initialParts` props are mirrored into
    `defaultPartsRef`/`initialPartsRef` so the modal closure reads the latest
    value. Unsaved flag via
    `onDirty`.
- Display names: `airlineDisplayName(code, lang)` +
  `AIRLINE_CODE_TO_NAMES` live in `src/utils/constants/airlines.js`
  (derived from `AIRLINE_CODE_MAP`; CJK name picked for `zh`, otherwise the
  English name; unknown codes return the raw code).
- `UploadLiveryDialog.jsx` — the Workshop publish modal (`#livery-upload-overlay`,
  rendered by `LiveryScreen` for the single selected `mine` folder). Loads
  `get-workshop-publish-info`, prefills title (localized default when the sidecar
  has none), description, visibility (private default), tags, preview; subscribes
  to `workshop-upload-progress` for the bar; success view links the item URL.
  Submit stays labelled **Upload** (no rename-to-publish), no change-note field,
  no link-ID field; unknown error codes fall back to generic text with the raw
  code + detail beneath; a failed `workshop-debug-info` handshake shows the
  "restart the editor" stale-main banner. Built with `shortAircraftType`
  (`src/utils/constants/livery.js` — drops the manufacturer word, e.g.
  `AIRBUS A-320neo` → `A-320neo`).

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
`electron/livery.js:readAircraftTemplate(gameRoot, planeId)` now returns **every**
paintable BaseMap part in manifest order as `parts: [{partName, fileName,
imageDataUrl}]` (plus the legacy main-part `imageDataUrl`/`partName`, the
`Body`→`Fuselage`→first pick), caches successes per plane id, and reports
`NO_TEMPLATE` when the type has no built-in folder. A PNG base file is returned
verbatim (no flip — packs already ship the engine orientation). The painter
lays out **one 2048² panel per part** (A388 → Fuselage + Wing, B38M → Fuselage
+ Wingtip, everything else one panel), side by side with a 128px gutter
(`PANEL_GAP`), so the secondary map is now separately addressable.

## IPC (`electron/livery.js` ← `electron/main.js` handlers ← `electron/preload.js`)

Pure logic in `electron/livery.js` (unit-tested); `main.js` only resolves
gameRoot/dialog/cleanup and delegates. Channels: `list-liveries` →
`{mine, reference, workshop}` rows `{folder, id, name, airline, targetPlaneId,
hasBasePng, mtime}` (skip non-dirs; corrupt manifest → row with `error`,
never abort; also creates the own pack dir + repairs `mod_info.json`). The
`workshop` rows come from `listWorkshopLiveries` — a non-Steam install yields
`[]` (see "Steam Workshop liveries" above). Every `read-livery-*` channel
resolves its base dir through `_packDir` (`'mine'` / `'reference'` /
`'workshop'`);
`read-livery-image(folder, pack)` → data-URL (`_resolveLiveryImagePath`: the
manifest's main-part BaseMap, else any part's BaseMap, else a legacy
`base.png`; MIME PNG/JPEG by extension, `IMAGE_MISSING` when none);
`read-livery-thumbnail(folder, pack, size?)` → the **list preview**: same
resolution/containment as `read-livery-image` but downscaled to a
`THUMBNAIL_SIZE` (256, clamped 64..512) JPEG `data:image/jpeg;base64,…` via
Electron's `nativeImage` (`resize` + `toJPEG(72)`), memoized in an in-memory
`_thumbCache` keyed `${path}:${mtimeMs}:${size}` (FIFO-evicted past 300). A
`thumbnail: true` flag marks the real resize; when `nativeImage` is
unavailable/unproductive (plain-Node unit tests, empty decode) it degrades to
the full image verbatim with `thumbnail: false` so the list still renders;
`read-livery-images(folder, pack)` → **all** BaseMap parts of a stored livery
(`{success, imageDataUrl (main), parts:[{partName, fileName, imageDataUrl}]}`)
— the painter loads every panel; the list keeps using the single main-part
`read-livery-image`/`read-livery-thumbnail`, so its preview is unchanged;
`get-aircraft-template(planeId)` → the built-in default BaseMaps
(`readAircraftTemplate`, now a `parts` array — see "Aircraft template" above);
`list-aircraft-types()` → the aircraft-type dropdown source (see
"Aircraft-type dropdown" above);
`create-livery({images, imageDataUrl, airline, targetPlaneId, folder})` →
`images` is an ordered `[{partName, imageDataUrl}]` list (one entry per panel;
legacy callers may send a single `imageDataUrl`). Validates each image (airline
`/^[A-Z]{3}$/`, plane id resolves through `PLANE_ID_TO_SHORT_CODE`, PNG
data-URL, IHDR = 2048², folder matches `LIVERY_FOLDER_SAFE_RE` + containment)
and derives the short code + manifest id → writes `base.png` for a single panel
or `base_Fuselage.png`/`base_Wing.png`/`base_Wingtip.png` per panel (removing a
stale `base.png` from an older save) + a `parts` manifest (**silent overwrite,
no `.bak`** — the renderer's Save As override prompt is the guard, see
`CreateTab`), returns `{success, folder}`. The written manifest carries the
built-in `partName` per panel (**Fuselage + Wing/Wingtip** for A388/B38M) and
the built-in `targetModelVer` (C919 `2`, rest `1`);
`delete-livery(folder)` (own-pack only, containment-checked `rm -rf`);
`select-livery-image` (png/jpg dialog) + `read-disk-image(filePath)`;
`reveal-livery-folder(folder, pack)` → resolve the folder via
`resolvePackFolder` (containment-checked; `FOLDER_MISSING` when absent) and
`shell.openPath` it; a missing/`null` folder falls back to the own pack dir
(`ensureOwnPackDir`) so the painter's Open-folder button always opens
something. Returns `{success, path}`; `NO_GAME_ROOT` guard.
`export-livery(folder)` → `createZip` to temp `<folder>.zip` with
**folder-prefixed entries** (the manifest + **every** `.png`/`.jpg` image in
the folder, so multi-part liveries share whole; `IMAGE_MISSING` when the
folder carries no image); `export-livery-to-dir(folder)` → `exportLivery`
then a **directory** picker, copies to `<dir>/<folder>.zip` (cancel/failure
calls `cleanExportTemp`); `save-livery-dialog({sourcePath, suggestedName})` →
save dialog + copy + temp cleanup; `load-livery-zip()` → open dialog → temp
extract → `{folder, shortCode, manifest, imageDataUrl, parts}` where
`shortCode` is derived from `manifest.targetPlaneId`, `imageDataUrl` is the
**main-part** BaseMap (not `parts[0]`), and `parts` carries every BaseMap file
so the painter can prime both panels of a multi-image livery, MIME by
extension (temp cleaned). Errors: `NO_GAME_ROOT` /
`BAD_AIRLINE` / `BAD_PLANE` / `BAD_IMAGE` / `BAD_IMAGE_DIMENSIONS` /
`BAD_FOLDER` / `BAD_MANIFEST` / `IMAGE_MISSING` / `BAD_ZIP` / `ZIP_MISSING` /
`NO_TEMPLATE` / `BAD_TEMPLATE`
— renderer maps via `livery_err_*` i18n keys. PNG size via IHDR bytes 16–23;
containment via `path.relative`. ZIP via `src/utils/zipUtils.js` (no new deps);
image normalize in renderer canvas (`src/utils/liveryImage.js`, zero new deps);
DDS decode + PNG encode in `electron/dds.js` (zero new deps).
Preload exposes `exportLiveryToDir(folder)`/`getAircraftTemplate(planeId)`/`listAircraftTypes()`
/`revealLiveryFolder(folder, pack)`
alongside the others; `tests/setup.js` stubs them.

## Workshop publish (upload)

Main-process module `electron/steam-workshop.js` orchestrates the upload (sidecar
identity, content pack, preview handling, sidecar write) but **never calls
`SteamAPI_Init` itself in production**. Every Steam SDK call goes through
`electron/steam-workshop-bridge.js`, which lazily spawns
`electron/steam-workshop-worker.js` as a **short-lived plain-node child**
(`process.execPath` + `ELECTRON_RUN_AS_NODE=1`; shipped as extraResources beside
`steam-workshop-core.js`, and the native `steamworks.js` is required from its
asar-unpacked path). Steam reports the host app as "running" for the entire
lifetime of the process that called `SteamAPI_Init`, so the worker is torn down
promptly — `release()` after each dialog prefill and each publish (300 ms grace),
an 8 s idle safety net, and `dispose()` from `main.js` `will-quit` — and Steam
clears the status as soon as the child exits. The pure Steam logic lives in
`electron/steam-workshop-core.js` (no `electron`/`fs` imports) so it runs
identically in the worker and in-process. Unit tests inject a fake steamworks lib
via `_setSteamworksForTests`/`_resetSteamworksForTests`, which selects the
**in-process** transport (`_inProcessOps` in `steam-workshop.js`) and spawns no
child.

Always publishes to the single constant host **app `3328490`** (the shipping game)
(`STEAM_WORKSHOP_APP_ID`, literal fallback when the ESM
`src/utils/constants/steam.js` can't be `require`d), initialised **exactly once
per worker process** (re-init hangs) — deliberately no cross-app / Spacewar (`480`)
fallback probe, so the editor never accrues playtime on a game the user did not
launch. The `availability` op distinguishes `STEAM_UNAVAILABLE` (no module / init
throw) from `NO_LICENSE` (`apps.isSubscribedApp(3328490)` false — Family Sharing /
free weekends / playtest keys cannot publish).

Identity is a `.workshop.json` sidecar inside the livery folder (travels with the
livery, survives cache resets). Precedence for the dialog prefill is **live Steam
metadata → sidecar → manifest defaults** (`readPublishInfo`); the default title is
composed in the renderer (localized airline display name + compact aircraft type +
"Livery"/"涂装"), not in main. `publishLivery(gameRoot, folder, meta, onProgress)`:

1. `buildWorkshopContent(gameRoot, folder)` (`electron/livery.js`) copies the
   **entire** livery folder verbatim into a temp dir (only the private
   `.workshop.json` sidecar is excluded — the saved `.workshop-preview.*`
   ships with the item) and synthesizes the `mod_info.json` the game's
   LiveryScanner needs; requires a manifest and ≥1 real texture
   (`NO_MANIFEST`/`IMAGE_MISSING`). `publishLivery` additionally syncs the
   current upload's final preview into the content dir before submit, so a
   newly picked/generated/shrunk image travels even though it is only
   remembered locally after a successful upload.
2. Preview precedence: caller `previewPath` → saved `.workshop-preview.*` → fresh
   `buildWorkshopPreview` render. `ensurePreviewUnderLimit` re-encodes/downscales
   anything ≥ 1 MiB (Steam's `k_EResultLimitExceeded`) before submit.
3. `createItem` on first upload; on repeat, the recorded id is **existence-checked
   first** (`getItem`) — a deleted item republishes fresh, and an update failing
   because the item vanished creates one replacement. `updateItemWithCallback`
   drives progress; `needsToAcceptAgreement` → `STEAM_AGREEMENT`.
4. On success: save the preview into the folder, write/refresh the sidecar, return
   `{publishedFileId, url}`. Temp dirs (content, generated preview, shrink) are
   cleaned in a `finally`.

IPC channels (handlers in `main.js` resolve `_liveryGameRoot()` and delegate;
`preload.js` + `tests/setup.js` expose them): `get-workshop-publish-info(folder)`,
`select-livery-preview()` (image dialog → `readDiskImage`), `publish-livery(payload)`
(emits `workshop-upload-progress` events `{status, progress, total}`),
`open-workshop-log` (`shell.showItemInFolder` on `<userData>/workshop-upload.log`),
`workshop-debug-info` (debug handshake proving which main build serves the page —
a rejected invoke means a stale main process predating the feature). All errors
are clamped to the IPC contract by `toPublicError` (foreign napi codes such as
`GenericFailure` never leak as `error`; kept as a `detail` prefix) and mapped by
the renderer to `livery_err_*` keys. Codes: `STEAM_UNAVAILABLE` / `NO_LICENSE` /
`NO_GAME_ROOT` / `BAD_FOLDER` / `NO_MANIFEST` / `BAD_TITLE` / `BAD_IMAGE` /
`NO_PREVIEW` / `IMAGE_MISSING` / `CREATE_FAILED` / `UPLOAD_FAILED` /
`STEAM_AGREEMENT` / `PREVIEW_LIMIT`.

UI: `src/components/LiveryScreen/UploadLiveryDialog.jsx` (overlay id
`livery-upload-overlay`) — title/description/visibility (0 public / 1 friends /
2 private default / 3 unlisted) / tags / preview picker, progress bar, success view
with the clickable item URL. There is **no link-ID field** — association is
automatic from the sidecar (`linkItemId` is ignored). The list header's **Upload**
button (single `mine` selection) and the painter toolbar's Steam button (silently
saves a dirty canvas in place first) open it; while it is open the painter is
input-locked (`LiveryCanvas` `inputDisabled` → pointer/keyboard inert, wrap gets
`lp-input-locked`, `aria-disabled`) so e.g. Ctrl+C reaches the browser as copy.

## Image rules (locked)

Base texture is **opaque** — the painter seeds a new canvas with the
per-aircraft built-in template (or a neutral `#ffffff` fill), so a saved
`base.png` never has transparent holes (a BaseMap replaces the model's own
texture). `LiveryCanvas` **Clear** always restores the selected aircraft type's
built-in default livery (`defaultParts`), falling back to the opened
base panels / `DEFAULT_BASE_COLOR` only when that template is unavailable; and
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
**every** `.png`/`.jpg` image in the folder (`base.png` for single-part,
`base_Fuselage.png` (+ `base_Wing.png`) for multi-part; folder name free-form,
so `exportLiveryToDir` writes `<dir>/<FOLDER>.zip`). Recipient: Create → Import livery, or unzip straight
into `<gameRoot>/Mods/AC27 Custom Liveries/`. Round-trip test:
`tests/electron/livery-ipc.test.js` "share round-trip" (byte-identical
`base.png` + manifest deep-equal, and `shortCode` re-derived from the
manifest for a free-form zip folder).

## Tests

- `tests/utils/livery.test.js` (short-code table, `LIVERY_FOLDER_SAFE_RE`
  accept/reject + free-form id sanitization, manifest + `partName` + explicit
  `targetModelVer` carry-through incl. numeric→string coercion and
  `''`/`null`/omitted→`'1'` defaults with no `variant` key), `tests/utils/airlines.test.js`
  (`airlineDisplayName` en/zh + unknown fallback, `AIRLINE_CODE_TO_NAMES`
   dedup), `tests/utils/liveryPaint.test.js` (undo depth ≥20, flood fill,
   hex/rgb/hsv colour conversions, selection-mask ops: `maskPaintOp`/
   `lassoBounds`/`wandRegion`/`constrainImageToMask`/`isMaskEmpty` plus the
   border tracing `traceMaskBorder` (lone-pixel perimeter, adjacent-pixel
   interior suppression) and `chainBorderSegments` (closed-loop chaining,
   one loop per disjoint region, open/empty inputs)),
  `tests/electron/livery-ipc.test.js` (temp-gameRoot list/create/delete/export/
  load, free-form folder accepted verbatim, unsafe folder rejected, traversal,
  IHDR, reference read-only, manifest-derived shortCode, `mod_info.json`
  created on load/create at the pack root, reference-name + corrupt-JSON
  repair, existing own file untouched, UTF-8 zh name round-trip,
  **multi-part A388/B38M** — `hasBasePng`/`readLiveryImage` resolve
  `base_Fuselage.png` via the manifest (any-part + legacy `base.png` fallback,
  JPEG MIME), `createLivery` writes `partName: "Fuselage"` from the built-in
  default, `exportLivery` zips every texture image, `loadLiveryZip` previews
  the main part,
  `readAircraftTemplate` guards + DXT1→PNG decode + part preference + PNG/JPEG
  base passthrough + `parts[0]` fallback + no-parts/parse-error paths + cache,
  `createLivery` `targetModelVer` copy (C919 `2` + no-`variant`, missing-version
  →`1`, numeric/`''`/corrupt-manifest → normalized fallback),
  `readLiveryThumbnail` guards (`NO_GAME_ROOT`/`BAD_FOLDER`/`IMAGE_MISSING`) +
  verbatim full-image fallback (`thumbnail:false`, JPEG MIME) + odd-size
  clamping + a fake-`nativeImage` resize to a 256px JPEG (`thumbnail:true`),
  custom size, in-memory cache hits, empty-decode fallback, containment still
  enforced,
  **Steam Workshop** — `workshopContentDir` resolves the sibling
  `steamapps/workshop/content` and returns `null` off-Steam; `listWorkshopLiveries`
  finds liveries nested in a pack and at the item root (relative folders,
  non-livery items skipped) and `listLiveries` surfaces them; `readLiveryImage`
  with `pack:'workshop'` resolves the relative folder (traversal → `BAD_FOLDER`);
  `resolvePackFolder` resolves a contained folder per pack and rejects
  traversal/missing/no-gameRoot),
  `tests/electron/dds.test.js` (`decodeDds` DXT1 block / DXT5 alpha + colour /
  DXT3 4-bit alpha / 1/3+2/3 blend when c0>c1 / transparent-black mode when
  c0<=c1 / bad magic / unsupported fourCC / truncated payload / dimension
  guards, `encodePng` IHDR + IDAT round-trip, `ddsToPngDataUrl` DXT1 + DXT5
  pixel round-trip + the Y-flip that matches the in-game BaseMap orientation).
- `tests/components/LiveryScreen/` (header actions/back/install overlay/search,
  in-card checkbox select driving the header Export/Delete commands + their
  disabled-until-selected states, single vs batch delete confirms,
  **list thumbnails** (previews come from `read-livery-thumbnail` and never pull
  the full image, a rejecting channel falls back to `readLiveryImage`, and
  search narrowing discards stale in-flight thumbnails),
  **per-aircraft add-livery card + empty scanned folders** (add card per group,
  `onCreate(planeId)` / `onEdit({targetPlaneId})` fallback, empty folders from
  `listAircraftTypes`, no card on the unknown type, add-card → painter with the
  type pre-selected end-to-end), painter
  validation + save/save-as dialogs, Save As overwrite confirm (collision →
  prompt, Overwrite saves, Cancel aborts, fresh name + own-folder re-save skip
  it), Save follows the live form (unchanged → origin folder in place;
  airline/aircraft change → re-derived `{TYPE}_{AIRLINE}` default + manifest
  rewrite, retyping the origin folder updates in place), post-save mod-enable hint (flag read/write, checkbox persistence,
  hidden once dismissed, priority-to-top + Refresh-list guidance), free-form folder name, load-from-ZIP,
   **open folder** (reveals `origin.folder`+`pack`, and passes `null`/`'mine'`
   for a brand-new livery), import image, cancel, mine vs reference origin save rules, canvas
   tools/stroke/text/sticker/save payload with stubbed 2d context,
   right-click layer-order menu (`reorderObjects` pure moves + menu open/
   reorder/close/dismiss paths + disabled end states + right-press select +
   selection-less Delete + shortcut settling; the menu is gated to Select
   object mode — a pen-tool right-click picks the colour instead; H / V flip the
   selected object; Enter clears the selection instead of re-opening text; a
   scaling drag is one Ctrl+Z undo step (and keeps registering past the 2048
   canvas edge); Ctrl+C duplicates (true copy — original stays live, no base
   stamp); I imports a sticker; H/V flip; rail tooltips
   advertise the shortcuts and the Eyedropper has none) and keyboard-parity gesture
    settling (shortcut commits a mid-drag shape) plus the selection mask
    (Object/Pen/Wand modes + Combine default/Erase/Replace + wand tolerance
    slider + numeric field, lasso → mask + white-dot/black-border outline + Deselect, Ctrl+D deselects,
    tap/Escape cancel, wand region
    spans, the wand composites the live movable layer before sampling
    (a rect is drawn during the flood), the fill samples the same composite and
    paints spans into the fill layer (never `putImageData` on the fill layer,
    which would ignore tolerance), an imported sticker hands over to single-select
    (Object mode) rather than staying in wand/lasso, Del with a selection trims transparent
    (BOTH raster layers punched via `destination-out` with the base showing
    through —
    never painted over — while touched movables keep `erasePolys` holes in
    their own layer) instead of
    removing the object while Del without one still
    removes it, and the marquee maps the traced selection into each touched
    movable as `erasePolys` holes (a fully-consumed object is dropped), a
    duplicate inherits the stamped `clipMask`, a lasso is clipped to the active
    panel (multi-image), masked stroke triggers the `putImageData` clip vs never unmasked,
    eyedropper composites live objects (sticker colour picked, not the base),
    a live selection never masks a movable (export counts zero `destination-in`
    clips for movables),
    `[` / `]` step the brush/eraser size by 5 with clamping and are inert for a
    tool without a size (e.g. Rect), every options-bar slider value takes a
    typed number (brush/eraser size, shape width, font size, sticker opacity:
    blur/Enter commits, out-of-range clamps, empty reverts, Escape discards the
    draft, slider follows), canvas shortcuts stay inert while an app modal is
    open (save popups keep the movable selection), a click with no drag deposits one brush dab,
    and a click + Shift-click chains straight brush and eraser segments,
    new keys resolve in zh+en). List help + painter help both end with the
    post-save mod-enable warning as a highlighted tip (`#livery-help-tip`), and
    Ctrl+F focuses the list Find input (ignored while typing, with a modal
    open, or on the painter page).
- `tests/components/LiveryScreen/LiveryCanvas.test.jsx` multi-image coverage
  also pins: the padded overlay canvas size (`W+2·OVERLAY_PAD`), click-to-activate
  (`onActivePanel(1)`), that the panel-switch click also paints the brush dab in
  the same gesture (no second click) and that a single press into another panel
  applies the wand there (mask clipped to `x=2176`, not the previous panel),
  a click in the gutter activating the
  nearest panel, keyboard shortcuts never changing the active panel,
  that an object can move outside the active panel (overflow clipped, not
  clamped), and that a movable dragged by its edge is assigned to the panel
  under the **pointer** (`panel: 1`) even though its centre never crossed the
  gutter (`x < 2048`) — it renders AND exports clipped to panel 1's `x=2176`.
  `tests/components/LiveryScreen/CreateTab.test.jsx` asserts the
  2-panel store width instead of the removed tab strip, that H/V keep the active
  panel, that Ctrl+S / Ctrl+Shift+S open the Save / Save As dialogs (and are
  ignored while typing or while a dialog is open), and that a save adopts the
  saved folder so the next Save overwrites it in place.
  `tests/components/LiveryScreen/MyLiveriesTab.test.jsx` pins the in-place
  delete: a successful delete drops only its row (no full re-list, `scrollTop`
  capped to the shrunken content) and a partial batch leaves the failed rows.
- `tests/components/LiveryScreen/LiveryColorPicker.test.jsx` (portal
  anchoring, SV-square drag emits colour + keeps opacity, hue/alpha rails,
  hex commit on blur/Enter + malformed-input rejection, window/Escape/
  backdrop/right-click dismissal, hue retained across achromatic colours).
- `tests/unit/steam-workshop.test.js` — the uploader against an **injected fake
  `steamworks` client** (both `init()→client` and modern module-namespace shapes;
  no Steam, no native module). Covers `isAvailable` gating (module missing / init
  throw → `STEAM_UNAVAILABLE`; not-subscribed → `NO_LICENSE`; single app inited
  once, no cross-app probe), foreign-code sanitization + `toPublicError`,
  sidecar round-trip/tolerance, `parseWorkshopId`, `readPublishInfo` precedence +
  deleted-item forgetting, and `publishLivery` create/update/replacement, preview
  save+reuse, `ensurePreviewUnderLimit` integration (oversized preview is shrunk
  and the shrunk path is what reaches `updateItem`), `PREVIEW_LIMIT` mapping,
  progress forwarding and temp cleanup.
- `tests/unit/steam-workshop-worker.test.js` — the worker transport:
  `steam-workshop-core` against a fake lib (init failure / `NO_LICENSE` /
  `createItem` id stringify / `PREVIEW_LIMIT` mapping / BigInt-safe
  `normalizeItem`), and `steam-workshop-bridge` driving the **real**
  `steam-workshop-worker.js` child over stdio with a temp fake steamworks module
  (availability author, missing/create/update + progress, `NO_LICENSE`,
  coded-error frames, and **child exit on `release()`** — the Steam
  "running"-status teardown).
- `tests/unit/livery-workshop-packaging.test.js` — `workshopModName`,
  `buildWorkshopContent` (verbatim copy, dot-file exclusion, `mod_info.json`
  synthesis, coded errors, multi-part, cleanup), `buildWorkshopPreview` (coded
  errors, file output, raw-bytes fallback, **fake-`nativeImage` resize→JPEG
  branch**) and `ensurePreviewUnderLimit`.
- `tests/components/LiveryScreen/UploadLiveryDialog.test.jsx` — dialog prefill,
  localized default title (en/zh), upload-only button label, unavailable reason,
  progress + success URL, error-keeps-input, generic fallback for unknown codes +
  `View log`, stale-main banner, no `linkItemId` sent, preview picker.
- In-game acceptance (manual): create via UI → launch game → livery on model
  (validates the own-pack-dir assumption); upload via UI with Steam running.

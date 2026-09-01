# AC27 Architecture & Conventions

## Table of Contents

- [AC27 Architecture \& Conventions](#ac27-architecture--conventions)
  - [Table of Contents](#table-of-contents)
  - [Directory Structure](#directory-structure)
  - [Coding Conventions](#coding-conventions)
    - [Backend (Node.js / `electron/*.js` + `src/acl/*.js`)](#backend-nodejs--electronjs--srcacljs)
    - [Frontend (React / `src/components/*.jsx` + `src/hooks/*.jsx`)](#frontend-react--srccomponentsjsx--srchooksjsx)
    - [Tooltip System (`useTooltip`)](#tooltip-system-usetooltip)
    - [IPC Patterns](#ipc-patterns)
    - [Test Conventions](#test-conventions)
  - [Three-Screen SPA](#three-screen-spa)

## Directory Structure

```
AC27Editor/
├── electron/
│   ├── main.js              # Electron main process + 77 IPC handlers (incl. load-ground-painter-data / save-ground-painter-data for the Ground Painter)
│   ├── preload.js           # contextBridge (window.electronAPI, ~95 methods; + loadGroundPainterData / saveGroundPainterData)
│   ├── updater.js           # Auto-update: HEAD check (R2 ETag), MD5 comparison, exe download, batch script generator
│   ├── api-server.js        # HTTP API + MCP server (port 31415, auto-starts with app) — + get_ground_painter_state / create_taxiway_lines / create_area / create_stands / delete_ground_objects / undo_ground_painter
│   ├── cloud-llm.js         # Multi-vendor cloud LLM chat (DeepSeek/Gemini/Claude/Codex)
│   └── udp_listener.js      # UDP telemetry — 10 Hz binary aircraft state (127.0.0.1:20266) + commands (20267)
├── mcp/
│   └── bridge.js            # MCP stdio↔HTTP bridge (launched by Claude Code)
├── index.html               # Vite HTML entry (<div id="root">)
├── vite.config.js           # Vite 8 + @vitejs/plugin-react + vite-plugin-electron
├── package.json             # scripts, electron-builder config
├── build.js                 # RECOMMENDED build script (programmatic)
├── set_icon.js              # Post-build icon embedding
├── icon.ico / icon.png      # App icons
├── README.md                # Comprehensive docs
│
├── src/
│   ├── main.jsx             # React entry: ReactDOM.createRoot → <App />
│   ├── App.jsx              # Root component: providers + screen routing
│   ├── style.css            # Global dark theme CSS variables + reset
│   │
│   ├── components/
│   │   ├── SetupScreen/     # Game root directory selection
│   │   │   ├── SetupScreen.jsx  + .css
│   │   ├── BrowserScreen/   # Airport card listing, file browsing
│   │   │   ├── BrowserScreen.jsx + .css
│   │   │   ├── AirportCardMap.jsx + .css  # Mini ground-radar SVG per card
│   │   │   ├── BrowserHelpOverlay.jsx + .css  # Help overlay with button descriptions
│   │   │   ├── VideoReplaceOverlay.jsx + .css  # Main menu background video replacer
│   │   │   ├── useTooltip.jsx + .css  # Shared tooltip hook (used by browser, editor, and map windows)
│   │   ├── EditorScreen/    # Main editor: toolbar + table + timelines
│   │   │   ├── EditorScreen.jsx + .css
│   │   │   ├── SearchBar.jsx     # Ctrl+F search (extracted component)
│   │   │   ├── TutorialOverlay.jsx + .css  # First-time help overlay
│   │   │   ├── FlightTable/
│   │   │   │   └── FlightTable.jsx + .css
│   │   │   ├── CellEditor/
│   │   │   │   ├── TimeClockPopover.jsx  # SVG clock picker
│   │   │   │   ├── CompassPopover.jsx    # SVG compass picker
│   │   │   │   └── CellEditor.css
│   │   │   ├── StandMap/
│   │   │   │   ├── StandMap.jsx + .css   # Interactive stand position map overlay
│   │   │   ├── StarMap/
│   │   │   │   └── StarMap.jsx + .css    # Interactive STAR/approach map overlay
│   │   │   ├── GroundPainter/
│   │   │   │   ├── GroundPainter.jsx + .css      # Dedicated full-screen static-scenery editor (id-free Graph)
│   │   │   │   ├── GroundPainterToolbar.jsx      # Bottom bar: tool modes (select/fillet/taxiway/runway/area/stand), AreaType toggle popover, stand heading, zoom, background-image panel (import + L/R, U/D, Scale 10-500%, Opacity 0-100% sliders; default 60%, stored bgImage.opacity 0..1, rendered <image opacity>), Save/Cancel. Runway end names are NOT edited here — they're edited on the canvas via floating threshold text boxes (runwayOverlay in GroundPainter.jsx)
│   │   │   │   ├── snap.js                       # Pure snap engine: 1.1 endpoint → 1.2 on-segment → angle snap (rotates the cursor around the anchor onto collinear/±90°/±45°/±135° relative to the last edge prev→anchor, keeping radius; vertex angle straight=180°) — no DOM, MCP/tests call directly
│   │   │   │   └── fillet.js                     # Pure fillet/rounding math (computeFillet countIncidentAll/ByCoord findNodeIndexByCoord) — no DOM, MCP/tests call directly
│   │   │   └── TimelineEditors/
│   │   ├── MapWindows/               # Full-window map visualizations (separate BrowserWindow instances)
│   │   │   ├── GroundMapWindow.jsx + .css  # Surface radar: taxiways, runways, areas, ground aircraft (stand-access segments marked + help overlay)
│   │   │   ├── AirMapWindow.jsx + .css     # Approach radar: STAR/SID/APPR routes, air aircraft, map bg, runway extensions, range rings, border overlay, help overlay
│   │   │   ├── FlightStripsWindow.jsx + .css  # Flight strips: live seat-sorted strips with drag reorder, selection sync, help overlay
│   │   │   ├── ControlSidebar.jsx + .css   # Vertical sidebar: spin knobs (zoom/pan/airspace) + toggle buttons + help button
│   │   │   ├── SpinKnob.jsx + .css         # Rotary encoder knob (click-drag + scroll-wheel, gauge mode)
│   │   │   ├── SimClock.jsx                # Shared sim-time clock (HH:MM:SS UTC, accepts className prop)
│   │   │   ├── MapHelpOverlay.jsx + .css   # Context-sensitive help overlay (air/ground/strips, Escape to close, toggleable buttons, optional title prop)
│   │   │   ├── MapShared.css               # Shared styles: toggle buttons, clock, help button, animations, witch mode UI overrides (sidebar bar.png, button.png/button_on.png toggles, knob.png spin knobs)
│   │   │   ├── useSvgZoom.js               # Scroll-zoom + drag-pan SVG hook (clamped, imperative API)
│   │   │   ├── useUdpAircraftState.js      # Hook subscribing to live UDP state pushes (incl. simTimeUnixMs)
│   │   │   ├── witchMode.js                # Witch mode: direction, parked detection, sprite-sheet lookup (accepts centralized spriteIdx from main process, djb2 hash fallback)
│   │   │   ├── FlightStripCommandBar.jsx   # Strip command bar UI (planned, import commented out)
│   │   │   ├── commandTree.js              # Command tree data model + filtering by seat/state/direction
│   │   │   ├── voiceNumberParser.js        # Spoken numbers → digits (EN + ZH aviation phraseology; fuzzy D-L ≤1 lookups)
│   │   │   ├── voiceCallsignParser.js      # Airline name→ICAO + callsign matching against UDP aircraft (fuzzy name words)
│   │   │   ├── voiceFuzzy.js               # Fuzzy policy leaf: D-L (OSA), thresholds, filler/exclusion/confusable tables
│   │   │   ├── voiceCommandMatcher.js      # Legacy command matcher (unused by the pipeline — tests only)
│   │   │   ├── useVoiceCommands.js         # React hook orchestrating full voice pipeline (candidates + alternates)
│   │   │   └── VoicePTTButton.jsx          # Push-to-talk mic button (hold-to-talk, anion/pulse/flash, witch sprite)
│   │   ├── ChatPanel/
│   │   │   ├── ChatPanel.jsx + .css     # Floating cloud-LLM chat panel (4 vendors)
│   │   ├── UpdateOverlay.jsx + .css  # Auto-update download progress overlay
│   │   └── common/
│   │       ├── Modal.jsx + .css         # Declarative modal
│   │       └── Toast.jsx + .css         # Declarative toast
│   │
│   ├── hooks/
│   │   ├── useTranslation.jsx   # I18n Context Provider
│   │   ├── useElectronAPI.jsx   # electronAPI Context Provider
│   │   ├── useEditorShell.jsx   # Keyboard shortcuts (Ctrl+S, Delete, etc.)
│   │   ├── useEditorSaveActions.jsx  # Save/export/backup/restore/import workflows
│   │   ├── useKeyboardShortcuts.js
│   │   ├── useDrag.js          # Shared drag behavior for floating panels (StandMap, StarMap)
│   │   └── map/                 # Shared hooks for map windows
│   │       ├── useCrossWindowSelection.js  # Cross-window aircraft selection + emergency sync
│   │       ├── useWitchAnimation.js        # 500ms frame-toggle for witch mode sprites
│   │       └── useKnobPositions.js         # SVG viewBox → 0-1 knob gauge positions
│   │
│   ├── store/
│   │   ├── appStore.js          # zustand store — all app state
│   │   ├── flightDefaults.js    # Pure helpers for new flight creation (random airline, cascaded aircraft/reg, non-conflicting stand, airport-aware Language Z*→zh, random Voice from dropdown, runway-constrained STAR for arrivals, Airway always cleared for departures)
│   │   └── flightCascade.js     # Pure helpers for cascading field updates
│   │
│   ├── acl/                     # Backend modules (16 files + odin/; CommonJS + some ESM)
│   │   ├── parser.js            # FACADE — re-exports all backend modules
│   │   ├── tokenizer.js         # String-aware section boundary scanner (no more brace-counting)
│   │   ├── acl_json.js          # Pre-processor (Unity JSON→valid JSON) + serializer + Odin recursive-descent parser
│   │   ├── acl_document.js      # In-memory document model (lazy parsing, mutation tracking)
│   │   ├── constants.js         # CJS re-export of utils/constants.js (backward compat)
│   │   ├── config.js            # resolveConfigTime / resolveDisplayTimes (Config block + GameTime.CurrentDateTime override)
│   │   ├── scanner.js           # Scans game root for airports & .acl files
│   │   ├── gatcarc.js           # GATCARC4 binary container — readAclText() / writeAcl() (the only .acl I/O; writeAcl renumbers ids via id_renumber.js)
│   │   ├── id_renumber.js       # $id/$iref renumberer — strictly ascending ids in text order (game's JsonDataReader requirement); renumberDocument/renumberAclIds/countIdDescents
│   │   ├── v4_pk_index.js       # PKStaticEntities index builder ($iref → $id resolution, field helpers)
│   │   ├── odin/                # OdinSerializer binary codec (binary/json readers + writers, .NET primitives, entry types)
│   │   ├── flight_plans.js      # StaticData/StaticItems flight-plan parse + v4 save pipeline (_rebuildStaticDataSections, timeline rebuild)
│   │   ├── approach.js          # Approach aircraft construction (State=30/State=5) + approach cache builder (v5: global aircraft_profiles.csv + allAclTexts merge, PhysicalRunwayStaticItem, Area 31)
│   │   ├── scenery.js           # PKStaticEntities scenery parser (runway/stand lookups + stand position extraction; v5: Area 30→31)
│   │   ├── scenery_graph.js     # Ground Painter read path: id-free Graph (buildSceneryGraph→{graph,meta}) + getBlobTypeMap/coordKey/findNodeIndex/rebuildOwners. NOT re-exported via parser.js — electron/main.js requires it directly
│   │   ├── scenery_write.js     # Ground Painter write path: patchSceneryBlob (lossless, ids allocated at write; deletes only via meta.deletedPks/deletedAreaIds; _renumberTaxiwaySegmentOrdinals keeps taxiway-segment ordinal suffixes contiguous per osm) + saveGroundPainterAcl (.bak + writeAcl). NOT re-exported via parser.js
│   │   ├── taxiway.js           # Taxiway centerline parser from PKStaticEntities taxiway-segment:* entries
│   │   ├── sid_goaround.js      # SID + Missed Approach route parser from PKStaticEntities runway Routes (RouteType=2/3; v5: PhysicalRunwayStaticItem indirection)
│   │   └── utils.js             # Enrichment, sorting, audio, runway pairs (extractV4RunwayPairs), import utils
│   │
│   └── utils/                   # Shared utilities (ESM + some CJS for backend)
│       ├── constants/           # 7 domain sub-modules (was single constants.js)
│       │   ├── index.js         # Barrel — re-exports all sub-modules
│       │   ├── timing.js        # Ticks, CACHE_VERSION, game timing, stand occupancy
│       │   ├── fields.js        # FIELDS, FIELD_LABELS, COL_CLASSES
│       │   ├── aviation.js      # Wind, approach math, dynamics, command codes
│       │   ├── airlines.js      # AIRPORT_META, AIRLINE_CODE_MAP
│       │   ├── acl-format.js    # ACL structure, ID offsets, spec defaults
│       │   ├── map-config.js    # Map layout, per-airport offsets/zoom
│       │   └── ui.js            # Storage keys, i18n, weather, compass, file filters
│       ├── timeUtils.js         # Tick↔time conversion, timeline helpers (CJS + ESM)
│       ├── i18n.js              # Chinese/English translation (T(), getLang, setLang)
│       ├── validators.js        # validateCallsigns, runTripleValidation
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── safeHtml.jsx         # Safe i18n HTML rendering (strong/em/br only)
│       ├── debugLog.js          # Gated debug logging (localStorage + URL flag)
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # 1200 Vitest + 17 Playwright E2E + 29 Node.js integration scripts
│   ├── electron/cloud-llm.test.js  # cloud-llm backend tests (49 tests, node env)
│   ├── electron/updater.test.js    # updater backend tests (25 tests, node env)
│   ├── components/MapWindows/  # MapWindow component & hook tests (19 files, 712 tests)
└── dist/                # Build output (gitignored)
```

## Coding Conventions

### Backend (Node.js / `electron/*.js` + `src/acl/*.js`)

**Module system:** Primarily CommonJS. `parser.js` uses `require()` for most modules but also uses ESM `import` for `./constants.js`. New shared constants should use ESM so both frontend and backend can consume them.
```js
const { loadFlights, exportCSV } = require('../src/acl/parser.js');
module.exports = { publicFn, _privateFn };
```

**Naming:**
- `camelCase` for functions and variables
- `_underscorePrefix` for private/internal functions
- `UPPER_SNAKE_CASE` for true constants
- `snake_case.js` filenames in `src/acl/`

**Error handling:** Always return `{ success: true/false, error?: message }` from IPC handlers and I/O functions. Never throw across process boundaries.

**Logging:** Use `console.log` with a `[TAG]` prefix: `[IPC]`, `[ACL-LOAD]`, `[ACL-REBUILD-V4]`, `[RENDERER]`.

**No external dependencies for core logic.** Uses only Node.js built-ins (`fs`, `path`, `zlib`, `crypto`). Do not add npm dependencies without strong justification.

**Facade pattern:** `src/acl/parser.js` is the single entry point. `electron/main.js` imports only from `parser.js`. New parsing modules must be re-exported through `parser.js`. **Deliberate exception — Ground Painter (2026-08-25):** `src/acl/scenery_graph.js` and `src/acl/scenery_write.js` are **not** re-exported through the facade; `electron/main.js` `require()`s them directly (`load-ground-painter-data` builds the Graph in the main process so the renderer never has to dynamic-import the CJS acl module). Do not blindly add them to `parser.js` — they are self-contained and lifecycle-scoped to the painter IPC/Tests.

### Frontend (React / `src/components/*.jsx` + `src/hooks/*.jsx`)

**Module system:** ESM (`import`/`export`) throughout. Vite handles bundling.

**Component patterns:**
- One component per file (default export)
- Each component has a matching `.css` file in the same directory
- Sub-components that are only used by one parent may be defined in the same file
- Shared sub-components go in their own file (e.g., `TimeCell.jsx`)
- Use React hooks for state and side effects (never class components)

**File naming:**
- `PascalCase.jsx` for components: `EditorScreen.jsx`, `FlightTable.jsx`
- `camelCase.js` for non-React utilities: `constants.js`, `timeUtils.js`
- `.css` files match their component: `EditorScreen.css`, `FlightTable.css`

**CSS conventions:**
- Global variables + reset in `src/style.css`
- Component styles in `<ComponentName>.css` next to the `.jsx` file
- NEVER use inline `style={{}}` — always extract to CSS classes
- CSS class naming: BEM-like flat naming (`.modal-issues-body`, `.callsign-link`)
- CSS custom properties (`--bg`, `--accent`, `--radius`, etc.) for theming
- **⚠️ CSS `url()` for public assets MUST use absolute paths (`/witch/foo.png`)** — Vite needs the leading `/` to correctly rewrite paths in production builds. Without it, assets break in the packaged EXE because the CSS file lives in `dist/assets/` while public files are in `dist/`. JSX `<img src>` uses page-relative paths (e.g., `witch/help.png` or `./witch/help.png`).

**State management (zustand):**
- Single store in `src/store/appStore.js`
- Components subscribe with selectors: `useAppStore(s => s.flights)`
- Actions are defined in the store and called via `useAppStore.getState().actionName()`
- NEVER mutate state directly — always use `set()` or store actions
- `Set` and `Map` in state must be replaced with new instances on mutation

**Hooks:**
- Custom hooks in `src/hooks/` — one hook per file
- `useTranslation()` — returns `{ t, lang, toggleLang }`
- `useElectronAPI()` — returns the `window.electronAPI` bridge
- `useEditorShell({ onSave })` — registers keyboard shortcuts
- `useEditorSaveActions({ electronAPI, t, showModal, hideModal, showToast, ... })` — returns `{ doSave, handleSave, handleSaveAs, handleBackup, handleRestore, handleImport, handleBack }`
- `map/useCrossWindowSelection(airportIcao, electronAPI, setSelectedCallSign)` — shared IPC listener for cross-window aircraft selection sync
- `map/useCrossWindowEmergency(airportIcao, electronAPI, setEmergencyCallSign)` — shared IPC listener for emergency aircraft sync
- `map/useWitchAnimation(witchMode)` — returns `witchFrame` (0 or 1), shared 500ms frame-toggle timer
- `map/useKnobPositions(viewBox, initialViewBox)` — returns `{ zoom, panH, panV }` 0-1 knob gauge positions
- `useDrag({ panelRef, enabled, onDragEnd })` — shared drag behavior for floating panels; returns `{ pos, isDragging, hasDragged, setPos, headerHandlers }`

**React best practices:**
- Hoist RegExp to module scope (never inside render)
- Use `useMemo`/`useCallback` for expensive computations or stable callbacks
- Never mutate props/state arrays — use spread `[...arr]` or `.toSorted()`
- Always include proper dependency arrays in `useEffect`
- Use `didInit` guard pattern for app-wide initialization effects
- Never use `key={Math.random()}` — use stable keys
- Never use `dangerouslySetInnerHTML` — use `safeHtml()` from `src/utils/safeHtml.jsx` to render i18n strings with allowed HTML tags (`<strong>`, `<em>`, `<br>`) as safe React nodes

### Tooltip System (`useTooltip`)

Portal-based tooltip hook shared by BrowserScreen and EditorScreen (`src/components/BrowserScreen/useTooltip.jsx`). Replaces native `title` attributes.

**Width calculation:** Compile-time, no DOM measurement. Per-character glyph widths at 12px system-ui:
- Latin: `CW` lookup table (narrow 4px → extra-wide 11px)
- CJK: 12px/char
- `BASE = 10px` for all; CJK gets `+10px` extra breathing room
- `calcWidth(text) = BASE + Σ charW(ch) [+ 10 if CJK]`, capped at 600px

**Three-mode horizontal positioning:**
| Mode | Trigger | Positioning |
|------|---------|-------------|
| Centre | Fits around button | `left: btnCenter; transform: translateX(-50%)` |
| Left-pin | Overflows left edge | `left: MIN_PAD; transform: translateX(0)` |
| Right-pin | Overflows right edge | `left: vw - tw - MIN_PAD; transform: translateX(0)` |

**Vertical:** Box sits entirely above button (`top = rect.top - EST_H - ARROW_H`), arrow at button top. Flips below if no room.

**API:** `bind(text)` → `{ onMouseEnter, onMouseLeave }`. `{TooltipPortal}` at component bottom.

**Button registries** (`BrowserHelpOverlay.jsx`, `TutorialOverlay.jsx`): Exported `BUTTONS` with `descKey`/`icon`/`labelKey`. Used for both tooltip `bind()` and help overlay rendering.

### IPC Patterns

```
Renderer                    preload.js                  main.js
─────────                   ──────────                  ───────
window.electronAPI          ipcRenderer.invoke()        ipcMain.handle()
  .loadAcl(path)    ──→       'load-acl'        ──→      async handler
                    ←──       result            ←──      return {...}
```

**Rules:**
- Renderer NEVER accesses `require()` or Node.js APIs directly
- All file I/O goes through IPC handlers in `electron/main.js`
- IPC channels use kebab-case strings matching the handler name
- Every `ipcMain.handle()` must return `{ success: true/false }`
- New IPC channels require: (1) handler in `electron/main.js`, (2) bridge method in `electron/preload.js`, (3) call site in renderer. Ground Painter channels: `load-ground-painter-data` (→ readAclText + buildSceneryGraph) and `save-ground-painter-data` (→ patchSceneryBlob + .bak + writeAcl, returns the new baseline text).
- **Main→renderer events:**
  - `cache-build-progress` — per-file progress during scan: `{ current: number, total: number }`; preload bridges via `onCacheBuildProgress(cb)` / `offCacheBuildProgress(cb)` (uses handler-map pattern, same function reference required for cleanup)
  - `store-api-update` — pushes bulk state updates from MCP/API server to renderer: `{ flights, modified, ... }`; preload bridges via `onStoreApiUpdate(cb)` / `offStoreApiUpdate(cb)` (handler-map pattern). Renderer converts arrays→Sets and calls `setLegacyState()`.
  - `update-check-result` — pushed from main process on startup after HEAD check: `{ hasUpdate, currentVersion, remoteMd5, remoteDate, contentLength }`; preload bridges via `onUpdateCheckResult(cb)` / `offUpdateCheckResult(cb)` (handler-map pattern). Renderer shows update modal when `hasUpdate` is true.
  - `update-download-progress` — download progress during update: `{ percent: number }`; preload bridges via `onUpdateDownloadProgress(cb)` / `offUpdateDownloadProgress(cb)` (handler-map pattern). Used by UpdateOverlay component.

### Test Conventions

Three-layer testing strategy:

**Layer 1 — Component tests (Vitest + React Testing Library):**
- `npm test` or `npm run test:watch` — 1200 tests (component + store + utility + electron + MapWindow + updater, ~9s)
- Isolated component rendering in jsdom with mocked `window.electronAPI`
- Electron backend tests use `@vitest-environment node` + `require.cache` priming to stub ESM SDK packages (see `tests/electron/cloud-llm.test.js`)
- zustand stores are tested with the real store using `setState()` — never mock stores
- Store auto-reset between tests via `tests/__mocks__/zustand.js`
- MapWindow component tests mock `useUdpAircraftState`, `useSvgZoom`, and `useElectronAPI` hooks at the module level
- MapWindow hooks (`useSvgZoom`, `useUdpAircraftState`) are tested with `renderHook` from `@testing-library/react`

**Layer 2 — E2E tests (Playwright + Electron):**
- `npm run test:e2e` (requires `npm run build` first)
- Launches the real Electron app against a temp fixture copy in `tests/tmp-e2e/`
- Custom `--user-data-dir` with pre-written `lastRoot.json` skips the setup screen
- `AC27_E2E_TMP_DIR` env var skips native OS dialogs (export) in test mode; backup saves `.bak` directly alongside source (no dialog)
- **Never touches real game files** — all reads/writes go to temp copies
- **Fuzz save test (`tests/e2e/fuzz-save.spec.mjs`, `npm run test:fuzz`):** randomized 50–200 op storms via MCP per production level (sourced from `E2E_GAME_ROOT`), gated before save through the app's own `runTripleValidation` with an auto-repair loop (reg/type/num/STAR/stand/time fixes; synthetic format-preserving registrations when canonical pools are exhausted), then a real UI save-with-backup + reload verification. `tests/e2e/fuzz-cli.mjs` is the runner wrapper that adds the `--replace` flag (copies PASSED levels' `.acl`+`.acl.bak` into the real install; `FUZZ_REPLACE=1` env equivalent). Gated on `FUZZ_RUN=1` — skips in normal `test:e2e` runs.
- **Save pipeline regression suites (Vitest, fixture-based, no game root):** `tests/integration/save_gamecompat.test.js` + `gamecompat-utils.cjs` encode the five fuzz-discovered init-rejection invariants (docked entity loss, duplicate plan keys, stand conflicts, STAR-less arrival legs — `arrival-no-star` — and leg resolution; surfaces the auto-repair in `_normalizeFlightsForGameCompat`); `tests/integration/id_renumber.test.js` pins the strictly-ascending `$id` requirement and the `id_renumber.js` rewrite (incl. the ZSJN_peakdeparture `jetway:02` crash pattern); `tests/integration/scenery_delete_cascade.test.js` pins the stand-deletion cascade (a deleted stand drops its `jetway:*` STATIC item AND its checkpoint-frame jetway RUNTIME entity — the Unity `Jetway: static item … does not exist` reference-integrity break — while leaving the taxi-navigation graph intact). All run under `npx vitest run tests/integration/<name>.test.js`.

File isolation flow:
```
tests/fixtures/game-root/       tests/tmp-e2e/                  tests/tmp-e2e-userdata/
(committed to git)              (gitignored, fresh each run)    (gitignored)
─────────────────────     copy    ─────────────────────
ZSJN/                    ─────→   ZSJN/                  lastRoot.json → { rootPath: "tmp-e2e" }
  airport_config.json               airport_config.json
  Levels/                           Levels/
    *.acl                             *.acl              Electron --user-data-dir=tmp-e2e-userdata/
    *.json                            *.json             → reads lastRoot.json → skips SetupScreen
                                                         → all file I/O goes to tmp-e2e/
```
1. `global-setup.mjs`: copy fixtures → `tmp-e2e/`, write `lastRoot.json`
2. Electron launches with `--user-data-dir=tmp-e2e-userdata/` + `AC27_E2E_TMP_DIR` env
3. App sees `lastRoot.json` → goes straight to BrowserScreen (no native dialog)
4. All saves, backups, timeline writes land in `tmp-e2e/`
5. `global-teardown.mjs`: remove both temp dirs

**Layer 3 — Integration tests (plain Node.js):**
- Located in `tests/integration/` (moved from `test/`)
- Standalone scripts run with `node tests/integration/<name>.js`
- Tests `require('../../src/acl/parser.js')` to access both public and `_private` functions
- Use `--require ./tests/integration/preload.cjs` for tests that import ESM source modules
- New parser tests (`test_tokenizer`, `test_acl_json`, `test_acl_document`, `test_sid_goaround`, `test_taxiway`) run without a game root — they use synthetic test data
- `test_sid_goaround` and `test_taxiway` also run against the ZSJN fixture in `tests/fixtures/game-root/` for integration coverage
- UDP listener test (`test_udp_listener`) uses a mock loopback server — sends crafted binary packets and verifies parsed state. Requires port 20266 to be free (game not running)
- Other tests need a real game installation (Airport Control 27) at a known path
- Tests print results to stdout — read the output to determine pass/fail

**Save integrity test (`test_save_integrity_all.js`) — file isolation flow:**

Real game files are **never modified**. Each .acl file follows this path:

```
Game root (read-only)            Temp golden/ (pristine)        Temp result/ (save target)
────────────────────────         ─────────────────────          ────────────────────────
Airports/ZSJN/Levels/       copy →  _tmp/golden/ZSJN/     copy →  _tmp/result/ZSJN/
  ZSJN_leisure_1.acl     ─────→    ZSJN_leisure_1.acl  ──→   ZSJN_leisure_1.acl
  weather_timeline.json    ─────→    weather_timeline.json           (overwritten by save)
  wind_timeline.json       ─────→    wind_timeline.json
  runway_timeline_....json ─────→    runway_timeline_....json
```

1. **Copy** real .acl + timeline JSONs → `tests/integration/_tmp/golden/<icao>/` (pristine snapshot)
2. **Load golden** → in-memory snapshot (flights, config, scenery, timelines)
3. **Copy golden** → `tests/integration/_tmp/result/<icao>/` (save target)
4. **Save** via `generateFullAcl` on result copy — only result is modified
5. **Load result** → compare against golden snapshot (14 fields × N flights, config, scenery maps, embedded timelines)
6. **Clean up** `_tmp/` after each file (removed entirely after run)
7. **Write JSON report** → `tests/_reports_/save-integrity-<timestamp>.json` with per-file metrics and diffs

- Supports `--prod-demo` flag to test only the 21 prod+demo files (18 prod + 3 demo; 13→18 prod with ZGSZ +5, 16→21 total)
- Both `tests/integration/_tmp/` and `tests/_reports_/` are gitignored
- Full test documentation: `tests/README.md` — test matrix, expected values, execution commands

## Three-Screen SPA

The app is a single-page application with three screens managed by zustand state:

| Screen | Component | Purpose | Trigger |
|--------|-----------|---------|---------|
| Setup | `<SetupScreen />` | Select game root directory | First launch (no saved root) |
| Browser | `<BrowserScreen />` | Browse airports & level files | After setup completes |
| Editor | `<EditorScreen />` | Edit flights in table + timelines | Click a level row |

Screen transitions: `useAppStore.getState().setScreen('browser')` — `App.jsx`'s `ScreenRouter` renders the corresponding component.

# AC27 Editor — Test Suite

Three-layer testing: **Vitest (component)** → **Playwright (E2E)** → **Node.js (integration)**.

Covers both **v2/v3 text-format** and **v4 GATCArc binary-format** save/load paths.

## Quick Start

```bash
npm run test:all      # Full suite: Vitest + save integrity (12 files) + E2E (~3 min)
npm test              # 497 Vitest component + store + utility + electron + MapWindow + updater tests (~4s)
npm run test:e2e      # 15 Playwright E2E tests (requires npm run build first, ~3 min; 1 skipped — E12a overlay timing)
node tests/integration/test_api_server.js      # MCP/API tests: 105 tests (~1s)
node tests/integration/test_api_e2e_examples.js # MCP E2E examples: 44 tests (~1s)

# Save integrity — all .acl files across both airports:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo

# v4 GATCArc binary round-trip (all airports):
node tests/integration/test_gatcarc_roundtrip.js

# Type number integrity (uses fixture):
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js
```

---

## Layer 1 — Vitest Component Tests (501 tests)

Tests run in jsdom with mocked `window.electronAPI`. No Electron needed. Some electron-backend tests use `@vitest-environment node` (see `cloud-llm.test.js`, `updater.test.js`).

### `npm test` — 497 pass (29 test files)

| File | Tests | What it validates |
|------|-------|-------------------|
| `utils/timeUtils.test.js` | 23 | `ticksToTime` (0/0n/""→""; ticks→HH:MM:SS), `timeToTicks` (empty→0; "HH:MM:SS"→ticks; baseDate offset), `timeToMinutes` ("01:30"→90), `timeToSeconds` ("01:00:00"→3600), `minutesToTimeStr` (90→"01:30:00"; 1500 wraps to "01:00:00"), `sortTimelineByTime` (sorts by time field), `getTimelineActiveRange` (no bounds→all active; bounds→filters), `getDefaultTime` (midpoint "06:00"+"10:00"→"08:00:00"; none→"12:00:00"), `_extractBaseDateFromText` (BaseTime match; WorldState fallback; FALLBACK_BASE_DATE_TICKS), `isValidTimeStr` (valid/invalid/edge) |
| `utils/validators.test.js` | 22 | `validateCallsigns` — no dupes→[]; dupes detected; empty callsigns ignored; each dupe listed once; empty array→[]. `validateTimes`: time-order checks (arrival: Landing < InBlock; departure: OffBlock < Takeoff), start-time bounds (≥config.startTime, ≤config.endTime), end-time bounds, edge cases. `validateField`: airline-code non-empty, flight-number regex, stand exists, aircraft non-empty, reg non-empty, runway exists in config. `validateAll`: runs all validators, aggregates errors. `getValidationState`/`getFieldError` derived selectors. |
| `store/flightDefaults.test.js` | 56 | `randomPick`: null/undefined/empty→null, single/multi→valid. `pickRandomAirlineCode`: audio first→AirlineCode fallback→AirlineName→'NEW'; key regression: never 'NEW' when AirlineCode dropdown populated. `pickRandomFlightNumber`: from `_flightNums`, '1' fallback. `pickRandomUnusedStand`: unused only, reuse when all taken, empty when no stands. `pickFirstFlightNumber`/`pickDefaultAirlineCode` (existing): first-element behaviour preserved. `makeEmptyFlight`: 15 empty-string fields. `computeDefaultBaseMin`: config end time−offset, clamp≥0. `minutesToTimeString`: HH:MM:00 format. `createDefaultFlight`: random airline+cascaded aircraft/reg+non-conflicting stand; arrival vs departure direction. `createArrivalFlight`: LandingTime<InBlockTime (5 min gap), no departure times. `createDepartureFlight`: OffBlockTime<TakeoffTime (5 min gap), no arrival times. Stand conflict forwarding. |
| `store/appStore.test.jsx` | 25 | Screen starts at "setup"; `setScreen` transitions; modal defaults closed; `showModal`/`hideModal`; toast defaults empty; `showToast` sets message+type; `initializeEditor` sets path/flights/airport; `modified` starts false; `addArrivalFlight` creates row with randomized cascade (airline from dropdown, valid aircraft/reg, non-conflicting stand); `addArrivalFlight` regression: airline never "NEW" when AirlineCode dropdown populated; stand conflict avoidance with existing flights; `selectedIndices` starts empty; `toggleSelection` add/remove; `toggleSelectAll` checks all/clears all; **Chat state (10):** panel defaults closed, vendors setup step, empty config, toggle open/closed, add+clear messages, sending state, set+clear errors, chat config, setup step change |
| `components/common/Modal.test.jsx` | 6 | Returns null when closed; renders title+body when open; `hideModal` called on overlay click; click inside modal box does NOT close; renders actions prop; body as React elements |
| `components/common/Toast.test.jsx` | 4 | Renders empty by default; shows message when set; applies CSS class from type; `.show` class toggles with message |
| `components/BrowserScreen/BrowserScreen.test.jsx` | 28 | Version mismatch detection: no mismatch, mismatch shown with Re-Scan button, re-scan triggers refresh, re-scan failure toast. **Help Button (5):** renders in header, click opens overlay, Escape closes, backdrop click closes, close button works. **Debug Mode (4):** renders toggle button, shows active state when installed, tooltip on hover, disabled while loading. **Livery Install (7):** renders button, tooltip on hover, progress overlay + disabled state, download+install success, fallback to file dialog on download fail, cancel after download fail, install error toast. **Demo File Filtering (3):** hides whitelisted .demo files in non-demo mode, hides non-whitelisted .demo files, shows whitelisted .demo files in demo mode |
| `components/BrowserScreen/VideoBackgroundModal.test.jsx` | 13 | Video background replace/restore confirmation modal: renders when show=true, Cancel calls onCancel, Replace calls onReplace, Restore calls onRestore, hides when show=false, renders Chinese translations. **Full workflow (7):** download progress tracking, conversion progress tracking, success closes overlay, error on conversion failure, error when no folders found, retry on error, error overlay closeable via Escape + close button. |
| `components/BrowserScreen/BrowserHelpOverlay.test.jsx` | 9 | Help overlay renders title + section headings (Header Buttons/Airport/Levels), all button descriptions, inline button icons, Escape/backdrop/close-button dismissal, Chinese translations |
| `components/BrowserScreen/VideoReplaceOverlay.test.jsx` | 6 | Renders progress bar + percentage; closes immediately on successful completion; shows error when conversion fails; shows error when no folders found; Escape key closes error overlay; renders progress bar in Chinese |
| `components/BrowserScreen/BepInExInstallOverlay.test.jsx` | 7 | Progress bar + percentage; success closes overlay; error on failure; Escape closes error; close button works; localized NO_GAME_ROOT error; progress events update UI |
| `components/BrowserScreen/useTooltip.test.jsx` | 9 | Tooltip renders/clears on hover; text switches between buttons; positions above target; flips below when no room above; centres on button; right-pins at viewport edge; width computed from text (per-char glyph widths) |
| `components/EditorScreen/EditorTooltip.test.jsx` | 8 | Editor BUTTONS registry completeness (all descKeys, all icons, all required buttons); tooltip integration on editor toolbar buttons |
| `components/EditorScreen/FlightTable/FlightTable.test.jsx` | 6 | Click on data cell → no selection toggle; checkbox click → toggles; drag from data cell → range-selects; dropdown/time cell clicks → no toggle; clock portal click → no toggle |
| `components/EditorScreen/StandMap/StandMap.test.jsx` | 22 | Stand dots/labels count, selected highlight + ring, occupied plane icons + callsign labels, click-to-select, hover states, empty/null stands, legend, shrink button, portal positioning, animations, rotation on planes, disabled stands, backward-compatible no-heading, cargo-stand labels (SGSE), text clipping |
| `electron/bepinex.test.js` | 22 | checkStatus (null, partial, full, empty); findDownloadUrl (URL extraction, artifact not found, HTTP error); downloadZip (happy path — file content + progress 0→100%, incremental multi-chunk progress, HTTP 404 rejects + file cleanup, network error rejects + cleanup, timeout rejects + cleanup); extractZip (non-Windows guard); installFiles (subdirectory, missing items, flat structure); removeFiles (all items, partial, non-existent); installLatest (full pipeline, error cleanup, download progress normalization) |
| `integration/stand_positions.test.js` | 7 | `_parseStandPositions` unit tests: ZSJN fixture parsing (53 stands), structure validation (position arrays, labels, disabled flags, airline assignments), edge cases (null/empty input) |
| **Electron backend (existing):** | **74** | |
| `electron/cloud-llm.test.js` | 49 | Multi-vendor cloud LLM module. **VENDORS registry (6):** all 4 vendors have name/icon/models/baseURL, model list matches expectations. **getVendorForModel (10):** resolves all 8 models to correct vendor key+name, null for unknown/empty, baseURL present for non-Claude. **getAvailableModels (4):** empty when no keys set, filters by key presence, returns all 8 models when all keys configured. **mcpToolsToOpenAITools (3):** MCP→OpenAI function format conversion, preserves minItems/maxItems. **sanitizeToolsForVendor (6):** strips OpenAI-only keywords (minItems/maxItems/default/const) for Gemini, recursive stripping of nested items, leaves non-Gemini unchanged. **chat entry errors (5):** unknown model throws, missing/empty API key throws per vendor. **chat success OpenAI path (2):** single-turn response, existing system message preserved. **tool calling loop (3):** multi-turn tool calls→final text, tool error recovery, malformed JSON arguments. **conversation tracking (1):** multi-tool conversation grows correctly across iterations. **Gemini sanitization via chat (1):** keywords stripped before Gemini API call. **Claude Anthropic path (4):** basic chat, tool→input_schema format conversion, tool_use loop, tool error handling. **thinking (3):** Claude thinking blocks + DeepSeek reasoning_content passed through, accumulation across tool turns. **empty-content nudge (2):** OpenAI + Claude nudged when only thinking returned. |
| `electron/updater.test.js` | 25 | Auto-update module. **computeFileMd5 (3):** known content hash, different content produces different hashes, rejects on non-existent file. **isUpdateSupported (4):** true on win32+packaged+PORTABLE_EXECUTABLE_FILE, false when not packaged, false on darwin, false when PORTABLE_EXECUTABLE_FILE not set. **createUpdaterScript (3):** generates .bat with expected commands, handles paths with spaces, cleans up stale .old before rename. **checkForUpdate (3):** no update when not supported, no update when exe missing, skipped etag recognized. **resolveTargetExe (5):** PORTABLE_EXECUTABLE_FILE, execPath fallback, AC27_UPDATE_TARGET in dev, auto-discovered artifact, null when no candidate. **checkForUpdate gates (5):** packaged but not portable, dev with AC27_UPDATE_TARGET, dev by default (opt-out), dev with AC27_UPDATE_DEV_CHECK=1, dev with no target exe. **installUpdate dev dry-run (2):** defaults to dry-run in dev, dry-run skips spawn+quit. |
| **MapWindows (10 files):** | **154** | |
| `components/MapWindows/voiceNumberParser.test.js` | 21 | `parseEnglishFlightNumber`: individual digits, "oh"→0, teens, grouped pairs, "triple X"/"double X" aviation shorthand, stop at non-numbers, >6-digit filter, empty input. `parseChineseFlightNumber`: 幺-series, 一-series, 洞/两/零 variants, multi-token, stop at non-digits. `generateCallsignCandidates` |
| `components/MapWindows/voiceCallsignParser.test.js` | 19 | `detectLanguage`: EN/ZH/empty/mixed. `parseCallsign` (EN): "united eleven eleven"→UAL1111, full airline name, 3-letter code, "delta"→DAL, KLM, longest-match priority, teen numbers, callsign-only (no command), null on no-match/empty. `parseCallsign` (ZH): 东方/中国东方航空/国航 with digits |
| `components/MapWindows/voiceCommandMatcher.test.js` | 21 | Exact alias matching (EN): cleared to land, clear for takeoff, go around, line up and wait, contact ground/tower, push back, taxi via with sub-item, stand by, hold position. Fuzzy fallback with partial word overlap. Chinese aliases: 可以落地/可以起飞/复飞/联系地面/等待/穿越跑道. `buildSpeechGrammar` JSGF output |
| `components/MapWindows/SimClock.test.jsx` | 5 | Null/0/undefined → null output; valid timestamp → HH:MM:SS UTC; midnight → "00:00:00" |
| `components/MapWindows/useSvgZoom.test.js` | 22 | Init state, auto-init on data load, zoomIn/zoomOut bounds + center, panLeft/panRight/panUp/panDown with clamping, wheel zoom cursor-centered, drag pan start, reset functions preserve zoom + axis |
| `components/MapWindows/useUdpAircraftState.test.js` | 6 | Default state, subscribe on mount, unsubscribe on unmount, handler updates state, null/undefined safety, missing API methods |
| `components/MapWindows/SpinKnob.test.jsx` | 16 | Rendering with/without label, SVG structure (bezel, face, ticks, center, indicator, arrow), position→angle mapping at 0/0.5/1/clamp, indicator sync, scroll up/down direction, click-reset |
| `components/MapWindows/ControlSidebar.test.jsx` | 6 | 3 spin knobs rendered, actions section, children in actions, airspaceKnob optional, label presence |
| `components/MapWindows/GroundMapWindow.test.jsx` | 19 | Loading/error states, data fetch args, window title, SVG rendering, aircraft filtering (airborne y>1, stand proximity), Show All toggle, click-to-select UDP command, taxiway polylines, runway polygons, non-aircraft type=0 filtered out, type=4 (unknown) renders |
| `components/MapWindows/AirMapWindow.test.jsx` | 19 | Loading/error states, border overlay, airport mismatch filter, airborne filter, click-to-select UDP command, bg image toggle, range rings, runway thresholds, route polylines, toggle states, emergency double-click, airspace knob, non-aircraft entity filtering (type=0 excluded, type=4 shown), v4 active-runway variant filtering |

### Expected outcomes

| Category | Expected |
|----------|----------|
| Time utils | All conversions round-trip correctly. Edge cases (null, empty, overflow) handled without throw. |
| Validators | Duplicate callsigns detected; no false positives on empty values. Time-order validation enforces Landing<InBlock and OffBlock<Takeoff. Start/end-time bounds checked against config. Field-level validators cover airline, flight number, stand, aircraft, reg, runway. Aggregate `validateAll` calls all validators. |
| Store | All actions produce correct state transitions. `modified` flag set on mutations. Chat panel open/close, messages, errors, config, and setup steps all correctly managed. |
| Modal | Opens/closes via store state. Backdrop click calls `hideModal`. Internal clicks stop propagation. |
| BrowserScreen | Version mismatch detection, help overlay, debug mode toggle, livery install flow, demo file filtering (whitelisted/non-whitelisted .demo files hidden in non-demo mode, shown in demo mode), tooltip positioning. |
| Toast | Renders based on store state. `show` CSS class controls visibility. |
| Electron — cloud-llm | All VENDORS entries consistent. Model→vendor lookup correct for all 8 models. getAvailableModels filters by key presence. MCP→OpenAI tool conversion preserves schema keywords. Gemini sanitization strips OpenAI-only keywords recursively. Chat throws on missing key / unknown model. OpenAI chat completes single-turn, multi-turn tool loops, handles tool errors. Claude chat uses Anthropic SDK format (tools→input_schema, system top-level). Thinking blocks accumulated and passed to callback. Empty-content nudge triggers when model returns thinking-only. |
| Electron — updater | MD5 computed correctly. Platform/package gates prevent unsupported updates. createUpdaterScript generates valid .bat with path-safe quoting + stale .old cleanup. checkForUpdate gates correctly: skips non-portable, enforces dev opt-in (AC27_UPDATE_DEV_CHECK / AC27_UPDATE_TARGET), reaches HEAD when past gates. resolveTargetExe resolves correctly for all modes. installUpdate defaults to dry-run in dev mode. |
| Map Window hooks | `useSvgZoom` zoom/pan bounded correctly, imperative API functions. `useUdpAircraftState` lifecycle clean. |
| Map Window components | Loading/error states render correctly. Aircraft filtering logic (airborne, stand proximity, airport match). v4 active-runway variant filtering. Click-to-select sends correct UDP command. Toggle buttons toggle state. |
| Voice parsers | Spoken numbers → digits correct for EN (individual, teens, tens, triple/double shorthand) and ZH (幺/洞/两 variants). Callsign extraction matches airline name→ICAO + number against live aircraft. Command matching: exact aliases hit with score 1.0, fuzzy partial-word overlap recovers unmatched phrases, ZH aliases match character-for-character. |

### Known Vitest failures (none)

All 497 tests pass. The three previously failing/todo items have been fixed:

1. **BepInExInstallOverlay — escape key closes error overlay**: Fixed by dispatching `keyDown` on `document.body` instead of `document` (capture-phase listener was never triggered when dispatching directly on document).

2. **AirMapWindow — renders route polylines when paths are provided**: Fixed by adding `_runwayList: ['19']` to the mock data so the component's runway filter doesn't suppress all STAR variants.

3. **downloadZip — tested indirectly via installLatest (todo)**: Replaced the empty skeleton test and `it.todo` with 5 proper direct tests (happy path + file flush fix, incremental progress, HTTP 404, network error, timeout). The production `file.end()` callback was also added to wait for the write stream flush before resolving the promise.

---

## Layer 2 — Playwright E2E Tests (15 pass, 1 skipped)

Launches the real Electron app against a temp copy of real game data (via `E2E_GAME_ROOT` env var set by `run-all.mjs`). File isolation is guaranteed — the real game installation is never touched.

### `npm run test:e2e` — requires `npm run build` first, Playwright + Electron capable environment

⚠ **Known limitation**: The E2E suite requires an interactive display (X11/Wayland/Windows desktop) for Electron to render. In headless/CI environments without a display server, the first test (B1 — airport list) fails with a worker teardown timeout. Run locally on a desktop machine.

### Browser Screen (4 tests)

| ID | Test | Expected |
|----|------|----------|
| **B1** | Airport list shows up | At least 1 `.level-row` visible after launch |
| **B2a** | Level rows display correctly | Each row has non-empty text content (name, time range, stats) |
| **B3d** | Language toggle | Button click changes UI text (EN↔ZH) |
| **B3e** | Theme toggle | Theme button visible and clickable |

### Editor — Flight Table (3 tests)

| ID | Test | Expected |
|----|------|----------|
| **E1b** | Select-all toggles checkboxes | All checkboxes checked after first click; all unchecked after second click |
| **E4a** | Add Arrival flight | Row count increases by ≥1 after clicking "Add Arrival" |
| **E4c** | Delete selected flights | Row count decreases after selecting a row + clicking Delete + confirming modal |

### Editor — Timeline (3 tests)

| ID | Test | Expected |
|----|------|----------|
| **E6c** | Weather add row | Expand weather section → click Add → row count increases |
| **E6f** | Wind add row | Expand wind section → click Add → row count increases |
| **E7a** | Runway checkboxes | Expand runway section → at least 1 checkbox visible (ZSJN has runway config) |

### Editor — File Operations (2 tests)

| ID | Test | Expected |
|----|------|----------|
| **E10a** | Save (Ctrl+S) | Save completes; success modal dismissible |
| **E8a** | Manual backup | Click Backup → `.acl.bak` file created in temp dir |

### Editor — Chrome (2 tests)

| ID | Test | Expected |
|----|------|----------|
| **E12a** | Help button | Click "Help" → tutorial overlay appears; Escape closes it (⚠ occasionally skipped — overlay selector timing) |
| **E12d** | Back button (no changes) | Click Back → returns to Browser screen without unsaved-changes modal |

### Save Integrity — single file (1 test, fixture-based)

| ID | Test | Expected |
|----|------|----------|
| **S1** | No-change save round-trip | Open level → Ctrl+S (no edits) → compare `.acl` vs `.acl.bak`: GUIDs regenerated (132 diffs), $ids shifted, flight data identical (48 flights, 24 weather, 4 wind) |

### Save Integrity — all 12 prod+demo files (E2E, requires `E2E_GAME_ROOT`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **S1b** | `save-integrity-all-e2e.spec.mjs` | 8 production + 4 demo across ZSJN + KJFK | 12 passed, 0 skipped |

```bash
# Run standalone (requires E2E_GAME_ROOT env var):
$env:E2E_GAME_ROOT = "<game-root>"
npx playwright test --config=playwright.config.mjs tests/e2e/save-integrity-all-e2e.spec.mjs
```

Iterates every level row in the browser: open → disable time validation → Ctrl+S → confirm → run checker → go back → repeat. Takes ~2.5 minutes for 12 files.

| File | Status | Note |
|------|--------|------|
| ZSJN-Morning_120min | ✓ | 48 flights, all state identical |
| ZSJN-Morning_120min.demo | ✓ | Save completes, flight data intact. Demo saves round endTime to nearest :X0/:X5 and strip CurrentDateTime content — flight data preserved. |
| ZSJN_07-10 | ✓ | 60 flights, all state identical |
| ZSJN_07-10.demo | ✓ | Same demo behavior as above (endTime rounded to nearest :X0/:X5) |
| ZSJN-Evening_120min | ✓ | 48 flights |
| ZSJN_19-21 | ✓ | 72 flights |
| KJFK_07-09 | ✓ | 52 flights |
| KJFK_09-11 | ✓ | 56 flights |
| KJFK_09-11.demo | ✓ | 56 flights, endTime rounded to nearest :X0/:X5 |
| KJFK_17-20 | ✓ | 63 flights |
| KJFK_20-22 | ✓ | 57 flights |
| KJFK_20-22.demo | ✓ | Same demo behavior as above (endTime rounded to nearest :X0/:X5) |

---

## Layer 3 — Node.js Integration Tests (28 scripts)

Standalone scripts in `tests/integration/`. Run directly with `node`. Some need `--require ./tests/integration/preload.cjs` for ESM interop.

### MCP / API server tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_api_server.js` | 105 | All 7 HTTP endpoints (status, airport/values, flights, create-batch, modify-batch, delete-batch, validation) + MCP protocol (initialize, tools/list, 7 tools/call) + 12-point validation suite (airline, flight number, stand, runway, aircraft compat, STAR compat, registration pair, time bounds, time order, duplicate callsigns, stand conflicts, duplicate registrations) + cascade logic + AND-match regression tests. Mock Electron window — no real app needed. | 105/105 pass |
| `test_api_e2e_examples.js` | 44 | 7 composition scenarios from the MCP skill (Section 8): create batch flights, modify by airline, delete by type+time, time shift, Chinese-language create/modify, validation rejection + recovery. | 44/44 pass |

### New parser module tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_demo_filter.js` | 13 | Demo-level flight filtering: `detectSchemaVersion` (v2/v3 vs v4), `extractCurrentDateTime` (GameTime.CurrentDateTime + MetaData.BaseTime paths), config-based flight filtering (v4 fallback respects `startTime`/`endTime`), 30-min window (v2/v3 existing behavior) | 13/13 pass |
| `test_tokenizer.js` | 18 | String-aware tokenizer: `findSection`, `findArrayEnd`, `findObjectEnd`, `skipString`, `getTopLevelKeys` against synthetic and real ACL patterns | 18/18 pass |
| `test_acl_json.js` | 25 | JSON pre-processor + serializer round-trips: `_fixTrailingCommas`, `_fixSpecialFloats`, `_fixTypedValues`, `preprocessUnityJson`, `serializeUnityJson` | 25/25 pass |
| `test_acl_document.js` | 13 | `AclDocument` model: section indexing, round-trip serialization, init from JSON | 13/13 pass |
| `test_sid_goaround.js` | 19 | SID (Type=2), Missed Approach (Type=3), and APPR (Type=1) route parsers: `extractSidRunwayMappings`, `extractMissedApproachMappings`, `buildSidPaths`, `buildMissedApproachPaths`, `extractApprRunwayMappings`, `buildApprPaths` — synthetic edge cases + v4 runway-scoped resolution | 19/19 pass |
| `test_taxiway.js` | 10 | `parseTaxiwayPaths`: ACL structure parsing, flag values (1/2/4), stand-node marking, ZSJN fixture (582 paths, 189 named) | 10/10 pass |

| `test_save_roundtrip_diff.js` | 26 | Approach-block round-trip diff: T1 `RunwayTakeOffLength` nullish coalescing (0 preserved, missing→2000), T2 `ModelOffset` float3 tuple format (no named x/y/z), T3 `AircraftRunwayCoordinateState` canonical-`$id` design (5 inline empty string[] arrays, unique per-array `$id`, zero `$iref`), T4 v4 spec extraction from a real v4 file (`--acl` or default `works.acl`) | 26/26 pass |
| `test_extract_v4_runway_pairs.js` | 6 | `extractV4RunwayPairs` — v4 runway pair extraction from static SceneryData `PhysicalName` ("01/19" → 01|19 + 19|01): ZSJN v4 fixture (2 pairs), KJFK (8 pairs — 4 groups), KDCA (6 pairs — 3 groups), non-v4 text → `[]`, empty/garbage input → `[]`, dedup (both ends of a physical runway → exactly 2 pairs). KJFK/KDCA cases skip when game root unavailable (`--root <game-root>`) | 6/6 pass (fixture) |

```bash
node tests/integration/test_tokenizer.js
node tests/integration/test_acl_json.js
node tests/integration/test_acl_document.js
node tests/integration/test_sid_goaround.js
node tests/integration/test_taxiway.js
node tests/integration/test_save_roundtrip_diff.js
node tests/integration/test_extract_v4_runway_pairs.js [--root <game-root>]
```

### UDP telemetry test (mock loopback server, port 20266 must be free)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_udp_listener.js` | 19 | Binary protocol parsing (40B header + N×112B records, little-endian), aircraft state tracking, trail ring buffer (600-tick gap, max 5), empty packets, bad magic rejection, flight direction 0/1, callsign trimming, reset/clear, simTimeUnixMs tracking, airport transition auto-reset, simFlags/heartbeatSeq v2 header, hasLevel transition logic | 19/19 pass (skips when port 20266 in use) |
| `test_type_number_integrity.js` | 6 | Save→reload type number stability: verifies that after generating `_rebuildWorldStateSections`, all `$type` numbers in the output match the `.bak` snapshot — catches type-number shift regressions. | 6/6 pass |
| `test_jetway_rebuild.js` | v4 files | Constructive jetway rebuild round-trip: runs `_rebuildJetwayEntries`, verifies only jetway entries in RuntimeEntities are modified (other entries preserved byte-identical). **v4-only** — v2/v3 files skipped with reason. Runnable offline against the v4 fixture (`--acl tests/fixtures/.../ZSJN-Morning_120min.v4.acl`). **Departed-stand rule**: a departure whose OffBlockTime ≤ the segment's snapshot time (`GameTime.CurrentDateTime`) is treated as already departed → empty jetway, matching the game's own entries (the 7/30/26 playtest update produces checkpoints taken after some off-block times); an unresolvable spec (no cache + empty original entry) falls back to an empty jetway instead of throwing. | 12/12 pass on the v4 game root (`--prod-demo --no-cache`); 1/1 fixture |

```bash
node tests/integration/test_udp_listener.js
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js --root <game-root>
```

### v4 GATCArc binary format tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_gatcarc_roundtrip.js` | varies × all .acl files | GATCArc4 binary round-trip: `parseArchive` validates magic/SHA-256/commit markers; `decodeArchive(bin)` → `encodeArchive(text)` → `decodeArchive` is byte-identical. For text files: `encodeTextToPayload`/`decodePayloadToText` round-trip reproduces game-written text. Type reference form (full `"N\|Name"` vs bare `N`) is normalized before comparison. Runs against every .acl in the game airports directory. | 96/96 pass (32 files × 3 checks each) |
| `test_real_kjfk_jfk5.js` | 8 per-runway STAR resolution | End-to-end JFK5.JFK STAR/SID resolution against real KJFK data: `extractStarRunwayMappings` (SIE.CAMRM5 → 3 runways), `resolveFlyApproachPoints` (6 nodes per runway), `extractSidRunwayMappings` (JFK5.JFK is in SID), `buildSidPaths`, `buildStarPaths`, verifies JFK5.JFK is NOT in APPR data. Uses `detectSchemaVersion` — works with v2/v3 or v4 format. | 8/8 pass |

```bash
# v4 GATCArc binary round-trip (scans all airports):
node tests/integration/test_gatcarc_roundtrip.js

# KJFK v4 STAR/SID diagnostic (hardcoded path — update for your game root):
node tests/integration/test_real_kjfk_jfk5.js
```

### Scan-all tests (need game root, override with `--root`)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_parse_airport.js` | varies | Parses all airports + .acl files; reports stats | All airports parse OK. EGLC/ZGSZ have 0 .acl files (dev-mode airports); KJFK/KDCA/ZSJN parse OK |
| `test_callsign_gen.js` | varies | Callsign consistency across all `flight_schedule_*.csv` files | ⚠ 1 known mismatch: AAL0101 vs AAL101 (flight number zero-padding) in KJFK CrossRunway; 19/20 files all-OK; 10 subsidiary/alternate code rows reported; 4 alpha-only rows skipped |
| `test_approach_aircraft.js` | 8 sections (T1-T8) | Approach aircraft algorithms: spec extraction, AppPoint mapping, ProgressRatio formula, FlyApproach resolution, Position/Direction reconstruction, block assembly. **Version-aware**: v4 files store no approach aircraft (runtime-generated) so the ≥20 count assertion is informational; v2/v3 files run the original assertions. | PASS on v4 game root (T1 spec cross-file consistency real; T7 skips when no State=30 types present). |

```bash
node tests/integration/test_parse_airport.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_callsign_gen.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

### Analysis / research scripts (no pass/fail — produce reports)

| File | What it validates | Expected |
|------|-------------------|----------|
| `test_compare_tat.js` | Per-STAR TAT comparison (scenery vs aircraft vs model-A): extracts approach data from 8 production .acl files, computes ground-truth TAT from aircraft pairs, calibrates Model A per airport, reports RMSE/MaxErr for scenery and model methods. | Generates 6-phase report |
| `test_scaled_tat.js` | Runway-scale-factor corrected TAT: maps game-unit path lengths to real-world meters using per-runway scale factors, compares against aircraft-pair TAT. | Generates summary table |
| `test_full_path.js` | Full path TAT: extends path length to include the entire STAR route (all AppPoints), not just FlyApproach points. | Generates comparison table |
| `scan_rlengths.js` | Scans `$rlength` values across all .acl files to detect format patterns (v2/v3 vs v4 binary, demo vs production). | Prints per-file $rlength breakdown |

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_compare_tat.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_scaled_tat.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_full_path.js [--root <game-root>]
```

### Single-ACL tests (require `--acl <path>`)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_e2e_save_load.js` | 1 round-trip | Load → snapshot → sort → save → reload → compare. Passes `detectSchemaVersion` (`isV4`) and builds the approach cache (jetway DockingPositions lookup needs it, same as the app) | Flights match after round-trip (v2/v3 + v4) |
| `test_rebuild_sections.js` | 1 rebuild | Copy → modify one flight → rebuild → validate. **Version-aware**: v4 → `_rebuildStaticDataSections` (StaticItems + binary re-encode, reload-verified); v2/v3 → `_rebuildWorldStateSections` | v4: StaticData preserved, 48 flights reload with edit; v2/v3: FlightPlans count correct, edited data present, SceneryData preserved |
| `test_acl_linkage.js` | 1 linkage | **Version-aware**: v2/v3 — every Aircraft's `FlightPlanGuid` resolves to a valid FlightPlan; v4 — StaticItems `"$k": "flight-plan:<REG>"` definitions (Registration must match the key) and every `$fstrref:"flight-plan:<REG>"` reference must resolve | 0 broken links (v2/v3: 31/31 on fixture; v4: 48 defs / 48 refs / 0 broken) |

```bash
node tests/integration/test_e2e_save_load.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_sections.js --acl <path>
node tests/integration/test_acl_linkage.js --acl <path>
```

### Timeline tests (require ACL path)

All three run on **both schema versions**: the timeline sections are schema-agnostic (v4 patches them inside `MetaData` and re-encodes the GATCArc4 binary via the `isV4` arg to `_rebuildTimelineSections`).

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_timeline_comparison.js` | varies | JSON timeline files vs ACL-embedded timeline data field-by-field | v4 fixture: 3/3 sections match. ⚠ v2/v3 fixture: weather presets differ — fixture JSONs were exported from the v4-era data, the v3 ACL predates them (JSON edited independently of the ACL) |
| `test_generate_timelines.js` | 4 sub-tests | `_generateFramesSection`, `_generateRunwayTimelineSection` produce identical output | ⚠ Known pre-existing gap (identical on both versions): generated Wind/Weather sections don't match the ACL's embedded sections 1:1 — generator format fidelity vs what the game writes; RunwayTimeline matches |
| `test_rebuild_timelines.js` | 6 sub-tests | `_rebuildTimelineSections`: WeatherFrames, WindFrames, RunwayTimeline (empty, with changes, all-three, round-trip) | v4: ALL PASSED (MetaData subsections + binary re-encode). v2/v3: pass except round-trip when the JSON source differs from the ACL-embedded data (stale JSON) |

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_timeline_comparison.js <acl-path>
node --require ./tests/integration/preload.cjs tests/integration/test_generate_timelines.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_timelines.js --acl <path>
```

### Save integrity — all .acl files

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_save_integrity_all.js` | 12 (`--prod-demo`) or 24 (`--all`) | Full save→reload→compare on every .acl file. Validates: flights (14 fields × N), config (startTime/endTime/scheduleFile), scenery maps (runway/stand counts), embedded timelines (weather/wind/runway), source format, text-level `_departureTakeoffTime` / `_arrivalInBlockTime` zero validation. Passes `detectSchemaVersion` (`isV4`) and builds the approach cache per level dir (jetway DockingPositions lookup needs it) | 12/12 pass on the v4 game root (8 prod + 4 demo): 0 field diffs, config identical, scenery identical, timelines identical |

```bash
# 8 production + 4 demo files:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo

# All .acl files across all airports (excludes Endless):
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root>
```

**File isolation flow** (golden/result pattern — real game files never modified):

```
Game root (read-only)            Temp golden/ (pristine)        Temp result/ (save target)
────────────────────────         ─────────────────────          ────────────────────────
Airports/<ICAO>/Levels/     copy →  _tmp/golden/<ICAO>/    copy →  _tmp/result/<ICAO>/
  <name>.acl               ─────→    <name>.acl            ─────→   <name>.acl
  weather_timeline.json    ─────→    weather_timeline.json          (overwritten by save)
  wind_timeline.json       ─────→    wind_timeline.json
  runway_timeline_*.json   ─────→    runway_timeline_*.json
```

1. **Copy** real .acl + timeline JSONs → `tests/integration/_tmp/golden/<icao>/`
2. **Load golden** via parser → in-memory snapshot (flights, config, scenery, timelines)
3. **Copy golden** → `tests/integration/_tmp/result/<icao>/`
4. **Save** via `generateFullAcl` on result copy — golden stays pristine
5. **Load result** via parser → compare against golden snapshot
6. **Clean up** `_tmp/` after each file (removed entirely after run)
7. **Write JSON report** → `tests/_reports_/save-integrity-<timestamp>.json`

Both `tests/integration/_tmp/` and `tests/_reports_/` are gitignored.

**Production (8):** ZSJN-Morning_120min, ZSJN_07-10, ZSJN-Evening_120min, ZSJN_19-21, KJFK_07-09, KJFK_09-11, KJFK_17-20, KJFK_20-22

**Demo (4):** ZSJN-Morning_120min.demo, ZSJN_07-10.demo, KJFK_09-11.demo, KJFK_20-22.demo

---

## Master Test Runner

```bash
npm run test:all      # or: node tests/run-all.mjs [--game-root <path>]
```

Runs all three layers sequentially (Vitest → save integrity 12 files → jetway rebuild 12 v4 files → Playwright E2E) and reports a pass/fail summary. Default game root: `D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest`.

---

## v3 vs v4 Format Coverage

The editor supports two .acl schema versions:

### v4 (GATCArc4 binary — current game format)
- All game .acl files in this installation are **v4 GATCArc4 binary** (StaticData.$blobdoc; flight plans are StaticItems dictionary entries keyed `"$k": "flight-plan:<REG>"`, referenced by `$fstrref` tokens).
- **Save integrity**: 12/12 files pass (8 production + 4 demo) — flights, config, scenery, timelines all match after save→reload through `generateFullAcl` (isV4 → `_rebuildStaticDataSections`).
- **Save/load round-trip**: `test_e2e_save_load.js` — 60/60 flights identical after load→save→load.
- **Section rebuild**: `test_rebuild_sections.js` v4 path (StaticItems rebuild + binary re-encode, reload-verified) and `test_rebuild_timelines.js` v4 path (MetaData subsection rebuild + re-encode) both pass.
- **Linkage**: `test_acl_linkage.js` v4 path — 48 flight-plan definitions self-consistent, 48 `$fstrref` references resolve.
- **Approach aircraft**: v4 static files store none (runtime-generated) — `test_approach_aircraft.js` treats the count as informational.
- **Schema detection**: `detectSchemaVersion` correctly identifies v4 via `StaticData.$blobdoc`.
- **Demo filtering**: v4 falls back to config-based (startTime/endTime) window when CurrentDateTime is unavailable — 13/13 tests pass.
- **STAR/SID parsing**: v4 runway-scoped resolution tested in synthetic tests (19/19 SID/go-around tests pass) and real KJFK data (8/8 pass).

### v2/v3 (text JSON — older game format, fixture-only coverage)
- **Fixture**: `tests/fixtures/game-root/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN-Morning_120min.acl` (+ `.demo.acl`) are v2/v3 text; the sibling `ZSJN-Morning_120min.v4.acl` is the v4 fixture.
- **Save/rebuild**: `test_rebuild_sections.js` v2/v3 path — `_rebuildWorldStateSections` rebuilds FlightPlans/Aircrafts, preserves SceneryData/RunwayTimeline (11/11 checks).
- **Linkage**: `test_acl_linkage.js` v2/v3 path — 31 Aircraft entries, all `FlightPlanGuid`s resolve.
- **Approach aircraft**: v2/v3 files carry State=30 entries — `test_approach_aircraft.js` runs the original ≥20 count assertions on them.
- **Schema detection**: `detectSchemaVersion` correctly identifies v2/v3 (WorldState present, no StaticData.$blobdoc).
- **Timeline**: section patching is in-place text; ⚠ the fixture's weather JSONs were exported from the v4-era data, so comparison/round-trip against the older v3 ACL shows preset diffs (JSON edited independently of the ACL).

---

## E2E File Isolation

E2E tests **never touch real game files**. All reads and writes go through temp copies, sourced from the real game installation via `E2E_GAME_ROOT` (set by `run-all.mjs`):

```
Real game root (read-only)      tests/tmp-e2e/                  tests/tmp-e2e-userdata/
                                (gitignored, fresh each run)    (gitignored)
────────────────────────  copy   ─────────────────────
<game>/Airports/         ─────→  ZSJN/ + KJFK/          lastRoot.json → { rootPath: "tmp-e2e" }
  ZSJN/                            airport_config.json
  KJFK/                            Levels/              Electron launched with:
                                     *.acl                --user-data-dir=tmp-e2e-userdata/
                                     *.json               AC27_E2E_TMP_DIR=tmp-e2e
```

1. **`global-setup.mjs`**: copies 12 prod+demo files from real game → `tmp-e2e/`, writes `lastRoot.json`
2. **Fallback**: if `E2E_GAME_ROOT` is not set, falls back to `tests/fixtures/game-root/` (ZSJN-only)

**Fixtures** (`tests/fixtures/game-root/.../ZSJN/Levels/`): `ZSJN-Morning_120min.acl` (v2/v3 text) and `.demo.acl` (v2/v3) provide offline v2/v3 coverage; `ZSJN-Morning_120min.v4.acl` (v4 GATCArc4 binary) is the offline v4 sample used by the v4-only tests (`test_jetway_rebuild`, `test_acl_linkage` v4 path, `test_rebuild_sections`/`test_rebuild_timelines` v4 paths, `test_save_roundtrip_diff` T4 via `--acl`).
3. **Electron launch**: `--user-data-dir=tmp-e2e-userdata/` isolates user config from real app
4. **Setup skip**: app reads `lastRoot.json` → goes straight to BrowserScreen (no native OS dialog)
5. **All I/O in temp**: saves, backups (`.bak`), timeline JSON writes all land in `tmp-e2e/`
6. **`AC27_E2E_TMP_DIR`**: env var tells `manual-backup` IPC to skip native save dialog in test mode
7. **`global-teardown.mjs`**: removes both `tmp-e2e/` and `tmp-e2e-userdata/` after run

### Integration test file isolation

The `test_save_integrity_all.js` script uses a **golden/result pattern**:

| Directory | Role | Modified? | Cleaned up? |
|-----------|------|-----------|-------------|
| Real game root (`Airports/<ICAO>/Levels/`) | Source of truth | **Never** | N/A |
| `tests/integration/_tmp/golden/<ICAO>/` | Pristine copy (.acl + timeline JSONs) | **Never** | Yes, after each file |
| `tests/integration/_tmp/result/<ICAO>/` | Save target (copy of golden) | **Yes** (overwritten by `generateFullAcl`) | Yes, after each file |
| `tests/_reports_/` | JSON report output | N/A | No (committed reports optional) |

---

## Test Infrastructure Files

| File | Purpose |
|------|---------|
| `setup.js` | Global mocks: `window.electronAPI` (33+ IPC methods + video replacer + UDP listeners), `matchMedia`, `scrollIntoView`, `ResizeObserver`. Guarded with `typeof window !== 'undefined'` so node-environment tests can opt in with `@vitest-environment node`. |
| `__mocks__/zustand.js` | Auto-reset all zustand stores to initial state between Vitest tests |
| `integration/preload.cjs` | ESM→CJS transpiler for tests that `require()` ESM source modules |
| `save-integrity-check.js` | S1-S3 diff analysis: compare .acl vs .bak, categorize diffs, parser round-trip, text-level takeoff/inblock time validation |
| `e2e/global-setup.mjs` | Copy fixtures → temp, pre-write `lastRoot.json` |
| `e2e/global-teardown.mjs` | Clean up temp dirs |
| `integration/test_save_integrity_all.js` | Save→reload→compare on all .acl files (supports `--prod-demo` for 12 specific files) |
| `integration/test_jetway_rebuild.js` | Constructive jetway rebuild — verifies `_buildActiveJetwayEntry` only-modifies-jetway invariant across 12 v4 prod+demo files |
| `run-all.mjs` | Master test runner — executes all 3 layers sequentially |

### Root config files

| File | Purpose |
|------|---------|
| `vitest.config.js` | jsdom environment, React plugin, globals |
| `playwright.config.mjs` | Electron E2E, serial workers, global setup/teardown |

---

## Adding New Tests

### Vitest component test
1. Create `tests/components/<ComponentName>/<Name>.test.jsx` (or `tests/electron/<Name>.test.js` for backend modules)
2. Import from `../../src/...`
3. Use `useAppStore.setState()` to inject state
4. Render with React Testing Library
5. For Node.js backend modules that `require()` ESM packages: use `// @vitest-environment node` at the top of the test file and prime `require.cache` to stub dependencies (see `tests/electron/cloud-llm.test.js` for the pattern)

### Playwright E2E test
1. Create `tests/e2e/<name>.spec.mjs`
2. Launch Electron with `env: { AC27_E2E_TMP_DIR: process.env.E2E_TMP_DIR }`
3. Use `.locator()` for selectors — prefer `#id` or `[title="..."]` over text

### Integration test
1. Create `tests/integration/test_<name>.js`
2. Use `require('../../src/acl/...')` for source modules
3. Use `--require ./tests/integration/preload.cjs` if the module uses ESM imports
4. Follow existing patterns: `check()`/`assert()` helpers, `process.exit(0/1)`

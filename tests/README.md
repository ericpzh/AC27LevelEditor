# AC27 Editor — Test Suite

Three-layer testing: **Vitest (component)** → **Playwright (E2E)** → **Node.js (integration)**.

Covers the **v4 GATCArc binary-format** save/load path (v2/v3 text-format support has been removed).

## Quick Start

```bash
npm run test:all      # Full suite: Vitest (1203) + save integrity (21) + jetway rebuild (16) + runway pairs (5) + E2E (17, ~5 min)
npm test              # 1203 Vitest component + store + utility + electron + MapWindow + updater tests (~7s)
npm run test:e2e      # 17 Playwright E2E tests (requires npm run build first, ~4 min; 15 pass, 2 skipped — E12a overlay timing + fuzz gated on FUZZ_RUN)

# Fuzz save test — randomized edit storms (50–200 ops/level) + real SAVE w/ backup
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz     # all 20 production levels (see "Fuzz Save" section for options)

node tests/integration/test_api_server.js      # MCP/API tests: 109 tests (~1s)
node tests/integration/test_api_e2e_examples.js # MCP E2E examples: 44 tests (~1s)

# Save integrity — all .acl files across both airports:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo

# v4 GATCArc binary round-trip (all airports):
node tests/integration/test_gatcarc_roundtrip.js

# Type number integrity (uses fixture):
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js
```

---

## Layer 1 — Vitest Component Tests (1203 tests)

Tests run in jsdom with mocked `window.electronAPI`. No Electron needed. Some electron-backend tests use `@vitest-environment node` (see `cloud-llm.test.js`, `updater.test.js`).

### `npm test` — 1203 pass (52 test files)

| File | Tests | What it validates |
|------|-------|-------------------|
| `utils/timeUtils.test.js` | 29 | `ticksToTime` (0/0n/""→""; ticks→HH:MM:SS), `timeToTicks` (empty→0; "HH:MM:SS"→ticks; baseDate offset), `timeToMinutes` ("01:30"→90), `timeToSeconds` ("01:00:00"→3600), `minutesToTimeStr` (90→"01:30:00"; 1500 wraps to "01:00:00"), `sortTimelineByTime` (sorts by time field), `getTimelineActiveRange` (no bounds→all active; bounds→filters), `getTimeValidationBounds` (5): OffBlockTime/LandingTime max = end+30min grace, generic Time strict, InBlockTime/TakeoffTime null, null when config missing, `getDefaultTime` (midpoint "06:00"+"10:00"→"08:00:00"; none→"12:00:00"), `_extractBaseDateFromText` (BaseTime match; WorldState fallback; FALLBACK_BASE_DATE_TICKS), `isValidTimeStr` (valid/invalid/edge) |
| `utils/starDisplay.test.js` | 13 | **STAR/SID display dedup** — `stripStarRunwaySuffix` (ZGSZ-style `.34L`/`.33`/`.15` stripped, plain names like `ABTU6W`/`WFG91A` untouched, non-string passthrough), `hasStarRunwaySuffix`, `dedupeStarPathsForDisplay` (runway-suffixed variants merged under the base STAR/SID name with representative longest route + all runways; non-suffixed STARs keep per-runway variants; null/empty→{}), `filterDedupedStarPathsByRunway` (group kept when any runway active; merged `runways` array + preserved singular `runway` handled) |
| `utils/validators.test.js` | 38 | `validateCallsigns` (5): no dupes→[]; dupes detected; empty callsigns ignored; each dupe listed once; empty array→[]. `detectStandConflicts` (17): overlap rules (arr/arr allowed, dep/dep flagged, offblock < landing OK / = landing flagged, 20-min default start), conflict messages contain both callsigns + stand with normalized times. `runTripleValidation` (11): v4 semantics — time-order checks (InBlockTime/TakeoffTime) always skipped; dropdown + stand-conflict validations still run; time range — end+30min grace (exact boundary 22:30 accepted, 22:31 flagged, minute-carry 22:45→23:15, start bound still strict). **STAR-required (4):** blocks arrivals without a STAR (game drops STAR-less arrival legs at load), allows arrivals with a STAR, no STAR requirement on departures, rule skipped when no `_starRunwayMap` data is cached. `getActiveColumns` (2): v4 hides InBlockTime/TakeoffTime columns. `_isNew` stripping (3): JSON replacer (mirrors electron main timeline sidecar writers) removes `_isNew` at all nesting levels, preserves other keys. |
| `store/flightDefaults.test.js` | 70 | `randomPick`: null/undefined/empty→null, single/multi→valid. `pickRandomAirlineCode`: audio first→AirlineCode fallback→AirlineName→'NEW'; key regression: never 'NEW' when AirlineCode dropdown populated. `pickRandomFlightNumber`: from `_flightNums`, '1' fallback. `pickRandomUnusedStand`: unused only, reuse when all taken, empty when no stands. `pickFirstFlightNumber`/`pickDefaultAirlineCode` (existing): first-element behaviour preserved. `makeEmptyFlight`: 15 empty-string fields. `computeDefaultBaseMin`: config end time−offset, clamp≥0. `minutesToTimeString`: HH:MM:00 format. `createDefaultFlight`: random airline+cascaded aircraft/reg+non-conflicting stand; arrival vs departure direction; `isDeparture` set from type; `AirlineName` = picked airline code (game stores codes, e.g. 'CCA', never the empty AirlineName dropdown); **STAR/`Airway` (3):** arrivals get a STAR from `_runwayStarMap` constrained to the picked runway (even when `values.Airway` is empty — SceneryData source), departures ALWAYS leave `Airway` empty (never inherit the airport-wide STAR list; SID is derived at runtime from the runway — save only writes STAR on arrival legs). `createArrivalFlight`: sets LandingTime, leaves InBlockTime empty (v4 stores it as 0), no departure times, forwards existingFlights for stand-conflict avoidance. `createDepartureFlight`: sets OffBlockTime, leaves TakeoffTime empty (v4 stores it as 0), no arrival times. Stand conflict forwarding. |
| `store/appStore.test.jsx` | 26 | Screen starts at "setup"; `setScreen` transitions; modal defaults closed; `showModal`/`hideModal`; toast defaults empty; `showToast` sets message+type; `initializeEditor` sets path/flights/airport; `modified` starts false; `addArrivalFlight` creates row with randomized cascade (airline from dropdown, valid aircraft/reg, non-conflicting stand); `addArrivalFlight` regression: airline never "NEW" when AirlineCode dropdown populated; stand conflict avoidance with existing flights; `addArrivalFlight` leaves InBlockTime empty (v4 stores it as 0); `selectedIndices` starts empty; `toggleSelection` add/remove; `toggleSelectAll` checks all/clears all; **Chat state (9):** panel defaults closed, vendors setup step, empty config, toggle open/closed, add+clear messages, sending state, set+clear errors, chat config, setup step change |
| `components/common/Modal.test.jsx` | 6 | Returns null when closed; renders title+body when open; `hideModal` called on overlay click; click inside modal box does NOT close; renders actions prop; body as React elements |
| `components/common/Toast.test.jsx` | 4 | Renders empty by default; shows message when set; applies CSS class from type; `.show` class toggles with message |
| `components/BrowserScreen/BrowserScreen.test.jsx` | 25 | Version mismatch detection: no mismatch, mismatch shown with Re-Scan button, re-scan triggers refresh, re-scan failure toast. **Help Button (5):** renders in header, click opens overlay, Escape closes, backdrop click closes, close button works. **Debug Mode (4):** renders toggle button, shows active state when installed, tooltip on hover, disabled while loading. **Livery Install (7):** renders button, tooltip on hover, progress overlay + disabled state, download+install success, fallback to file dialog on download fail, cancel after download fail, install error toast. **Demo File Filtering (3):** hides whitelisted .demo files in non-demo mode, hides non-whitelisted .demo files, shows whitelisted .demo files in demo mode |
| `components/BrowserScreen/VideoBackgroundModal.test.jsx` | 13 | Video background replace/restore confirmation modal: renders when show=true, Cancel calls onCancel, Replace calls onReplace, Restore calls onRestore, hides when show=false, renders Chinese translations. **Full workflow (7):** download progress tracking, conversion progress tracking, success closes overlay, error on conversion failure, error when no folders found, retry on error, error overlay closeable via Escape + close button. |
| `components/BrowserScreen/BrowserHelpOverlay.test.jsx` | 9 | Help overlay renders title + section headings (Header Buttons/Airport/Levels), all button descriptions, inline button icons, Escape/backdrop/close-button dismissal, Chinese translations |
| `components/BrowserScreen/VideoReplaceOverlay.test.jsx` | 6 | Renders progress bar + percentage; closes immediately on successful completion; shows error when conversion fails; shows error when no folders found; Escape key closes error overlay; renders progress bar in Chinese |
| `components/BrowserScreen/BepInExInstallOverlay.test.jsx` | 7 | Progress bar + percentage; success closes overlay; error on failure; Escape closes error; close button works; localized NO_GAME_ROOT error; progress events update UI |
| `components/BrowserScreen/useTooltip.test.jsx` | 9 | Tooltip renders/clears on hover; text switches between buttons; positions above target; flips below when no room above; centres on button; right-pins at viewport edge; width computed from text (per-char glyph widths) |
| `components/EditorScreen/EditorTooltip.test.jsx` | 8 | Editor BUTTONS registry completeness (all descKeys, all icons, all required buttons); tooltip integration on editor toolbar buttons |
| `components/EditorScreen/FlightTable/FlightTable.test.jsx` | 6 | Click on data cell → no selection toggle; checkbox click → toggles; drag from data cell → range-selects; dropdown/time cell clicks → no toggle; clock portal click → no toggle |
| `components/EditorScreen/SearchBar.test.jsx` | 3 | Search match ranking: exact callsign outranks substring (save-error jump repro — "VIR3" highlights VIR3, not VIR3046), exact > prefix > substring ordering, no-match clears highlight + matches |
| `components/EditorScreen/StandMap/StandMap.test.jsx` | 22 | Stand dots/labels count, selected highlight + ring, occupied plane icons + callsign labels, click-to-select, hover states, empty/null stands, legend, shrink button, portal positioning, animations, rotation on planes, disabled stands, backward-compatible no-heading, cargo-stand labels (SGSE), text clipping |
| `components/EditorScreen/StarMap/StarMap.test.jsx` | 9 | Panel portal renders with no star data (empty state), runway threshold lines, STAR polylines + labels, legend, shrink button, **variant filtering:** selected runway filters STAR variants to that runway only, click-to-select calls onSelect, hover adds hovered class |
| `hooks/useEditorSaveActions.test.jsx` | 7 | **Save flow (3):** `handleSave`/`handleSaveAs` call `runTripleValidation` with the store flights; no issues → backup modal (not issues modal); duplicate callsigns block save before validation. **Restore/import (2):** `handleRestore`/`handleImport` load flights via `setLegacyState`. **Back (2):** no modifications → straight to browser; modifications → unsaved-changes modal. |
| `electron/bepinex.test.js` | 22 | checkStatus (null, partial, full, empty); findDownloadUrl (URL extraction, artifact not found, HTTP error); downloadZip (happy path — file content + progress 0→100%, incremental multi-chunk progress, HTTP 404 rejects + file cleanup, network error rejects + cleanup, timeout rejects + cleanup); extractZip (non-Windows guard); installFiles (subdirectory, missing items, flat structure); removeFiles (all items, partial, non-existent); installLatest (full pipeline, error cleanup, download progress normalization) |
| `integration/stand_positions.test.js` | 12 | `_parseStandPositions` unit tests: ZSJN v4 fixture parsing (57 stands), known stands (300/1/22) with finite coordinates, coordinate bounds, non-ACL text → `{}`. **PKStaticEntities path (5):** v4 fixture parsing (auto-detected schema), per-stand x/y/heading finite, tail/nose positions, coordinate bounds, empty input → `{}` |
| `integration/test_airway_nodes.test.js` | 5 | **AirwayNode fixes/waypoints extraction** — `buildApproachCache` on the ZSJN v4 fixture: 213 raw `airway-node` entities filtered to 16 ICAO-style fixes (all-uppercase 3-5 letter names; turn points like `TurnPoint19`/`TP19W1` and numbered nodes like `JN210` excluded), PANKI matches `airway-node:-244674` / `-191.74353, 487.024719` / `osmId -244674`, serialize→deserialize round-trip preserves `airwayNodes` |
| `integration/aerodrome_code.test.js` | 5 | **AerodromeCode regression** — the game uses AerodromeCode (67='C' narrowbody, 69='E' widebody, 70='F') for stand/jetway compatibility; both builders used to hardcode 67. Jetway + standalone builders now emit `spec.AerodromeCode` resolved from the approach cache (widebody 69, narrowbody 67); a spec missing the field **asserts** via `requireSpecField` (message carries registration + designator + "refusing fallback 67") instead of writing default data; `extractSpecificationDB` asserts on source specs lacking AerodromeCode. |
| `integration/state5_output_pr.test.js` | 2 | **State=5 ProgressRatio=0 regression** — `_buildStandaloneAircraftEntry` (driven with the ZSJN v4 fixture + real `buildApproachCache` + `CANONICAL_SCOPE`) writes constant `ProgressRatio: 0` for state=5 (final approach) aircraft while `_position`/`_direction` still match `computePosition`/`computeDirection` with the real time-based PR (and differ from a PR=0 placement); state=30 aircraft keep their real stored PR. |
| `integration/new_departure_save.test.js` | 3 | **New-departure save regression** — clones a fixture departure/arrival with `isDeparture` and `AirlineName` stripped, appends them to a temp copy of the v4 fixture, saves via the real 9-arg `generateFullAcl` (real `buildApproachCache`), asserts the departure writes `InitialDeparture` (arrival leg `null`) with `"AirlineName": "CSC"` and the arrival writes `InitialArrival` with `"AirlineName": "CCA"`, then reloads and checks the `isDeparture` flags + codes roundtrip. |
| `integration/jetway_id_collision.test.js` | 10 | **Duplicate-$id collision regression** (from fails.acl: jetway:09 `id(15) = 190 + 15 = 205` collided with jetway:12 `id(3) = 202 + 3 = 205` — a first-wins `$iref` bind made the game skip past an array boundary). Rebuilt jetway sub-objects now allocate from the segment's **dynamic allocator** (≥1000, past every static/flight-plan/canonical id) with old→new `IdMapper` remap (collided `$iref:205` resolves to the Aircraft id, last registration wins). **DockingDoorIndex `$type` (4):** resolved per-file scope (R3.ReactiveProperty<Int32> at its scope id, never hardcoded 6), fresh id above segment max when undeclared, canonical id-6 emission byte-identical on ZSJN-Morning-style scopes, one shared fresh-id counter per resolver. **Kept-id remap exclusion (3):** `_collectKeptRuntimeEntityIds` picks up `$id`s from kept (non-rebuilt) jetway/radio-channel/singleton/other entries and skips rebuilt flight-plan/aircraft/animator; the remap step does not rewrite `$iref` to a kept id but still remaps a rebuilt id; `_collectAllIdsInText` is string-aware (ignores `"$id"` inside a string value). |
| `integration/save_gamecompat.test.js` | 8 | **Game-compat save invariants** — saves via the real pipeline on a copy of the `ZSJN_leisure_1.acl` fixture and asserts the fuzz-discovered game-load invariants from `gamecompat-utils.cjs`: control (unmodified level stays clean), dup-reg ARR+DEP pair (unique plan keys + runtime entity for the docked aircraft via `_normalizeFlightsForGameCompat` rename), arrival at a stand whose docked dep takes off after scenario end (stand not double-booked — arrival moved), two arrivals on one stand within the 20-min gap (stands separated), **STAR-less arrival: `Airway` filled from the runway map**, **arrival on a runway with no STAR data: moved to an arrival-capable runway with a STAR**, every frame aircraft resolves its plan leg with a callsign. |
| `integration/id_renumber.test.js` | 6 | **Strictly-ascending `$id` regression** — pins `id_renumber.js`: the ZSJN_peakdeparture `jetway:02` DockedAircraft crash pattern (wrapper $id 1123 declared before inline Aircraft 1120/shared String[] 1117) renumbers to ascending order; `$blobdoc` contents renumber as fresh documents with cross-scope `$iref` remap (external ids handled); non-id tokens byte-preserved; idempotent (second pass changes nothing); propagates through the GATCARC4 binary encode/decode pipeline via `writeAcl`; a truly forward `$iref` (target not yet declared) throws. |
| **Electron backend (existing):** | **74** | |
| `electron/cloud-llm.test.js` | 49 | Multi-vendor cloud LLM module. **VENDORS registry (6):** all 4 vendors have name/icon/models/baseURL, model list matches expectations. **getVendorForModel (10):** resolves all 8 models to correct vendor key+name, null for unknown/empty, baseURL present for non-Claude. **getAvailableModels (4):** empty when no keys set, filters by key presence, returns all 8 models when all keys configured. **mcpToolsToOpenAITools (3):** MCP→OpenAI function format conversion, preserves minItems/maxItems. **sanitizeToolsForVendor (6):** strips OpenAI-only keywords (minItems/maxItems/default/const) for Gemini, recursive stripping of nested items, leaves non-Gemini unchanged. **chat entry errors (5):** unknown model throws, missing/empty API key throws per vendor. **chat success OpenAI path (2):** single-turn response, existing system message preserved. **tool calling loop (3):** multi-turn tool calls→final text, tool error recovery, malformed JSON arguments. **conversation tracking (1):** multi-tool conversation grows correctly across iterations. **Gemini sanitization via chat (1):** keywords stripped before Gemini API call. **Claude Anthropic path (4):** basic chat, tool→input_schema format conversion, tool_use loop, tool error handling. **thinking (3):** Claude thinking blocks + DeepSeek reasoning_content passed through, accumulation across tool turns. **empty-content nudge (2):** OpenAI + Claude nudged when only thinking returned. |
| `electron/updater.test.js` | 35 | Auto-update module. **computeFileMd5 (3):** known content hash, different content produces different hashes, rejects on non-existent file. **isUpdateSupported (5):** true on win32+packaged+PORTABLE_EXECUTABLE_FILE, false when not packaged, false on darwin, false when PORTABLE_EXECUTABLE_FILE not set — the voice build is now supported too (auto-updates via the shared `/editor` route, header-scoped). **isVoiceBuild (4)** + **variantName (2)** + **variantHeader (2):** normal/voice names and the `X-AC27-Variant` header they produce (single `/editor` route — the Worker selects objects per header, no path change). **createUpdaterScript (3):** generates .bat with expected commands, handles paths with spaces, cleans up stale .old before rename. **checkForUpdate (3):** no update when not supported, no update when exe missing, skipped etag recognized. **resolveTargetExe (5):** PORTABLE_EXECUTABLE_FILE, execPath fallback, AC27_UPDATE_TARGET in dev, auto-discovered artifact, null when no candidate. **checkForUpdate gates (6):** packaged but not portable, voice build proceeds to the network route, dev with AC27_UPDATE_TARGET, dev by default (opt-out), dev with AC27_UPDATE_DEV_CHECK=1, dev with no target exe. **installUpdate (2):** dev dry-run default, dry-run skips spawn+quit. |
| **MapWindows (19 files):** | **712** | |
| `components/MapWindows/voiceNumberParser.test.js` | 46 | `parseEnglishFlightNumber`: individual digits, "oh"→0, teens, grouped pairs, "triple X"/"double X" aviation shorthand, stop at non-numbers, >6-digit filter, empty input, "the" mid-number skip, digit confusables ("new"→two/nine). `parseChineseFlightNumber`: 幺-series, 一-series, 洞/两/零 variants, multi-token, stop at non-digits. `generateCallsignCandidates`, `lookupEnNumberToken` fuzzy guard ("right" blocked), `lookupUnitWord` |
| `components/MapWindows/voiceCallsignParser.test.js` | 71 | `detectLanguage`: EN/ZH/empty/mixed. `parseCallsign` (EN): "united eleven eleven"→UAL1111, full airline name, 3-letter code, "delta"→DAL, KLM, longest-match priority, teen numbers, callsign-only (no command), null on no-match/empty. `parseCallsign` (ZH): 东方/中国东方航空/国航 with digits. Proximity + phonetic-skeleton fallbacks, pre-number "at" strip, "new" confusables, "the" skip, Korean Air→KAL, `callsignCandidates` |
| `components/MapWindows/voiceCommandMatcher.test.js` | 21 | Exact alias matching (EN): cleared to land, clear for takeoff, go around, line up and wait, contact ground/tower, push back, taxi via with sub-item, stand by, hold position. Fuzzy fallback with partial word overlap. Chinese aliases: 可以落地/可以起飞/复飞/联系地面/等待/穿越跑道. `buildSpeechGrammar` JSGF output |
| `components/MapWindows/voiceTranscriptParser.test.js` | 60 | Transcript → command-chain parsing, cfa + runway, chaining, notices/reason contract, `parseVoiceCandidates` alternates, synthetic aircraft list |
| `components/MapWindows/voiceDeviationMatrix.test.js` | 293 | Human-language deviation matrix — every row pins the FULL parse outcome (incl. groups 6b/8c: cfa deviation budget, runway golden path, callsign proximity + phonetic skeleton + round-3 rows (letter-spelled ILS, callsign noise at/the/new, KAL code, runway through/urine); 12 = direct-to payload exactness + flight-prefix direct rows) |
| `components/MapWindows/voiceSpokenNumberValue.test.js` | 34 | `parseSpokenNumberValue` EN/ZH values incl. the runway fuzzyGuard (three one right → 31, never 318) |
| `components/MapWindows/voiceFuzzy.test.js` | 32 | D-L/curated-confusable policy leaf behavior |
| `components/MapWindows/voiceFuzzyAcceptance.test.js` | 17 | Round-trip of the exhaustive acceptance fixture + flight-number guard pins |
| `components/MapWindows/voiceSkeleton.test.js` | 6 | `enSkeleton`/`skeletonMatch` (2026-08-06 phonetic stage: digraphs, guards, ties) + runway fallback integration |
| `components/MapWindows/voiceWaypointMatcher.test.js` | 19 | Direct-to waypoint slot: single-token exact → D-L ≤ 2 → spelled-letter sequences |
| `components/MapWindows/voiceCandidates.test.js` | 14 | `parseVoiceCandidates` primary/alternate ordering + waypoint threading |
| `components/MapWindows/voiceGrammarConsistency.test.js` | 3 | Pins `electron/voice-grammar.json` ⇄ live parser tables (en + zh) |
| `components/MapWindows/SimClock.test.jsx` | 5 | Null/0/undefined → null output; valid timestamp → HH:MM:SS UTC; midnight → "00:00:00" |
| `components/MapWindows/useSvgZoom.test.js` | 22 | Init state, auto-init on data load, zoomIn/zoomOut bounds + center, panLeft/panRight/panUp/panDown with clamping, wheel zoom cursor-centered, drag pan start, reset functions preserve zoom + axis |
| `components/MapWindows/useUdpAircraftState.test.js` | 6 | Default state, subscribe on mount, unsubscribe on unmount, handler updates state, null/undefined safety, missing API methods |
| `components/MapWindows/SpinKnob.test.jsx` | 16 | Rendering with/without label, SVG structure (bezel, face, ticks, center, indicator, arrow), position→angle mapping at 0/0.5/1/clamp, indicator sync, scroll up/down direction, click-reset |
| `components/MapWindows/ControlSidebar.test.jsx` | 6 | 3 spin knobs rendered, actions section, children in actions, airspaceKnob optional, label presence |
| `components/MapWindows/GroundMapWindow.test.jsx` | 19 | Loading/error states, data fetch args, window title, SVG rendering, aircraft filtering (airborne y>1, stand proximity), Show All toggle, click-to-select UDP command, taxiway polylines, runway polygons, non-aircraft type=0 filtered out, type=4 (unknown) renders |
| `components/MapWindows/AirMapWindow.test.jsx` | 22 | Loading/error states, border overlay, airport mismatch filter, airborne filter, click-to-select UDP command, bg image toggle, range rings, runway thresholds, route polylines, toggle states, emergency double-click, airspace knob, non-aircraft entity filtering (type=0 excluded, type=4 shown), v4 active-runway variant filtering, fixes/waypoints layer (hidden by default, Waypoints toggle, Labels-gated fix names, runway-filter independence) |

### Expected outcomes

| Category | Expected |
|----------|----------|
| Time utils | All conversions round-trip correctly. Edge cases (null, empty, overflow) handled without throw. |
| Validators | Duplicate callsigns detected; no false positives on empty values. `detectStandConflicts` enforces the game's stand-overlap rules (dep/dep flagged, arr/arr allowed, offblock strictly before landing). `runTripleValidation` skips InBlockTime/TakeoffTime time-order checks (v4 stores them as 0) but still runs dropdown + stand-conflict validations. `getActiveColumns` hides InBlockTime/TakeoffTime columns. `_isNew` stripped from sidecar JSON at all nesting levels. |
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

All 1203 tests pass (52 files). The previously failing/todo items have been fixed:

1. **BepInExInstallOverlay — escape key closes error overlay**: Fixed by dispatching `keyDown` on `document.body` instead of `document` (capture-phase listener was never triggered when dispatching directly on document).

2. **AirMapWindow — renders route polylines when paths are provided**: Fixed by adding `_runwayList: ['19']` to the mock data so the component's runway filter doesn't suppress all STAR variants.

3. **downloadZip — tested indirectly via installLatest (todo)**: Replaced the empty skeleton test and `it.todo` with 5 proper direct tests (happy path + file flush fix, incremental progress, HTTP 404, network error, timeout). The production `file.end()` callback was also added to wait for the write stream flush before resolving the promise.

---

## Layer 2 — Playwright E2E Tests (17 tests, 15 pass, 2 skipped)

Launches the real Electron app against a temp copy of real game data (via `E2E_GAME_ROOT` env var set by `run-all.mjs`). File isolation is guaranteed — the real game installation is never touched. The 17 tests = 14 specs below + S1b (20-level integrity) + S1 + the fuzz spec (skipped unless `FUZZ_RUN=1`); the two skips are E12a (overlay timing) and fuzz (gated).

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
| **S1** | No-change save round-trip | Open level → Ctrl+S (no edits) → compare `.acl` vs `.acl.bak`: v4 has no GUIDs to regenerate (0 pre-save), `$id`s shift, flight data identical (32 flights, 24 weather, 4 wind) |

### Save Integrity — all 20 production files (E2E, requires `E2E_GAME_ROOT`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **S1b** | `save-integrity-all-e2e.spec.mjs` | 20 production files across ZSJN + KJFK + ZGSZ + KDCA | 20 passed, 0 skipped |

```bash
# Run standalone (requires E2E_GAME_ROOT env var):
$env:E2E_GAME_ROOT = "<game-root>"
npx playwright test --config=playwright.config.mjs tests/e2e/save-integrity-all-e2e.spec.mjs
```

Iterates every level row in the browser: open → disable time validation → Ctrl+S → confirm → run checker → go back → repeat. Takes ~3 minutes for 20 files. The 20 files mirror `PROD_VISIBLE_BASES` in `src/utils/constants/ui.js` minus `ZGSZ_Endless` (the spec's global-setup copy excludes `.demo.acl` files, so demo files never appear in the browser list — demo coverage lives in the Node save-integrity and jetway-rebuild layers instead):

| File | Status | Note |
|------|--------|------|
| ZSJN_leisure_1 | ✓ | all state identical |
| ZSJN_leisure_2 | ✓ | all state identical |
| ZSJN_peakdeparture | ✓ | all state identical |
| ZSJN_runwaychange | ✓ | all state identical |
| ZSJN_taixwayclosed | ✓ | all state identical |
| KJFK_leisure_1 | ✓ | all state identical |
| KJFK_leisure_2 | ✓ | all state identical |
| KJFK_runwaychange | ✓ | all state identical |
| KJFK_peakdeparture | ✓ | all state identical |
| KJFK_peakarrival | ✓ | all state identical |
| ZGSZ_leisure_1 | ✓ | all state identical |
| ZGSZ_leisure_2 | ✓ | all state identical |
| ZGSZ_runwaychange | ✓ | all state identical |
| ZGSZ_peakdeparture | ✓ | all state identical |
| ZGSZ_peakarrival | ✓ | all state identical |
| KDCA_leisure_1 | ✓ | all state identical |
| KDCA_leisure_2 | ✓ | all state identical |
| KDCA_runwaychange | ✓ | all state identical |
| KDCA_peakdeparture | ✓ | all state identical |
| KDCA_peakarrival | ✓ | all state identical |

### Fuzz Save — randomized edit storm + real SAVE (E2E, requires `E2E_GAME_ROOT` + `FUZZ_RUN=1`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **F1** | `fuzz-save.spec.mjs` | All 20 production files (or `FUZZ_ACL_FILES` subset) | 20/20 pass, `.acl.bak` created per file, saved file reloads with matching flights |

The fuzz test drives the editor the same way an AI agent would: it opens each level in
the real Electron app, then applies **50–200 randomized operations per level** through the
editor's built-in **MCP API** (`127.0.0.1:31415`, the same `tools/call` JSON-RPC protocol
`mcp/bridge.js` speaks), and finally hits **SAVE through the real UI** (Ctrl+S → backup
confirmation modal with backup checked → success modal).

**Randomized operations** (seeded, reproducible via `FUZZ_SEED`):

| Operation | MCP / store path | Randomized values |
|-----------|------------------|-------------------|
| Add flight | `create_flights` | airline, flight number, aircraft (airline-compat), runway, stand, STAR (runway-compat), registration (pair-compat), voice/language, ARR/DEP with in-range times |
| Remove one flight | `delete_flights` by callsign | random flight from the live list — **capped at 10% of the run's total ops** (`max(1, ⌊nOps×0.1⌋)`); picks over budget are re-picked from the add/modify/timeline distribution (30/26/26) |
| Remove all flights | `delete_flights` match `{}` | **gated**: only ever the first operation, decided up front with 50% probability per run; falls back to one `delete_one` on small levels (<6 flights); **a wipe sets the delete budget to 0 — NO further delete ops of any kind after a delete-all**; level is refilled before save (save requires ≥ 1 flight) |
| Edit any field | `modify_flights` | stand / runway / airway / aircraft type / registration / voice / language / flight number / airline code (cascade) / time shift |
| Timeline add/remove | editor store (`window.__AC27_STORE`) — the MCP API has no timeline tools, so rows are injected the same way the timeline editors do | weather: preset + time; wind: direction + speed + time; runway: pair change `{source→dest}` + time (times sorted; runway rows strictly inside the config window) |

**Time-range rule (enforced by the generator):** flights are only ever given times in
`[configStartTime, configEndTime + 30 min]` (the validation grace bound); runway-timeline
rows only inside `(start, end)` strictly. A rejection from the server that names a time
bound is treated as a generator bug and fails the run.

**Save-gate guarantees:** before SAVE, the test asserts `get_validation_issues` returns
zero issues, so the save must never be blocked by the UI validation modal. After SAVE it
verifies the `.acl.bak` was created and the saved `.acl` reloads through the real parser
with the same flight count + callsign set the fuzz left in the store.

```bash
# All 20 production levels (default):
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz

# Specific levels only (comma-separated names or paths):
$env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl,KJFK/KJFK_peakarrival.acl"
npm run test:fuzz

# Reproduce a failure exactly:
$env:FUZZ_SEED = "12345"
npm run test:fuzz

# Propagate results into the REAL game install (same layout E2E_GAME_ROOT):
# every PASSED level's saved .acl + the .acl.bak the editor produced are copied
# from the sandbox into GroundATC_Data/.../Airports/<icao>/Levels/ — i.e. the
# disk state a real editor save session would leave:
npm run test:fuzz -- --replace        # (or: $env:FUZZ_REPLACE = "1")
```

Notes:

- Requires `npm run build` first (launches `dist-electron/main.js`), and no other editor
  instance may be running — the API port 31415 is fixed.
- `--replace` **overwrites the real level files**: keep the copied `.acl.bak`
  (it holds the pre-fuzz original). Copying is per-level and only when that
  level passed; a failed run copies nothing for the failed level. `E2E_GAME_ROOT`
  must be set, and the game should be closed (never replace while the game is
  reading those files).
- Rejected operations (stand conflicts, duplicate callsigns/registrations, claimed
  numbers) are retried up to 6× with fresh random values and reported as `✖` in the
  per-level summary; they do not fail the run unless they are time-bound rejections or
  leave validation issues behind.
- The spec is skipped unless `FUZZ_RUN=1`, so `npm run test:e2e` / `npm run test:all`
  are unaffected.

---

## Layer 3 — Node.js Integration Tests (29 scripts)

Standalone scripts in `tests/integration/`. Run directly with `node`. Some need `--require ./tests/integration/preload.cjs` for ESM interop.

### MCP / API server tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_api_server.js` | 109 | All 7 HTTP endpoints (status, airport/values, flights, create-batch, modify-batch, delete-batch, validation) + MCP protocol (initialize, tools/list, 7 tools/call) + 12-point validation suite (airline, flight number, stand, runway, aircraft compat, STAR compat, registration pair, time bounds, time order, duplicate callsigns, stand conflicts, duplicate registrations) + cascade logic + AND-match regression tests. Mock Electron window — no real app needed. | 109/109 pass |
| `test_api_e2e_examples.js` | 44 | 7 composition scenarios from the MCP skill (Section 8): create batch flights, modify by airline, delete by type+time, time shift, Chinese-language create/modify, validation rejection + recovery. | 44/44 pass |

### New parser module tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_demo_filter.js` | 8 | Demo-level flight filtering (v4): `extractCurrentDateTime` (MetaData.BaseTime path; null when the section is missing), config-window flight filtering (filter window = `Config.startTime` ~ `endTime`, strict `startTime ≤ t < endTime`, departure-only flights tracked by OffBlockTime; no 30-min override), ZSJN v4 fixture: all flights inside the config window | 8/8 pass |
| `test_tokenizer.js` | 18 | String-aware tokenizer: `findSection`, `findArrayEnd`, `findObjectEnd`, `skipString`, `getTopLevelKeys` against synthetic and real ACL patterns | 18/18 pass |
| `test_acl_json.js` | 25 | JSON pre-processor + serializer round-trips: `_fixTrailingCommas`, `_fixSpecialFloats`, `_fixTypedValues`, `preprocessUnityJson`, `serializeUnityJson` | 25/25 pass |
| `test_acl_document.js` | 13 | `AclDocument` model: section indexing, round-trip serialization, init from JSON | 13/13 pass |
| `test_sid_goaround.js` | 19 | SID (Type=2), Missed Approach (Type=3), and APPR (Type=1) route parsers: `extractSidRunwayMappings`, `extractMissedApproachMappings`, `buildSidPaths`, `buildMissedApproachPaths`, `extractApprRunwayMappings`, `buildApprPaths` — synthetic edge cases + v4 runway-scoped resolution | 19/19 pass |
| `test_taxiway.js` | 10 | `parseTaxiwayPaths` (v4 PKStaticEntities format): synthetic edge cases (no SceneryData / empty text / no TaxiwaySegments → empty paths; valid segments with matching nodes; Flags values 1/2/4; stand-node segments marked `isStandAccess`; non-stand segments kept), ZSJN v4 fixture: paths present with valid structure, stand-access segments marked (+1 optional `--acl` integration test) | 10/10 pass |

| `test_save_roundtrip_diff.js` | 27 | Approach-block round-trip diff: T1 `RunwayTakeOffLength` (0 preserved; a missing value **asserts** via `requireSpecField` — refusing fallback 2000 — instead of defaulting), T2 `ModelOffset` float3 tuple format (no named x/y/z), T3 `AircraftRunwayCoordinateState` canonical-`$id` design (5 inline empty string[] arrays, unique per-array `$id`, zero `$iref`), T4 v4 spec extraction from a real v4 file (`--acl` or default `works.acl`) | 24/24 pass standalone (T4 runs with `--acl <v4-file>`) |
| `test_extract_v4_runway_pairs.js` | 5 | `extractV4RunwayPairs` — v4 runway pair extraction from static SceneryData `PhysicalName` ("01/19" → 01|19 + 19|01): ZSJN v4 fixture (2 pairs), KJFK (8 pairs — 4 groups), KDCA (6 pairs — 3 groups), empty/garbage input → `[]`, dedup (both ends of a physical runway → exactly 2 pairs). KJFK/KDCA cases skip when game root unavailable (`--root <game-root>`) | 5/5 pass (fixture) |

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
| `test_type_number_integrity.js` | 6 | Save→reload type number stability: runs the full `_rebuildStaticDataSections` save (`generateFullAcl`, approach cache passed — same as the app) on the v4 fixture, then verifies every `$type` declaration in the output matches the `.bak` snapshot — catches type-number shift regressions (6 checks, 0 type mismatches). | 6/6 pass |
| `test_jetway_rebuild.js` | v4 files | Constructive jetway rebuild round-trip: runs `_rebuildJetwayEntries`, verifies only jetway entries in RuntimeEntities are modified (other entries preserved byte-identical). Runnable offline against the v4 fixture (`--acl tests/fixtures/.../ZSJN_leisure_1.acl`). **Departed-stand rule**: a departure whose OffBlockTime ≤ the segment's snapshot time (`GameTime.CurrentDateTime`) is treated as already departed → empty jetway, matching the game's own entries (the 7/30/26 playtest update produces checkpoints taken after some off-block times); an unresolvable spec (no cache + empty original entry) falls back to an empty jetway instead of throwing. | 16/16 pass on the v4 game root (`--prod-demo --no-cache`); 1/1 fixture |

```bash
node tests/integration/test_udp_listener.js
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js --root <game-root>
```

### v4 GATCArc binary format tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_gatcarc_roundtrip.js` | varies × all .acl files | GATCArc4 binary round-trip: `parseArchive` validates magic/SHA-256/commit markers; `decodeArchive(bin)` → `encodeArchive(text)` → `decodeArchive` is byte-identical. For text files: `encodeTextToPayload`/`decodePayloadToText` round-trip reproduces game-written text. Type reference form (full `"N\|Name"` vs bare `N`) is normalized before comparison. Runs against every .acl in the game airports directory (KDCA 7, KJFK 10, ZGSZ 2, ZSJN 12). | 93/93 pass (31 files × 3 checks each) |
| `test_real_kjfk_jfk5.js` | 8 per-runway STAR resolution | End-to-end JFK5.JFK STAR/SID resolution against real KJFK data: `extractStarRunwayMappings` (SIE.CAMRM5 → 3 runways), `resolveFlyApproachPoints` (6 nodes per runway), `extractSidRunwayMappings` (JFK5.JFK is in SID), `buildSidPaths`, `buildStarPaths`, verifies JFK5.JFK is NOT in APPR data. | 8/8 pass |

```bash
# v4 GATCArc binary round-trip (scans all airports):
node tests/integration/test_gatcarc_roundtrip.js

# KJFK v4 STAR/SID diagnostic (hardcoded path — update for your game root):
node tests/integration/test_real_kjfk_jfk5.js
```

### Scan-all tests (need game root, override with `--root`)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_parse_airport.js` | varies | Parses all airports + .acl files; reports stats | 15/15 .acl files parse OK across 5 airports (564 flights: KDCA 156, KJFK 249, ZSJN 159). EGLC/ZGSZ have 0 .acl files (dev-mode airports); "Registration: missing" warnings are informational (v4 static files) |
| `test_callsign_gen.js` | varies | Callsign consistency across all `flight_schedule_*.csv` files | ⚠ 10 known mismatches, all flight-number zero-padding (30 files: 16 all-OK, 6 with issues, 4 skipped test/tutorial, 4 empty; 729 rows, 46 subsidiary/alternate code rows): AAL0101 (KJFK CrossRunway); HAL0862 + AIB0427 (KDCA leisure_2); HAL0862 + AIB0427 (KDCA peakarrival); AIB0427 (KDCA runwaychange); CSN0738, CSZ0855, CSZ0820 (ZSJN runwaychange); CSZ0235 (ZSJN taixwayclosed) |
| `test_approach_aircraft.js` | 5 sections pass (T1-T7 labelled) | Approach aircraft algorithms: spec extraction, AppPoint mapping, ProgressRatio formula, FlyApproach resolution, Position/Direction reconstruction, block assembly. **v4-only**: v4 static files store no approach aircraft (runtime-generated), so the ≥20 count assertion is informational. ⚠ the 8 hardcoded filenames (ZSJN-Morning_120min.acl etc.) are v3-era and absent from the current playtest install → 0/8 found, runs in limited mode. | PASS: 5, FAIL: 0 (T1 spec cross-file consistency real; T7 skips when no State=30 types present). |

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
| `scan_rlengths.js` | Scans `$rlength` values across all .acl files to detect format patterns (demo vs production). | Prints per-file $rlength breakdown |

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_compare_tat.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_scaled_tat.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_full_path.js [--root <game-root>]
```

### Single-ACL tests (require `--acl <path>`)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_e2e_save_load.js` | 1 round-trip | Load → snapshot → sort → save → reload → compare. Builds the approach cache (jetway DockingPositions lookup needs it, same as the app) | Flights match after round-trip (v4) |
| `test_rebuild_sections.js` | 1 rebuild | Copy → modify one flight → rebuild → validate: `_rebuildStaticDataSections` (StaticItems + binary re-encode, reload-verified) | StaticData preserved, 48 flights reload with edit |
| `test_acl_linkage.js` | 1 linkage | StaticItems `"$k": "flight-plan:<REG>"` definitions (Registration must match the key) and every `$fstrref:"flight-plan:<REG>"` reference must resolve | 0 broken links (48 defs / 48 refs / 0 broken on fixture) |

```bash
node tests/integration/test_e2e_save_load.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_sections.js --acl <path>
node tests/integration/test_acl_linkage.js --acl <path>
```

### Timeline tests (require ACL path)

All three run against v4 ACLs: the timeline sections are patched inside `MetaData` and the GATCArc4 binary is re-encoded (`_rebuildTimelineSections`).

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_timeline_comparison.js` | varies | JSON timeline files vs ACL-embedded timeline data field-by-field | v4 fixture: 3/3 sections match |
| `test_generate_timelines.js` | 4 sub-tests | `_generateFramesSection`, `_generateRunwayTimelineSection` produce identical output | ALL PASSED — generated Wind/Weather/RunwayTimeline sections round-trip the ACL's embedded sections 1:1 (stale pre-per-file-typeMap assertions on fixed type numbers removed) |
| `test_rebuild_timelines.js` | 6 sub-tests | `_rebuildTimelineSections`: WeatherFrames, WindFrames, RunwayTimeline (empty, with changes, all-three, round-trip) | ALL PASSED (MetaData subsections + binary re-encode) |

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_timeline_comparison.js <acl-path>
node --require ./tests/integration/preload.cjs tests/integration/test_generate_timelines.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_timelines.js --acl <path>
```

### Save integrity — all .acl files

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_save_integrity_all.js` | 21 (`--prod-demo`) or 24+ (`--all`) | Full save→reload→compare on every .acl file. Validates: flights (14 fields × N), config (startTime/endTime/scheduleFile), scenery maps (runway/stand counts), embedded timelines (weather/wind/runway), source format, text-level `_departureTakeoffTime` / `_arrivalInBlockTime` zero validation. Builds the approach cache per level dir (jetway DockingPositions lookup needs it, same as the app) | 21/21 pass on the v4 game root (18 prod + 3 demo): 0 field diffs, config identical, scenery identical, timelines identical |

```bash
# 18 production + 3 demo files (ZSJN/KJFK/ZGSZ/KDCA):
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

**Production (18 prod levels across ZSJN/KJFK/ZGSZ/KDCA)** — with `--prod-demo` the runner tests 21 files (18 prod + 3 demo).

**Demo (3 .demo files + 1 shared):** KJFK_leisure_1.demo, KJFK_peakarrival.demo, ZSJN_leisure_1 (shared with prod), ZSJN_peakdeparture.demo

---

## Master Test Runner

```bash
npm run test:all      # or: node tests/run-all.mjs [--game-root <path>]
```

Runs all three layers sequentially (Vitest → save integrity 21 files → jetway rebuild 16 v4 files → v4 runway pair extraction → build → Playwright E2E) and reports a pass/fail summary. Default game root: `D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest`.

---

## v4 Format Coverage

All supported .acl files use the **v4 GATCArc4 binary** format (StaticData.$blobdoc; flight plans are StaticItems dictionary entries keyed `"$k": "flight-plan:<REG>"`, referenced by `$fstrref` tokens). v2/v3 text-format support has been removed from the code and tests.

- **Save integrity**: 21/21 files pass (18 production + 3 demo) — flights, config, scenery, timelines all match after save→reload through `generateFullAcl` (`_rebuildStaticDataSections`).
- **Save/load round-trip**: `test_e2e_save_load.js` — flight data identical after load→save→load (21 flights on ZSJN_leisure_1, 61 on KJFK_peakarrival).
- **Section rebuild**: `test_rebuild_sections.js` (StaticItems rebuild + binary re-encode, reload-verified) and `test_rebuild_timelines.js` (MetaData subsection rebuild + re-encode) both pass.
- **Linkage**: `test_acl_linkage.js` — 48 flight-plan definitions self-consistent, 48 `$fstrref` references resolve.
- **Approach aircraft**: v4 static files store none (runtime-generated) — `test_approach_aircraft.js` treats the count as informational.
- **Demo filtering**: the filter window is `Config.startTime` ~ `Config.endTime` (no 30-min override) — 8/8 tests pass.
- **STAR/SID parsing**: v4 runway-scoped resolution tested in synthetic tests (19/19 SID/go-around tests pass) and real KJFK data (8/8 pass).
- **Taxiway + stand parsing**: `parseTaxiwayPaths` PKStaticEntities path and `_parseStandPositions` both run against the offline v4 fixture (57 stands).
- **Type-number integrity**: `test_type_number_integrity.js` runs the full `_rebuildStaticDataSections` save on the v4 fixture with approach cache — 0 `$type` mismatches vs .bak.
- **UI v4 semantics**: save-gate validation (`runTripleValidation` skips InBlockTime/TakeoffTime order), column hiding (`getActiveColumns`), flight creation (no InBlockTime/TakeoffTime), `addArrivalFlight` store path, StarMap runway-scoped variant filtering, and save-action validation wiring all unit-tested.

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

1. **`global-setup.mjs`**: copies 21 prod+demo files from real game → `tmp-e2e/`, writes `lastRoot.json`
2. **Fallback**: if `E2E_GAME_ROOT` is not set, falls back to `tests/fixtures/game-root/` (ZSJN-only)

**Fixtures** (`tests/fixtures/game-root/.../ZSJN/Levels/`): `ZSJN_leisure_1.acl` (v4 GATCArc4 binary, 57 stands) is the offline v4 sample used by the fixture-based tests (`test_jetway_rebuild`, `test_acl_linkage`, `test_rebuild_sections`/`test_rebuild_timelines`, `test_save_roundtrip_diff` T4 via `--acl`, `test_taxiway`, `test_sid_goaround`, `test_demo_filter`, `test_type_number_integrity`, `stand_positions`).
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
| `e2e/fuzz-save.spec.mjs` | Fuzz save test — `FuzzTest(aclFilePath, opts)` exported; MCP randomized ops + UI save-with-backup per level (gated on `FUZZ_RUN=1`) |
| `integration/test_save_integrity_all.js` | Save→reload→compare on all .acl files (supports `--prod-demo` for 21 specific files) |
| `integration/test_jetway_rebuild.js` | Constructive jetway rebuild — verifies `_buildActiveJetwayEntry` only-modifies-jetway invariant across 16 v4 prod+demo files |
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

---

## Game-Compatibility Save Invariants (`save_gamecompat.test.js`)

Regression suite that reproduces the five fuzz-discovered "broken save" conditions
through the **real save pipeline** (`parser.generateFullAcl` on a copy of the
`ZSJN_leisure_1.acl` fixture) and asserts the saved .acl satisfies the
game-load invariants implemented in `gamecompat-utils.cjs`.

Run: `npx vitest run tests/integration/save_gamecompat.test.js`

| Condition (edit that breaks the game) | Game error on load | Test / invariant code |
|---|---|---|
| Same registration on an ARR and a DEP (validator only checks duplicates within each group) | `Aircraft 'aircraft:B-XXXX' has no call sign for active flight direction 'Departure'` (dup `flight-plan:` keys) + `JetwayHD.SetDockingTarget` NullReferenceException (docked DEP loses its `aircraft:` entity via `turnaroundWinner`) | `dup-plan-key`, `docked-missing-entity`, `docked-entity-wrong-target` |
| Other-reg arrival at a stand whose docked aircraft departs after the scenario end (or lands before the docked aircraft's off-block) | `Stand 'X' is already allocated to owner 'B-YYYY' from 0001-01-01 until 9999-12-31` | `docked-stand-blocked`, `docked-stand-before-offblock` |
| Two arrivals on one stand within 20 min | stand allocation conflict at init | `arr-arr-close` |
| ARR→DEP same-stand pair with different registrations (rejected by the editor save gate — regression guard) | stand allocation conflict | `arr-dep-cross-reg` |
| Arrival leg with an empty STAR | `FlightPlan.Init()` drops the leg: "Flight plan '...' has neither an arrival nor a departure leg" (game-authored arrivals always carry a STAR, e.g. `SIE.CAMRM5`) | `arrival-no-star` |

The editor save pipeline now **auto-repairs** the first four conditions
(`_normalizeFlightsForGameCompat` in `src/acl/flight_plans.js`, called at the
top of `_rebuildStaticDataSections`): duplicate registrations are renamed
(keeping the frame-linked side), violating arrivals are moved to safe
stands drawn from the renderer's `sceneryMaps.standIdToGuid` pool, and
STAR-less arrivals get `Airway` filled from `approachCache.runwayStarMap`
(moved to an arrival-capable runway when their runway has no STAR data).
The fifth condition (ARR→DEP cross-reg) remains a hard save-gate rejection
(`_validateStandConflicts`). All eight tests must stay green; thresholds are
empirical fits to the observed game accepts/rejects (see the header of
`gamecompat-utils.cjs` for the full derivation).

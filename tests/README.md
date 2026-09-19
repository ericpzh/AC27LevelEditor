# AC27 Editor — Test Suite

Three-layer testing: **Vitest (component)** → **Playwright (E2E)** → **Node.js (integration)**.

Covers the **v4 GATCArc binary-format** save/load path (v2/v3 text-format support has been removed).

## Quick Start

```bash
npm run test:all      # Full suite: Vitest (2086) + save integrity (27) + jetway rebuild (27) + runway pairs (5) + E2E (18, ~8 min)
npm test              # Vitest component + store + utility + electron + integration + MapWindow + updater tests (2086 tests, 109 files, ~32s)
npm run test:e2e      # 18 Playwright E2E tests (requires npm run build first, ~8 min; 16 pass, 2 skipped — both fuzz specs gated on FUZZ_RUN)

# Fuzz save test — randomized edit storms (50–200 ops/level) + real SAVE w/ backup
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz         # flight fuzz: all 24 production levels (see "Fuzz Save" section)
npm run test:fuzz:ground  # ground+air fuzz: all 24 production levels (see "Fuzz Ground+Air Save" section)

node tests/integration/test_api_server.js      # MCP/API tests: 133 tests (~1s)
node tests/integration/test_api_e2e_examples.js # MCP E2E examples: 44 tests (~1s)

# Save integrity — all .acl files across both airports:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo

# v4 GATCArc binary round-trip (all airports):
node tests/integration/test_gatcarc_roundtrip.js

# Type number integrity (uses fixture):
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js
```

**Last full verification (2026-09-19):** Vitest 2086/2086 (109 files); integration scripts all green
(api-server 133, api-e2e-examples 44, gatcarc round-trip 120, type-number 6, save-integrity 27/27,
jetway-rebuild 27/27, v4 runway-pairs 5, UDP listener 21, tokenizer 18, acl-json 25, acl-document 13,
sid-goaround 19, taxiway 10, save-roundtrip-diff 24, demo-filter 8, real-KJFK 8); Playwright E2E 16
passed + 2 skipped (the two `FUZZ_RUN`-gated specs); flight fuzz **4/4 `leisure_1` levels passed
without `--replace`** (ZSJN/KJFK/KDCA/ZGSZ) and **4/4 `leisure_2` levels passed with `--replace`**
(results propagated into the real game install).

**Voice/language invariant fix (2026-09-18):** the fuzz surfaced a real game-load error at ZGSZ —
the game's `VoiceCatalog` throws `InvalidOperationException` when an aircraft's captain voice
declares a language other than the flight's `Language`. The `ZGSZ_leisure_2` `--replace` output had
23/40 mismatched flights (e.g. `CN-Captain-Middle-Aged-EN` on a `zh` flight). Fixed by exposing
`voice_catalog.json` to the renderer as `airportValues._voiceLanguages`, picking a language-matched
voice for new flights (`pickVoiceForLanguage`), limiting the FlightTable Voice dropdown to the row's
`Language` (the current value stays selectable so a legacy mismatch never renders blank) and cascading
Voice to that dropdown's first valid option when Language changes (`cascadeLanguageChange`), flagging
mismatches in `runTripleValidation` (`val_voice_language_mismatch`), auto-repairing them in the save pipeline's
`_normalizeFlightsForGameCompat`, and adding a `voice-language-mismatch` game-compat check (so the
fuzz gate traps regressions). Covered by `tests/integration/voice_language_normalization.test.js` +
`tests/store/flightDefaults.test.js` + `tests/utils/validators.test.js`. Re-fuzzing `ZGSZ_leisure_2`
with `--replace` produced clean schedules (65 then 80 flights) with 0 mismatches.

---

## Layer 1 — Vitest Component Tests (2086 tests, 109 files)

Tests run in jsdom with mocked `window.electronAPI`. No Electron needed. Some electron-backend tests use `@vitest-environment node` (see `cloud-llm.test.js`, `updater.test.js`, `aviationstack.test.js`).

### `npm test` — 2086 pass (109 test files; includes the Ground Painter scenery suite + airway roundtrip + the full Livery page suite + the aviationstack realtime-import suite)

Coverage (`npx vitest run --coverage`, provider `@vitest/coverage-v8`, config in `vitest.config.js`) is
scoped to the core logic trees — `src/acl/**` + `src/components/EditorScreen/GroundPainter/**` — with
global thresholds (55/40/48/55 stmt/branch/func/line) that fail the run on regression. The Ground
Painter save-path integration suites read real game levels from the AC27 install; set
`AC27_GAME_ROOT=/path/to/Airport Control 25 Playtest` to point at a non-default install — the
fixture-gated suites skip cleanly (instead of ENOENT-failing) when the level files are absent.

| File | Tests | What it validates |
|------|-------|-------------------|
| `utils/timeUtils.test.js` | 29 | `ticksToTime` (0/0n/""→""; ticks→HH:MM:SS), `timeToTicks` (empty→0; "HH:MM:SS"→ticks; baseDate offset), `timeToMinutes` ("01:30"→90), `timeToSeconds` ("01:00:00"→3600), `minutesToTimeStr` (90→"01:30:00"; 1500 wraps to "01:00:00"), `sortTimelineByTime` (sorts by time field), `getTimelineActiveRange` (no bounds→all active; bounds→filters), `getTimeValidationBounds` (5): OffBlockTime/LandingTime max = end+30min grace, generic Time strict, InBlockTime/TakeoffTime null, null when config missing, `getDefaultTime` (midpoint "06:00"+"10:00"→"08:00:00"; none→"12:00:00"), `_extractBaseDateFromText` (BaseTime match; WorldState fallback; FALLBACK_BASE_DATE_TICKS), `isValidTimeStr` (valid/invalid/edge) |
| `utils/starDisplay.test.js` | 13 | **STAR/SID display dedup** — `stripStarRunwaySuffix` (ZGSZ-style `.34L`/`.33`/`.15` stripped, plain names like `ABTU6W`/`WFG91A` untouched, non-string passthrough), `hasStarRunwaySuffix`, `dedupeStarPathsForDisplay` (runway-suffixed variants merged under the base STAR/SID name with representative longest route + all runways; non-suffixed STARs keep per-runway variants; null/empty→{}), `filterDedupedStarPathsByRunway` (group kept when any runway active; merged `runways` array + preserved singular `runway` handled) |
| `utils/validators.test.js` | 53 | `validateCallsigns` (5): no dupes→[]; dupes detected; empty callsigns ignored; each dupe listed once; empty array→[]. `detectStandConflicts` (17): overlap rules (arr/arr allowed, dep/dep flagged, offblock < landing OK / = landing flagged, 20-min default start), conflict messages contain both callsigns + stand with normalized times. `runTripleValidation` (11): v4 semantics — time-order checks (InBlockTime/TakeoffTime) always skipped; dropdown + stand-conflict validations still run; time range — end+30min grace (exact boundary 22:30 accepted, 22:31 flagged, minute-carry 22:45→23:15, start bound still strict). **STAR-required (4):** blocks arrivals without a STAR (game drops STAR-less arrival legs at load), allows arrivals with a STAR, no STAR requirement on departures, rule skipped when no `_starRunwayMap` data is cached. **RunwayTimeline (5→6):** flags empty `changes`, duplicate `time` (exact `HH:MM:SS`), **source-not-active** via chronological active-set sweep (`01→19` twice with no reversal → second `01` not active, but `01→19, 04→22` / `19→01` / `01→19` recurrence is allowed). **Inactive runway (8):** arrival `Runway` must be in the active set at `LandingTime` (`initialRunways` + `timeline` sweep sorted chronologically; `<= landingTime` applies, unsorted input handled, departures ignored, exact-time landing uses post-change set); **skipped when the level carries no active-runway source at all** (empty `initialRunways` + empty `timeline`) so arrivals are not all false-flagged — same guard in `validateFlightObjects` (`electron/api-server.js`) and mirrored in `test_api_server.js`'s valid-arrival case. **10-min transition grace:** a runway deactivated within `RUNWAY_TRANSITION_GRACE_SEC` (600 s) before landing still counts (aircraft already on final when the active set switched) — covers `KJFK_runwaychange` (`31R`/`4L` land up to ~9 min after the 18:30 switch); an arrival beyond the grace is flagged. Reproduces `KDCA_peakarrival` fuzz `19 @21:15` while active `[01,15,22]`. `getActiveColumns` (2): v4 hides InBlockTime/TakeoffTime columns. `_isNew` stripping (3): JSON replacer (mirrors electron main timeline sidecar writers) removes `_isNew` at all nesting levels, preserves other keys. |
| `store/flightDefaults.test.js` | 70 | `randomPick`: null/undefined/empty→null, single/multi→valid. `pickRandomAirlineCode`: audio first→AirlineCode fallback→AirlineName→'NEW'; key regression: never 'NEW' when AirlineCode dropdown populated. `pickRandomFlightNumber`: from `_flightNums`, '1' fallback. `pickRandomUnusedStand`: unused only, reuse when all taken, empty when no stands. `pickFirstFlightNumber`/`pickDefaultAirlineCode` (existing): first-element behaviour preserved. `makeEmptyFlight`: 15 empty-string fields. `computeDefaultBaseMin`: config end time−offset, clamp≥0. `minutesToTimeString`: HH:MM:00 format. `createDefaultFlight`: random airline + airline-independent aircraft + cascaded reg + non-conflicting stand; arrival vs departure direction; `isDeparture` set from type; `AirlineName` = picked airline code (game stores codes, e.g. 'CCA', never the empty AirlineName dropdown); **STAR/`Airway` (3):** arrivals get a STAR from `_runwayStarMap` constrained to the picked runway (even when `values.Airway` is empty — SceneryData source), departures ALWAYS leave `Airway` empty (never inherit the airport-wide STAR list; SID is derived at runtime from the runway — save only writes STAR on arrival legs). `createArrivalFlight`: sets LandingTime, leaves InBlockTime empty (v4 stores it as 0), no departure times, forwards existingFlights for stand-conflict avoidance. `createDepartureFlight`: sets OffBlockTime, leaves TakeoffTime empty (v4 stores it as 0), no arrival times. Stand conflict forwarding. |
| `store/appStore.test.jsx` | 27 | Screen starts at "setup"; `setScreen` transitions; modal defaults closed; `showModal`/`hideModal`; toast defaults empty; `showToast` sets message+type; `initializeEditor` sets path/flights/airport; `modified` starts false; `addArrivalFlight` creates row with randomized cascade (airline from dropdown, aircraft from the pool, reg valid for the pair, non-conflicting stand); `addArrivalFlight` regression: airline never "NEW" when AirlineCode dropdown populated; stand conflict avoidance with existing flights; `addArrivalFlight` leaves InBlockTime empty (v4 stores it as 0); **`updateFlight` airline change keeps `AircraftType` and cascades `Registration`** to the new `(airline, aircraft)` pair; `selectedIndices` starts empty; `toggleSelection` add/remove; `toggleSelectAll` checks all/clears all; **Chat state (9):** panel defaults closed, vendors setup step, empty config, toggle open/closed, add+clear messages, sending state, set+clear errors, chat config, setup step change |
| `store/flightCascade.test.js` | 4 | **`cascadeAirlineChange` is airline→registration only** — keeps `AircraftType` (never returns it), syncs `AirlineName`, cascades `Registration` to the first valid for the new `(airline, aircraft)` pair, leaves an already-valid or unmapped registration untouched, and reads the internal `_Registration` when no explicit one is set |
| `components/common/Modal.test.jsx` | 6 | Returns null when closed; renders title+body when open; `hideModal` called on overlay click; click inside modal box does NOT close; renders actions prop; body as React elements |
| `components/common/Toast.test.jsx` | 4 | Renders empty by default; shows message when set; applies CSS class from type; `.show` class toggles with message |
| `components/BrowserScreen/BrowserScreen.test.jsx` | 28 | **Help Button (5):** renders in header, click opens overlay, Escape closes, backdrop click closes, close button works. **Debug Mode Toggle (4):** renders toggle button, shows active state when installed, tooltip on hover, disabled while loading. **Livery Button (3):** renders button, tooltip on hover, navigates to livery screen. **Tooltips (5):** Change Folder/Language/Help tooltips, hides on mouse leave, switching hover updates text. **Demo File Filtering (4):** hides whitelisted .demo files in non-demo mode, hides non-whitelisted .demo files, shows whitelisted .demo files in demo mode, sorts levels by whitelist order (not start time). **Collapsible Airport Cards (6):** header click collapses/expands a card (radar toggle buttons don't collapse it); auto-collapse collapses trailing airports so all four headers stay visible; auto-collapse is one-shot per app session (a resize after load does not re-run it); auto-collapse result and a manual collapse choice both persist across a browser remount (same session, via the store). Fixtures mock `HTMLElement` `clientHeight`/`offsetHeight` so the fit pass has real geometry in jsdom. **Level-scan loading overlay (1):** while the airport scan is in flight a fixed `.browser-scan-overlay` (blurred backdrop + centered spinner + `browser_loading`) covers the whole screen and the main list renders nothing; it clears once the scan resolves. |
| `components/BrowserScreen/VideoBackgroundModal.test.jsx` | 13 | Video background replace/restore confirmation modal: renders when show=true, Cancel calls onCancel, Replace calls onReplace, Restore calls onRestore, hides when show=false, renders Chinese translations. **Full workflow (7):** download progress tracking, conversion progress tracking, success closes overlay, error on conversion failure, error when no folders found, retry on error, error overlay closeable via Escape + close button. |
| `components/BrowserScreen/BrowserHelpOverlay.test.jsx` | 9 | Help overlay renders title + section headings (Header Buttons/Airport/Levels), all button descriptions, inline button icons, Escape/backdrop/close-button dismissal, Chinese translations |
| `components/BrowserScreen/VideoReplaceOverlay.test.jsx` | 6 | Renders progress bar + percentage; closes immediately on successful completion; shows error when conversion fails; shows error when no folders found; Escape key closes error overlay; renders progress bar in Chinese |
| `components/BrowserScreen/BepInExInstallOverlay.test.jsx` | 7 | Progress bar + percentage; success closes overlay; error on failure; Escape closes error; close button works; localized NO_GAME_ROOT error; progress events update UI |
| `components/BrowserScreen/useTooltip.test.jsx` | 9 | Tooltip renders/clears on hover; text switches between buttons; positions above target; flips below when no room above; centres on button; right-pins at viewport edge; width computed from text (per-char glyph widths) |
| `components/EditorScreen/EditorTooltip.test.jsx` | 8 | Editor BUTTONS registry completeness (all descKeys, all icons, all required buttons); tooltip integration on editor toolbar buttons |
| `components/EditorScreen/FlightTable/FlightTable.test.jsx` | 7 | Click on data cell → no selection toggle; checkbox click → toggles; drag from data cell → range-selects; dropdown/time cell clicks → no toggle; clock portal click → no toggle; **aircraft type dropdown lists every `vals.AircraftType` regardless of `_compat.airlineToAircraft`** |
| `components/EditorScreen/SearchBar.test.jsx` | 3 | Search match ranking: exact callsign outranks substring (save-error jump repro — "VIR3" highlights VIR3, not VIR3046), exact > prefix > substring ordering, no-match clears highlight + matches |
| `components/EditorScreen/StandMap/StandMap.test.jsx` | 22 | Stand dots/labels count, selected highlight + ring, occupied plane icons + callsign labels, click-to-select, hover states, empty/null stands, legend, shrink button, portal positioning, animations, rotation on planes, disabled stands, backward-compatible no-heading, cargo-stand labels (SGSE), text clipping |
| `components/EditorScreen/StarMap/StarMap.test.jsx` | 9 | Panel portal renders with no star data (empty state), runway threshold lines, STAR polylines + labels, legend, shrink button, **variant filtering:** selected runway filters STAR variants to that runway only, click-to-select calls onSelect, hover adds hovered class |
| `components/EditorScreen/GroundPainter/snap.test.js` | 31 | **Ground Painter snap engine** — `findSnap` full cascade with priority: endpoint (nearest vertex, anchor excluded) → on-segment (`closestPointOnSegment` projection, falls through to the angle tier when out of reach) → angle snap relative to the last drawn edge (`opts.prev`; collinear ±90° ±45°/±135° turns, radius kept, `angleToleranceDeg` default 2.5); `collectSnapGeometry` on BOTH input shapes (id-free Graph incl. runway baselines/closed area rings/stand axes + dedup/zero-drop, and the editor val shapes `{taxiwayPaths, runwayData, areaData, standPositions}`); `getSnapGuides` 180/90/45/135 guide families; `getSnappedWorldPos` client→SVG→world boundary (z negation + cascade; null when the SVG element lacks `createSVGPoint`/`getScreenCTM`); geometry helpers (`distancePointToLine`, `closestPointOnSegment` clamping, `projectPointToLine`, angle normalization) and `worldSnapDist` band clamping |
| `components/EditorScreen/GroundPainter/metrics.test.js` | 12 | **Extracted Ground Painter metrics** — `segNodeIdxs` (nodeIdxs vs legacy aIdx/bIdx), `polylineLengthMeters` (GU→meters, null-pair chain break), `segmentLengthMeters`/`runwayLengthMeters` (null on missing/degenerate), `formatLengthMeters` (locale grouping, empty on non-finite), `buildTaxiPaths` (one polyline per segment, drops <2-point stubs) |
| `components/EditorScreen/GroundPainter/fillet-connected.test.js` | 7 | **`computeFillet` connected (shared-node) path** — the standard corner-rounding case the virtual suite does not cover: shared O endpoint geometry (tangents at t=r/tan(θ/2)), rMax clamp against the short leg, duplicate-nodes-at-one-snap-point picks (oIdxA/oIdxB), runway pavement 4-point strip with O interior picking the LONGER ray (runway interior, not the overhang stub); rejections: degenerate zero-length ray, missing far node, collinear continuation |
| `components/EditorScreen/GroundPainter/fillet-virtual.test.js` | 12 | **`computeFillet` + `applyVirtualFillet` virtual (disconnected) path** — tangent geometry at the imaginary intersection, parallel/collinear-disjoint rejection; additive wiring keeps both originals intact (stub bridging when tangents land beyond the near endpoint, split-preserving when tangents land inside the span, direct anchoring on pre-existing tangent nodes), runway pavement strip as a picked leg; network never shortens |
| `components/EditorScreen/GroundPainter/runwayAccess.test.js` | 6 | **Runway entrance/exit access listing** — `isSegmentEligibleForRunwayAccess` (name not required, pavement strip excluded, physical-connection only) and `getSegmentRunwayAccess` (lists only the physically-connected runways with directional checked-state). Guards: name match alone does NOT list, unnamed touching IS eligible, junction node from pavement split detected via live graph despite stale `meta.runwayPavement`, no-pavement runway returns `[]`. Pure, no fixture. |
| `components/EditorScreen/GroundPainter/polygon_simple.test.js` | 12 | **Polygon simplicity guard** — `polygonIsSimple` / `polysSimple` (Triangulator): bowtie/self-crossing outlines rejected via `segProperCross` with bbox pre-filter, adjacent edges exempt, degenerate edges ignored; both CJS (`src/acl/scenery_graph.js`) and ESM mirror (`polygon_simple.js`) stay in sync |
| `components/EditorScreen/GroundPainter/airMode.test.jsx` | 10 | **Air mode (unified Ground/Air painter)** — air/ground toggle, airway-node markers (zoom-aware sizing), procedure chaining via `create_airway_procedures`/graph `procedures[]`, air fillet, move/rename/delete airway objects, `extractAirwayOsmPool`/`getAirwayOsmPoolInfo` |
| `components/EditorScreen/GroundPainter/GroundPainter.test.jsx` | 9 | **Ground Painter component (jsdom + real zustand store)** — smoke mount (loading state → SVG canvas + taxiway polylines + toolbar), Cancel closes via the store; taxiway-line tool: two clicks commit a segment into the graph (nodes/segment/meta + history push + dirty flag) and a zero-length draft shows the inline "distinct endpoints" error without committing; fillet tool: picking a curved segment shows the straight-only error, two picks on the L corner commit through the floating panel — legs truncated to the tangents, 11-point arc added, corner O ghost-deleted (`deletedPks` = 2 seg PKs + node PK), picks reset; **T junction (deg>2)** commits without a `ReferenceError` (the O-T stub bookkeeping used a `const` from a sibling block — `parentOsmA is not defined`) and keeps `meta.segOrigPk` in lockstep with `graph.segments`; **segment rename spans the OSM way (2):** the floating rename box (`updateSegmentName`) writes the new `Name` onto every segment sharing the tapped segment's OsmId (resolved from `meta.segOrigPk` or `parentOsm`) and leaves a different OSM way untouched, while a segment with no known OsmId renames only itself |
| `components/EditorScreen/GroundPainter/runwayEndpointDrag.test.jsx` | 5 | **Runway threshold (endpoint) drag** — Select tool grabs the threshold (leaves the other end fixed) and the coupled Flags=4 pavement strips follow via proportional re-projection (`-6.96/-1.2/5.2/10.96` for a 0..10 → −6..10 reshape); Box Select also grabs the threshold instead of body-dragging the whole runway (the endpoint grab must run before `pointOnMultiSelected`, which treats the whole line as "on selection"); Box Select body-drag away from a node still moves the whole runway; **snap tracking:** with a realistic snap radius and 1-GU-spaced collinear pavement vertices, the threshold must track the cursor exactly (the node-drag snap geometry excludes the dragged node and its runway's own pavement strips, otherwise it sticks to each strip vertex then jumps); **overlay hit-testing is disabled while dragging** (`.gp-overlays--dragging` toggles on mousedown/mouseup so the runway end-name boxes can't intercept the drag) |
| `hooks/useEditorSaveActions.test.jsx` | 7 | **Save flow (3):** `handleSave`/`handleSaveAs` call `runTripleValidation` with the store flights; no issues → backup modal (not issues modal); duplicate callsigns block save before validation. **Restore/import (2):** `handleRestore`/`handleImport` load flights via `setLegacyState`. **Back (2):** no modifications → straight to browser; modifications → unsaved-changes modal. |
| `electron/bepinex.test.js` | 28 | checkStatus (null, partial, full, empty); findDownloadUrl (URL extraction, artifact not found, HTTP error); downloadZip (happy path — file content + progress 0→100%, incremental multi-chunk progress, HTTP 404 rejects + file cleanup, network error rejects + cleanup, timeout rejects + cleanup); extractZip (non-Windows guard); installFiles (subdirectory, missing items, flat structure); removeFiles (all items, partial, non-existent); installLatest (full pipeline incl. downloadZip, error cleanup, download progress normalization) |
| `unit/live-scenery.test.js` | 11 | **Live scenery / geo_osm transform** — `fitTransform`/`syncGeoData` internals: linear lat/lon↔x/z fitting from shared graph nodes (≥3), lat/lon bounds, node/way sync, `.bak` sidecar handling |
| `unit/create-workshop-item.test.js` | 10 | **Workshop item bootstrap script** (`scripts/create-workshop-item.mjs`) — `buildWorkshopVdf` emits a creation VDF (appid, no `publishedfileid`) or an update VDF (with it), skips empty optional fields, and escapes backslashes/quotes/newlines/tabs so a multi-line description stays a single VDF line; `parsePublishedFileId` reads the id steamcmd writes back (null when absent); `buildSteamCmdArgs` builds the `+login <user> +workshop_build_item <vdf> +quit` list; `parseArgs` defaults visibility private + run false, accepts multi-word values + `--run`, and rejects a missing value / unknown positional. |
| `unit/realtime-aviationstack.test.js` | 22 | **aviationstack → flight mapper (pure, no network)** — `isoToLocalHHMM` reads the API's **local wall-clock** (no timezone double-conversion), `fitTimeToWindow` (inside / midnight-crossing / outside), per-field mapping (arrival vs departure, direction from airport ICAO, airline + flight-number extraction from ICAO/IATA fields, canonical flight-number substitution, aircraft-type + registration defaults), codeshares kept, and batch semantics: **first-valid-wins** dedupe (physical-flight key + kept callsigns), existing flights ignored (import replaces the schedule), per-reason skip counts, and **retiming** out-of-window flights into the level window. |
| `unit/realtime-kjfk-fixture.test.js` | 4 | **Saved aviationstack KJFK response replayed offline** — loads `tests/fixtures/aviationstack-kjfk.json` (100 arrivals + 100 departures): asserts local wall-clock reading (ETD1 `08:35`, not the UTC-converted `04:35`), retimes the whole batch into the reported 10:15–11:00 window (matched > 0, every kept time in-window, no `time_out_of_range`), and leaves times untouched when the batch already fits. |
| `electron/aviationstack.test.js` | 7 | **aviationstack HTTP client** (`@vitest-environment node`, Node `http` replaced by a `vi.fn` mock — **never hits the real API**) — missing key rejected without a request, plain-HTTP host/path/params captured, in-band `https_access_restricted` mapping, non-200 → `http_NNN`, transport error → `network_error`, invalid JSON → `invalid_response`, `buildQuery` omits empty values. |
| `acl/geo_osm.test.js` | 12 | **geo_data.osm sync helpers** — `buildTaxiwayModel` / `parseGeoOsm` / `fitTransform` / `syncGeoDataForLevel` / `deriveGeoDataPath` against synthetic OSM XML and empty fixtures |
| `acl/scenery_graph_approach_edge.test.js` | 13 | **Scenery graph — approach-edge cases** — `buildSceneryGraph` with missing/degenerate PKStaticEntities, empty `taxiway-node`/`runway`/`stand` blocks, stray `PhysicalRunwayStaticItem` fallback, area `30\|31` / name-check branches |
| `integration/stand_positions.test.js` | 12 | `_parseStandPositions` unit tests: ZSJN v4 fixture parsing (57 stands), known stands (300/1/22) with finite coordinates, coordinate bounds, non-ACL text → `{}`. **PKStaticEntities path (5):** v4 fixture parsing (auto-detected schema), per-stand x/y/heading finite, tail/nose positions, coordinate bounds, empty input → `{}` |
| `integration/test_airway_nodes.test.js` | 5 | **AirwayNode fixes/waypoints extraction** — `buildApproachCache` on the ZSJN v4 fixture: 213 raw `airway-node` entities filtered to 16 ICAO-style fixes (all-uppercase 3-5 letter names; turn points like `TurnPoint19`/`TP19W1` and numbered nodes like `JN210` excluded), PANKI matches `airway-node:-244674` / `-191.74353, 487.024719` / `osmId -244674`, serialize→deserialize round-trip preserves `airwayNodes` |
| `integration/test_star_waypoints.test.js` | 4 | **STAR waypoint resolution** — `buildApproachCache` `starWaypoints` per runway/STAR: filters airway nodes to runway STAR map, orders by route, ZSJN fixture exact waypoint counts |
| `integration/aerodrome_code.test.js` | 5 | **AerodromeCode regression** — the game uses AerodromeCode (67='C' narrowbody, 69='E' widebody, 70='F') for stand/jetway compatibility; both builders used to hardcode 67. Jetway + standalone builders now emit `spec.AerodromeCode` resolved from the approach cache (widebody 69, narrowbody 67); a spec missing the field **asserts** via `requireSpecField` (message carries registration + designator + "refusing fallback 67") instead of writing default data; `extractSpecificationDB` asserts on source specs lacking AerodromeCode. |
| `integration/state5_output_pr.test.js` | 2 | **State=5 ProgressRatio=0 regression** — `_buildStandaloneAircraftEntry` (driven with the ZSJN v4 fixture + real `buildApproachCache` + `CANONICAL_SCOPE`) writes constant `ProgressRatio: 0` for state=5 (final approach) aircraft while `_position`/`_direction` still match `computePosition`/`computeDirection` with the real time-based PR (and differ from a PR=0 placement); state=30 aircraft keep their real stored PR. |
| `integration/new_departure_save.test.js` | 3 | **New-departure save regression** — clones a fixture departure/arrival with `isDeparture` and `AirlineName` stripped, appends them to a temp copy of the v4 fixture, saves via the real 9-arg `generateFullAcl` (real `buildApproachCache`), asserts the departure writes `InitialDeparture` (arrival leg `null`) with `"AirlineName": "CSC"` and the arrival writes `InitialArrival` with `"AirlineName": "CCA"`, then reloads and checks the `isDeparture` flags + codes roundtrip. |
| `integration/jetway_id_collision.test.js` | 11 | **Duplicate-$id collision regression** (from fails.acl: jetway:09 `id(15) = 190 + 15 = 205` collided with jetway:12 `id(3) = 202 + 3 = 205` — a first-wins `$iref` bind made the game skip past an array boundary). Rebuilt jetway sub-objects now allocate from the segment's **dynamic allocator** (≥1000, past every static/flight-plan/canonical id) with old→new `IdMapper` remap (collided `$iref:205` resolves to the Aircraft id, last registration wins). **DockingDoorIndex `$type` (4):** resolved per-file scope (R3.ReactiveProperty<Int32> at its scope id, never hardcoded 6), fresh id above segment max when undeclared, canonical id-6 emission byte-identical on ZSJN-Morning-style scopes, one shared fresh-id counter per resolver. **Kept-id remap exclusion (3):** `_collectKeptRuntimeEntityIds` picks up `$id`s from kept (non-rebuilt) jetway/radio-channel/singleton/other entries and skips rebuilt flight-plan/aircraft/animator; the remap step does not rewrite `$iref` to a kept id but still remaps a rebuilt id; `_collectAllIdsInText` is string-aware (ignores `"$id"` inside a string value). |
| `integration/save_gamecompat.test.js` | 8 | **Game-compat save invariants** — saves via the real pipeline on a copy of the `ZSJN_leisure_1.acl` fixture and asserts the fuzz-discovered game-load invariants from `gamecompat-utils.cjs`: control (unmodified level stays clean), dup-reg ARR+DEP pair (unique plan keys + runtime entity for the docked aircraft via `_normalizeFlightsForGameCompat` rename), arrival at a stand whose docked dep takes off after scenario end (stand not double-booked — arrival moved), two arrivals on one stand within the 20-min gap (stands separated), **STAR-less arrival: `Airway` filled from the runway map**, **arrival on a runway with no STAR data: moved to an arrival-capable runway with a STAR**, every frame aircraft resolves its plan leg with a callsign. |
| `integration/voice_language_normalization.test.js` | 11 | **Voice/language invariant regression** — the game's `VoiceCatalog` throws `InvalidOperationException` when a captain voice's language differs from the flight's `Language`. `_normalizeFlightsForGameCompat` repairs an `-EN` voice on a `zh` flight (and vice versa), a voice unknown to the catalog, never picks an `atc`-role voice, prefers a same-language voice already used in the level, leaves a consistent voice untouched, no-ops without a catalog, and repairs every mismatch in a mixed batch (8). `runChecks` reports `voice-language-mismatch` when the catalog is supplied, stays silent when voice/language agree, and skips the check with no catalog (3). |
| `integration/id_renumber.test.js` | 6 | **Strictly-ascending `$id` regression** — pins `id_renumber.js`: the ZSJN_peakdeparture `jetway:02` DockedAircraft crash pattern (wrapper $id 1123 declared before inline Aircraft 1120/shared String[] 1117) renumbers to ascending order; `$blobdoc` contents renumber as fresh documents with cross-scope `$iref` remap (external ids handled); non-id tokens byte-preserved; idempotent (second pass changes nothing); propagates through the GATCARC4 binary encode/decode pipeline via `writeAcl`; a dangling/forward `$iref` (target not yet declared) is preserved verbatim + its value reserved (no longer throws — the Ground Painter path requires saving files with deleted targets; the game reads a dangling `$iref` as null). |
| `integration/animator_lean_scope.test.js` | 3 | **Lean checkpoint-frame animator fix** — `_rebuildFlightRuntimeEntities` on a 16-type `CheckpointFrame` scope that omits `ContextCross.Models.AircraftAnimator` does NOT `[TYPE-ASSERT]`; rebuilt aircraft-animator entries carry a self-declaring full-form `$type` with one consistent id allocated above the scope's max; the default strict resolver still asserts on genuinely-unknown names and never fallback-mints `STRICT_JETWAY_TYPES`. |
| `integration/zeroflight_save.test.js` | 3 | **0-flight ACL save/load/re-save** — saving with an empty flight array clears all flight-plan/aircraft/animator runtime entities while preserving jetways/radio channels and re-encodes (no throw); `loadFlights` reloads it as an empty schedule (previously threw "No flight data found in ACL"); re-saving the flight-less file succeeds (the `DateTime`/`FlightPlanDepartureLeg`/`FlightPlanStaticItem` blobdoc type resolves are gated behind `hasFlights`). |
| `integration/scenery_roundtrip.test.js` | 7 | **Ground Painter write-path losslessness** — `patchSceneryBlob` on the decoded ZSJN fixture: no-touch graph → byte-identical output; moved survivor node position propagates to every incident segment/runway/stand; added nodes + segment (fresh ids, negative OsmId); stand delete; area vertex move/translate/add (asserts the inner `List<Vector3>` `$type` is never `0`). Requires the untracked `tests/_debug/ZSJN_leisure_1.decoded.txt` fixture (hard-fails without it). |
| `integration/scenery_delete_cascade.test.js` | 10 | **Stand-deletion reference cascade** — deleting a stand drops its `jetway:*` static item (`_cascadeOrphanEntries`), removes the matching checkpoint-frame `jetway:*` runtime entity (`_reconcileJetwayFrames`), "delete every stand" sweep, no-op self-heal path; plus 6 unit tests of `_reconcileJetwayFrames`/`_jetwayKeysFromEntries`/`_runtimeReconcilers` on synthetic text, including the **malformed-jetway regression** (`_isMalformedRuntimeJetway`): never fabricate a runtime Jetway for a static one (`addMissing` off), and drop any PhysicalRunway-shaped `jetway:*` entry (only `_latestDepartureRoll`) left by a pre-fix build (`Jetway 'jetway:NN' is missing required runtime fields`). Same `_debug` fixture requirement. (Formerly flaky against the 5s default vitest timeout; resolved by the global `testTimeout: 30000` in `vitest.config.js`.) |
| `integration/flightplan_ref_integrity.test.js` | 2 | **Flight-plan reference integrity (ground-painter save)** — reproduces the second fuzz crash, `Aircraft 'aircraft:<REG>' has no flight plan reference`: a static jetway with no runtime snapshot used to make `patchSceneryBlob` fabricate a runtime Jetway, whose reused `$id` collided with the flight-plan id block and bound `aircraft:REG._flightPlan` to a jetway `DockingAircraft`. On the `_debug` level, drives the real pipeline (`patchSceneryBlob` → `writeAcl` → `generateFullAcl`) and asserts (1) no runtime Jetway is fabricated (`addMissing` off) and (2) the saved `RuntimeEntities` scope has unique `$id`s and every `aircraft:*._flightPlan` `$iref` targets its own `flight-plan:<REG>`. Re-enabling jetway `addMissing` makes both tests fail. |
| `integration/ghost_ref_invariant.test.js` | 4 | **Ghost-node invariant (Ground Painter save)** — a node whose PK lands in `meta.deletedPks` stays in the graph for index stability but is NOT emitted; any NEW entity still referencing it serializes to `$iref:null` and aborts the save. Covers `ghostNodeIndices` identification and `repairGhostRefs` semantics (1 test, synthetic) plus — against the real ZSJN level — remap-to-live-coordinate-twin (leg survives, save encodes clean, baseline+1 segments), unrepairable-ghost leg dropped cleanly, and survivor-entity immunity (writer copies those verbatim). Fixture-gated: 3 of 4 tests skip without the game install (`AC27_GAME_ROOT`). |
| `integration/survivor_ref_gate.test.js` | 4 | **Survivor dangling-`$iref` gate (ZSJN_test game-load crash)** — deleted nodes vanish from the .acl while SURVIVOR entries are copied verbatim, so a survivor segment referencing a deleted node serialized a dangling numeric `$iref` that null-derefs the game's TaxiwaySegment2DFactory. Against the real level: deleted midpoint excised from a survivor polyline (last-resort removal warning surfaced), survivor segment with both endpoints deleted dropped, survivor rewired to a live coordinate twin, and the final validation pass drops a pre-existing corrupt ref even with no deletions. Fixture-gated: skips without the game install (`AC27_GAME_ROOT`). |
| `integration/scenery_physical_runway_cleanup.test.js` | 23 | **Runway delete/rename reconciliation (fully synthetic fixture — ships)** — checkpoint-frame `physical-runway:*` drop after a runway delete, rename remap, `addMissing` (synthesize a `PhysicalRunway` runtime entity when a frame has none, hardcoded `3|ContextCross.Models.PhysicalRunway` fallback), `_remapRunwayNameFields` (Runway/RelatedRunway/_departureRunway/_arrivalRunway/InitialRunways cascade), `_remapTaxiwaySegmentName` (oldPhysToNewPhys + end-name fallback), `meta.runwayPavement` population + runway move/reshape/add. The synthetic ACL now embeds a `RunwayTimeline`, and the runway-add test asserts the new runway's primary end is auto-appended to `InitialRunways`. |
| `integration/scenery_naming.test.js` | 7 | **Scenery name write-back** — Name fields written from graph `name`, `nameEdited` gating (unnamed objects keep original), canonical `Name` insertion for synthesized objects. Same `_debug` fixture requirement. |
| `integration/scenery_type_registration.test.js` | 2 | **`$type` re-registration repair** — `encodeArchive(renumberAclIds(patched))` throws `unknown type id` without `originalText`, succeeds with it (type ids recoverable from the original text are re-declared as inline `N|Name` forms at the first surviving bare ref). Same `_debug` fixture requirement. |
| `integration/runway_entry_type_id.test.js` | 10 | **Runway Entries/Exits type-id distinctness + no-fallback assert** — the GATCARC4 writer requires distinct ids for the array wrapper (`Runway+Entry[]`/`Runway+Exit[]`) vs the element (`Runway+Entry`/`Runway+Exit`); a guessed id collides as `"Type id N claimed by both ..."`. Pins `_typeId` parsing, `_sampleRunwayInnerType` returning `16` distinct from `15` (and `18` vs `17` for exits) and `null` with no fallback, editing entries/exits on the real fixture encodes with distinct ids, removing a direction's only entry still encodes (both directions re-serialized), no-edit round-trip, and synthesizing a runway without a sampled type **asserts** (`no fallback allowed`) instead of emitting `"$type": 0`. Requires the `ZSJN` fixture. **Shipped-v5 regression (1, game-root gated):** `_sampleRunwayShapes` resolves inline-optional sub-object types from the **PK-blobdoc type table** (ids are per-scope!) and omits `IsActive`/`ReactiveProperty<bool>` when the scope does not declare it, so adding a runway to a real v5 level encodes instead of throwing. **HoldingAreaData element type (1):** the inner element id is sampled distinct from the `HoldingAreas` array wrapper (24 vs 25) — emitting the array id made the game deserialize every holding as null (`HoldingAreaController.Init` NullReferenceException). |
| `integration/save_leg_type_idempotent.test.js` | 1 | **Flight-plan leg-type idempotency** (game-root gated) — a save whose store has no arrival legs emits no `FlightPlanArrivalLeg`, so the game strips the declaration from `StaticData.$blobdoc`. `_bdTnOrAlloc` re-declares a stripped leg/`DateTime`/`FlightPlanStaticItem` type under the next unused blobdoc-scope id (expanded `"N\|Name"` self-registers) instead of aborting with `blobdoc type "…" not in bdTypeMap`. Reproduces the `KJFK_peakarrival` fuzz: all-departure save → reopen → add one arrival → save. |
| `integration/runway_rename_drop_pavement.test.js` | 4 | **Runway rename/delete pavement-strip cascade** — a survivor runway dropped by the dangling-threshold gate records its PRE-rename `PhysicalName`, while coupled pavement strips carry the POST-rename designation. `_cancelRunwayRegistryForDrops` maps old→new (worklist, handles A→B→C chains), orphans both registry keys, and expands the dropped set so the name-based strip suppression drops renamed survivor AND synthesized `flags=4` strips — no `saved file has pavement strips without a runway` orphans. Covers forward rename, multi-rename chain, already-new, never-renamed. |
| `integration/gatcarc_v2_frame_edit.test.js` | 3 | **v2 checkpoint-frame edit persistence** — builds a synthetic GATCARC4 v2 archive with one checkpoint frame, edits the decoded frame doc, and round-trips through `writeAcl`/`readAclText`. `encodeV2Archive` re-encodes a decodable frame from its edited decoded text (`buildV2FrameSegment`) instead of re-copying `framesRaw` verbatim, so a removed runtime `flight-plan:` entity actually persists (bytes change, `B-BBB` gone); a frame whose inner payload is not a checkpoint doc is preserved byte-identical. |
| `integration/v2_frame_reconciliation.test.js` | 1 | **v2 checkpoint-frame reconciliation on a real level** (game-root gated, v2-only) — drives the real save pipeline on a copy of `ZSJN_leisure_1.acl`, deletes one flight, and asserts the re-encoded frame no longer keeps a runtime plan whose static item is missing (`resolution-missing-leg` empty) and the frame bytes differ from the verbatim copy. |
| `integration/runway_timeline_prune.test.js` | 10 | **RunwayTimeline dead-reference pruning + rename in change frames + new-runway auto-activation** — `_pruneRunwayTimelineReferences` drops `InitialRunways` entries whose runway no longer exists (keeps live entries, leaves the text untouched when all are live, seeds a live end when the list would empty), and now prunes the `Timeline` change frames: a `RunwayChange` whose `Source`/`Dest` no longer resolve is dropped, a `RunwayChangeFrame` whose `Changes` empties is removed, and every `$rlength` is recomputed. When **every** runway is gone (`liveEnds` empty — the ZSJN_runwaychange ground-editor "delete everything" case) it empties `InitialRunways`/`Timeline` instead of fabricating an end. `_ensureInitialRunwaysContain` auto-adds a newly-created runway's primary end to `InitialRunways` (empty list, append-missing, no-op, and no-timeline cases). `_remapRunwayNameFields` also remaps runway-change `Source`/`Dest` (not a `*Runway*` field name). |
| `integration/taxinav_stale_stand.test.js` | 4 | **Taxi-navigation cascade on stand deletion** — a deleted stand leaves its `taxi-navigation:pushback:*` points behind (they reference live taxiway nodes, so the dead-`$iref` test skips them) but `RelatedStand` names a missing stand. `_cascadeOrphanEntries(pk, si, deadIds, liveStandIdents)` drops a pushback point whose `RelatedStand` no longer resolves while keeping the shared `CrossTaxiwayNames` declarer, keeps live/empty `RelatedStand` points, and still drops dead-id references. |
| `integration/taxiway_path_continuity.test.js` | 3 | **Visual-path continuity** (`Taxiway visual path 'N' is discontinuous`) — `_renumberTaxiwaySegmentOrdinals` orders + orients each OsmId group and decomposes a branched group (a fillet stub attached at an interior node, degree 3) into separate continuous paths under a fresh negative OsmId; a simple linear path is unchanged. |
| `integration/scenery_taxiway_split.test.js` | 5 | **Pavement OsmId continuity + visual properties (auto-slice split)** — when the painter draws a taxiway onto a runway's type-4 pavement strip, the strip is split at the junction. Regression for `Taxiway visual path 'N' is discontinuous`: split pieces must be re-emitted under the parent strip's OsmId (as later ordinals of the SAME OsmId) via `parentOsm`, not fresh negatives. Pins that both split pieces fold into `OSM 50095` (`01/19` chain stays continuous), a genuinely-new taxiway (no `parentOsm`) still gets its own fresh OsmId, and — regression for `Taxiway segments '...:0' and '...:5' for OSM way '...' have inconsistent visual properties` — a split piece **inherits the parent's `Flags`/`IsHidden`/`IsUnselectable`** so every segment of one OsmId shares the same visual signature; **renaming a piece/way (2):** a raw-text `Name` edit on ONE piece (or a graph rename of one segment) heals group-wide on the next save — no graph edits — so the OSM way ends visually uniform. Same `_debug` fixture requirement. |
| `integration/taxiway_visual_props.test.js` | 5 | **Taxiway OSM-way visual-property continuity** (synthetic, no fixture) — `_renumberTaxiwaySegmentOrdinals` canonicalizes every `taxiway-segment` group to one signature via `_segVisualOf`/`_canonicalSegVisual`/`_patchSegVisual`: a piece renamed to `T42` (KDCA_leisure_2 `-378884`) unifies group-wide to the non-empty value; `Flags`/`Directed`/`IsHidden`/`IsUnselectable` unify too; a group differing only by `Head` counts as consistent (`Head` is deliberately not part of the signature — a directed way stores a per-piece head node); an already-uniform group is a byte-identical no-op; `_canonicalSegVisualMap` builds one canonical signature per OsmId (mode wins, non-empty `Name` beats the empty default). `_hasInconsistentSegVisual` gates the no-op early-return so a pre-fix file heals. |
| `integration/scenery_type_regroup.test.js` | 4 | **PK static-entity type regroup** — `patchSceneryBlob` regenerates `PKStaticEntities.$rcontent` in the file's canonical type order (`taxiway-node`, `taxiway-segment`, `airway-node`, `airway-segment`, `runway`, `stand`, `taxi-navigation`) so a newly-drawn node/segment joins its TYPE block instead of being appended after every `taxi-navigation` entry. Asserts no-touch stays byte-identical, the post-patch array is one contiguous run per type, the added node/segment counts land in the right blocks (original node indices stable across a re-parse), and `_regroupPkByType` buckets by type while preserving within-group order. Same `_debug` fixture requirement. |
| `integration/scenery_airway.test.js` | 8 | **Airway roundtrip (unified painter air mode)** — `buildSceneryGraph`/`patchSceneryBlob` with `airwayNodes`/`procedures`: no-touch lossless, add airway nodes (2 FIX), add procedure chaining 3 nodes, move airway node propagates to procedure geometry, delete via `deletedAirwayPks` drops node + degenerate procedure, `extractAirwayOsmPool`/`getAirwayOsmPoolInfo`, rename node/procedure persists. Same `_debug` fixture requirement. |
| **Livery page (custom liveries):** | **464** | |
| `utils/livery.test.js` | 14 | **Livery constants** — `OWN_PACK_NAME`, the 20-row `SHORT_CODE_TO_PLANE_ID` table and its reverse map, `LIVERY_FOLDER_SAFE_RE` (free-form names accepted incl. CJK/spaces; rejects traversal `../`, separators, Windows-reserved chars, leading/trailing dot/space, >64 chars), `folderFor` conventional default (unknown plane id falls back to the id itself), `buildManifest` template + free-form folder id sanitization (`My First Livery 01` → `my_first_livery_01_default` while keeping the structured display name/airline) + **`partName`** (defaults to `Body` for single-part types, binds to the passed `Fuselage` for multi-part A388/B38M) + **`targetModelVer`** (explicit carry-through incl. numeric→string coercion and `''`/`null`/omitted→`'1'` defaults with no `variant` key; C919 `2`), `TEXTURE_SIZE` = 2048 + `PANEL_GAP` = 128; **`baseFileName(partName, total)`** (`base.png` for one panel, `base_Part.png` otherwise, unsafe/empty part names collapse/fall back) + **`buildManifest` `parts`** (one `{partName, textures:[BaseMap]}` entry per painted panel). |
| `utils/liveryPaint.test.js` | 32 | **Painter pure helpers** — `MAX_UNDO` cap (≥20) with oldest-drop + redo-future invalidation; `undoStep`/`redoStep` round-trip; `hexToRgba`/`rgbaToHex` both directions incl. 3-digit shorthand + alpha; **colour-space conversions** for the RGBA picker (`hexToRgb` short/long/malformed, `rgbToHex` pad+clamp, `rgbToHsv` primaries/achromatic, `hsvToRgb` hue wrap + hex round-trip for every primary/secondary); scanline `floodFill` (solid region bounded by a wall, same-color no-op false, out-of-bounds false, tolerance bridging near-identical pixels while stopping at a barrier); **selection-mask ops** — `SELECT_MODES`/`MASK_OPS` triples, `maskPaintOp` combine/erase/replace recipes (unknown defaults to combine), `lassoBounds` bbox/empty, `wandRegion` spans/count/bounds (solid image, wall-bounded, tolerance, out-of-bounds null, input never mutated, **`region`-confined flood** — a multi-panel wand cannot leak past the active panel's rect and a seed outside it selects nothing), `constrainImageToMask` restore-outside/keep-inside incl. the 128 feather threshold + false-when-clean/missing, `isMaskEmpty` (below-threshold counts as empty); **mask-outline tracing** — `traceMaskBorder` (empty/unselected/zero-dimension → no edges, lone-pixel 4-edge perimeter, adjacent-pixel interior suppression) and `chainBorderSegments` (closed-loop chaining with every segment used once, one loop per disjoint region, empty/open-input handling). |
| `utils/liveryImage.test.js` | 7 | **Render-side image normalization** — `fileToDataUrl` resolves a File to a data-URL and rejects `READ_FAILED` on reader error; `normalizeToTexture` shrinks a 4096×2048 to 2048×1024 and centers it (fillRect full texture + drawImage at the centered offset, high-quality smoothing), never upscales a small image (100×50 kept as-is), honors a custom fill color, and rejects `BAD_IMAGE` on load failure or zero dimensions. |
| `utils/airlines.test.js` | 6 | **Airline display names** — `airlineDisplayName` en/zh names (`CCA`→Air China / 中国国航), raw-code fallback for unknown/empty; `AIRLINE_CODE_TO_NAMES` collects every name per code without duplicates and every name round-trips through `AIRLINE_CODE_MAP`; added carriers resolve by code (`TBA`→Tibet Airlines/西藏航空, `UEA`→Chengdu Airlines/成都航空, `CSH`→Shanghai Airlines/上海航空, `SWA`/`FFT`/`HAL`→Southwest/Frontier/Hawaiian). Backs the livery painter's airline dropdown hint. |
| `electron/livery-ipc.test.js` | 74 | **Own-pack disk backend** (`electron/livery.js`, node env) — `listLiveries` empty/missing dirs/`NO_GAME_ROOT`/non-directory skip/corrupt-manifest tolerance; **`mod_info.json`**: (re)written on load + create at the pack root (never inside a livery folder), repaired when it carries the reference pack's `modName` or unreadable JSON, an existing own file left untouched (extra fields preserved), UTF-8 Chinese name round-trip, never listed as a livery row; `createLivery` round-trip (pack dir + base.png + manifest template, free-form folder verbatim, filesystem-unsafe folder rejection, silent overwrite with no `.bak`), bad airline/plane/image + non-2048 IHDR rejection; `createLivery` copies the built-in `targetModelVer` (C919 `2` + no-`variant`, missing-version→`1`, numeric/`''`/corrupt-manifest→normalized fallback) + pure `buildManifest` defaulting (`undefined`/`null`/`''`→`'1'`); containment check + `../` traversal rejection for delete/read; `deleteLivery` removes only the own pack (never the reference pack); `pngSize` IHDR parsing; `readDiskImage` data-URL by extension; share round-trip (export ZIP with folder-prefixed entries → copy temp → delete → `loadLiveryZip` restores pixel-identical base.png + deep-equal manifest, free-form zip folder derives shortCode from the manifest, bad-zip/no-manifest rejection); **`readAircraftTemplate`** — `NO_GAME_ROOT`/`BAD_PLANE` guards, `NO_TEMPLATE` for a type with no built-in folder, decodes the built-in `base.dds` (DXT1) to a 4×4 PNG data-URL + caches it, Y-flips a non-uniform template (the DDS's bottom row becomes the PNG's first scanline) so the painter background matches the in-game BaseMap orientation, `Body`/`Fuselage` part preference + first-part fallback, PNG/JPEG BaseMap passthrough, `BAD_TEMPLATE` for an unsupported DDS encoding, `IMAGE_MISSING` with no BaseMap or a non-array `parts`, a manifest parse error surfaced (not `NO_TEMPLATE`); **`listAircraftTypes`** scans the built-in default livery dir (`NO_GAME_ROOT`, empty when the dir is missing, only manifest-bearing folders collected sorted with their short codes, `createLivery` accepts a scanned type via a derived short code, and a type with neither a table entry nor a built-in folder is still `BAD_PLANE`); **multi-part A388/B38M** — `hasBasePng`/`readLiveryImage` resolve `base_Fuselage.png` through the manifest (main part first, then any part, then a legacy `base.png`; JPEG MIME preserved), `readAircraftTemplate` returns **every** BaseMap part + `readLiveryImages` reads all panels of a stored livery (`NO_GAME_ROOT`/`BAD_FOLDER` guards, a missing folder → `IMAGE_MISSING`, a legacy `base.png` fallback when the manifest carries no BaseMap, and the reference pack through the same path), `createLivery({images})` writes `base_Fuselage.png`/`base_Wing.png` (dropping a stale `base.png`) with a multi-part manifest, resolves a caller-omitted `partName` from the built-in binding at the same index, and rejects a non-2048 panel before writing anything, `loadLiveryZip` returns every part, `createLivery` writes `partName: "Fuselage"` from the built-in default (still `Body` when the type has no built-in folder), `exportLivery` zips **every** texture image (and reports `IMAGE_MISSING` when the folder has none), and `loadLiveryZip` previews the main-part BaseMap (PNG or JPEG); **`readLiveryThumbnail`** — `NO_GAME_ROOT`/`BAD_FOLDER`/`IMAGE_MISSING` guards, verbatim full-image fallback with `thumbnail:false` when `nativeImage` is unavailable (node env, JPEG MIME preserved), odd sizes clamped, and (via an injected fake `nativeImage`) a 256px JPEG data-URL with `thumbnail:true`, custom-size resize args, in-memory cache hits, empty-decode fallback, and containment still enforced. |
| `electron/dds.test.js` | 16 | **DDS→RGBA + PNG codec** (`electron/dds.js`, node env) — `decodeDds` decodes a solid DXT1 4×4 block to its endpoint colour, the 1/3+2/3 blend when `c0 > c1`, the transparent-black mode when `c0 <= c1`, DXT5 (alpha + colour, interpolated alpha indices) and DXT3 (explicit 4-bit alpha); rejects a non-DDS buffer / unsupported fourCC (`BC5U`) / truncated block payload / out-of-range dimensions / a too-short buffer; `encodePng` emits a valid RGBA8 PNG whose IHDR matches the source size and whose IDAT inflates back to a filter-0 raw stream; `ddsToPngDataUrl` round-trips DXT1 + DXT5 textures to PNG data-URLs (first pixel = colour0 endpoint), **flips Y** (a non-uniform texture's bottom DDS row becomes the PNG's first scanline) so the painter template matches the in-game BaseMap orientation, and returns null for an unsupported texture. |
| `components/LiveryScreen/LiveryScreen.test.jsx` | 25 | **Livery shell** — header hosts Back/Help/Pack (LHS; the icon-only help sits right after Back, matching the painter) + New/Select All/Export/Delete/search (RHS, Export/Delete icon + label), old tabbar/bottombar gone; search input renders (no redundant tooltip); **Ctrl+F focuses the list search box** (ignored while typing, with a modal open, or on the painter page); Back→browser; New opens the painter (`Save As`, `.livery-canvas-wrap`) and its Back returns to the list; header select-all + batch delete end-to-end; Export/Delete stay disabled until a selection (Export needs exactly one); search filters; Pack opens the install modal + download overlay and shows the Mods target; **page-scoped help overlay** — the list page shows only the list-page actions (no painter/tool sections), the painter page shows only the painter/tool sections (no list section; undo/redo/zoom/fit and duplicate/remove-sticker are intentionally not listed), and every listed chip carries help text — the painter top bar documents the delete-this-folder action (`deleteThis`); both pages end with the post-save mod-enable warning as a highlighted tip (`#livery-help-tip`); closes via Escape/backdrop; header tooltips (New exempt); **unsaved guard:** a dirty `window.__liveryPaintGuard` blocks New + Back with the Unsaved Changes modal until Discard; clicking a card opens the painter prefilled (with no pixels — the painter lazy-loads the full texture itself); the per-aircraft **add-livery card** opens the painter with that type pre-selected; install modal Close dismisses; **thumbnails:** list previews render from the `read-livery-thumbnail` channel (the full image is never pulled), a rejecting thumbnail channel falls back to the full image, and search narrowing discards stale in-flight thumbnails. |
| `components/LiveryScreen/MyLiveriesTab.test.jsx` | 40 | **Livery list** — empty/search-empty placeholders; the thumbnail box (with its solid placeholder background) is reserved before the image resolves (no `<img>` yet, so cards never reflow as thumbnails arrive); grouping by aircraft with counts + collapsible headers; search by airline/folder/aircraft; each own card carries an in-card checkbox (over the thumbnail) and **no** per-card action buttons (Edit removed); header export/delete commands act on the selection (export runs export+save-dialog and toasts, cancel stays silent); checkbox tooltip; mine+reference merge into one folder with lock marks (reference not selectable, no checkbox); select-all/export/delete-selected commands publish bar state (`oneSelected`); single vs batch delete confirms; clicking a mine/reference card opens the painter with pack and no pixels (the painter lazy-loads the full texture itself); the checkbox doesn't open it; **thumbnails:** list previews come from the `read-livery-thumbnail` channel (the full image is never pulled), a rejecting thumbnail channel falls back to the full image, and search narrowing discards stale in-flight thumbnails; Enter/Space on a focused card opens it; **error paths:** list failure/rejection, delete/export/save-dialog failures, bad-manifest row, unknown-aircraft group, batch-delete partial success (only the rows that actually deleted are dropped in place — the failed ones survive, the list is never re-fetched, and an in-place delete caps `scrollTop` to the shrunken content); **add-livery cards + scanned empty folders:** an add card in every aircraft folder (`onCreate(planeId)`, `onEdit({targetPlaneId})` fallback), a group (and card) for every scanned type even with zero liveries, scanned ∪ row-backed types deduped, an empty folder kept only when its type matches the search (no-match placeholder otherwise), no card on the unknown type, and a failed type scan still rendering row-backed folders. |
| `components/LiveryScreen/CreateTab.test.jsx` | 62 | **Livery painter form** — defaults to the first airline + `AIRBUS A-319neo` (valid out of the box, no blank option in the type select) and still validates a typed `[A-Z]{3}` airline + known aircraft (short codes disable Save/Save As); **aircraft-type dropdown is compiled from the scanned built-in liveries** (`list-aircraft-types`; the current value is kept even when absent from the scan and a scanned type not in the table is form-valid, using its table short code for the Save As prefill); a **locked reference** origin disables + greys the airline input/toggle and type select (own liveries keep them enabled); airline combobox lists all airlines and selects/Escape-closes; naming dialog prefilled with the conventional `A20N_CCA` folder and accepts free-form names verbatim (airline/aircraft never parsed from the folder), blocks filesystem-unsafe names; Save As calls `create-livery` and STAYS in the painter (no navigation; the saved folder becomes the current origin); **Ctrl+S** opens Save and **Ctrl+Shift+S** opens Save As (ignored while typing or while a dialog is open, and after a save the painter adopts the saved folder so a later Save overwrites it in place); **overwrite confirm** (Save As onto a folder found in `list-liveries` pops the Overwrite modal — clicking Overwrite saves, Cancel aborts with nothing written, a fresh name and a Save re-writing the livery's own folder both skip it, Save As still asks when its prefill equals the origin folder, the match is case-insensitive, and an unreadable/failed list result falls through to the save); **post-save mod hint** (`get-cache-flag liveryModHintDismissed`; Save/Save As success pops the "Enable the Mod in Game" prompt (incl. priority-to-top + Refresh-list guidance, asserts the `Refresh list` copy) with a *Don't show again* checkbox that persists via `set-cache-flag`, OK without ticking writes nothing, the prompt stays hidden once the flag is set, it still shows when the flag read fails, and a failed save never reads the flag or prompts); **aircraft template** (the type's built-in template is fetched on mount/selection for both a new livery and a saved origin — the new canvas is primed with it and is re-primed on a type change only while **untouched**, a saved origin keeps its own image but Clear restores the type default, and painting then picking another type does not reset the canvas); **airline/aircraft pickers just close** (the airline combobox is not wrapped in a `<label>` — picking an airline or changing the aircraft type never remounts/clears the canvas); `mine` origin Save overwrites the origin folder with the origin parts while the form is unchanged; changing Airline and/or Aircraft (both, airline-only, aircraft-only) re-derives the Save default name (`{TYPE}_{AIRLINE}`) and writes the new airline/type into the manifest, and retyping the origin folder updates that livery in place; `reference` origin disables Save (locked) but allows Save As; import image → `normalizeToTexture`; load-from-ZIP primes the canvas + form; ZIP load failure/cancel; **Export** (save canvas → `export-livery-to-dir`, failure/cancel paths); lazy-loads the origin picture when the thumbnail is missing (preferring every `read-livery-images` panel, falling back to the single `read-livery-image`); a new-livery prefill (`{targetPlaneId}`, no folder) pre-selects and accepts that type even when the built-in scan is unavailable; **multi-image type** — a 2-part built-in template lays out a 2-panel store (2×2048 + a 128px gutter) and Save sends two ordered `images`; **unsaved-changes guard** on import/Cancel (Discard proceeds, clean canvas returns immediately); help button; failed import normalization toast. |
| `components/LiveryScreen/LiveryCanvas.test.jsx` | 170 | **Paint canvas** — tool rail single-active switching; brush stroke (undo snapshot + stroke/lineTo); **the fill tool paints its own bottom layer (`data-layer="fill"`) under every movable while the pen stays on top (`data-layer="paint"`); export composites base → fill → movables → pen and undo restores both raster layers**; **the eraser only removes — it punches BOTH raster layers transparent (`destination-out`, base shows through) and never paints background pixels**, and trims touched movables' holes in their own layer; eyedropper picks the pixel colour compositing the live objects (a sticker/shape/text colour is picked over the base, with a base fallback) and returns to brush; **canvas shortcuts stay inert while an app modal is open** (save naming / overwrite / post-save mod-hint popups never deselect, remove or mutate the live movable — the selection survives the save, shortcuts work again after close); **Delete-with-selection trims transparent** (the region is punched out of the paint layer via `destination-out` with the base showing through — never painted over with background pixels — while touched movables keep `erasePolys` holes in their own layer, so no fake-background ghost stays behind when the sticker moves; flat-white fallback only with no base image); flood Fill samples the VISIBLE composite (base → fill → movables → pen) and paints scanline spans into the fill layer with the tolerance bound + tolerance slider (it never floods the transparent fill layer itself, which used to fill the whole square); **every options-bar slider takes typed numbers** (wand/fill tolerance, brush/eraser size, shape width, font size, sticker opacity: slider + numeric field sharing one clamped state, blur/Enter commits, out-of-range clamps, empty reverts, Escape discards the draft, slider follows); line/rect/ellipse draw on pointer-up + width/fill controls; **Line Straight/Curve sub-modes** (toggle shown only for Line, Straight default; Curve appends a control point per click and commits a selectable curve on Enter or double-click while staying in curve mode, Escape cancels, a degenerate <2-point draft never commits, right-click pops the last point then cancels a lone one); text font/size/bold/italic options; **custom RGBA colour picker** (swatch popover with hue/alpha rails, hex field, SV-square drag, backdrop/toggle/Escape dismissal; the picked alpha is composited once per brush stroke through a per-stroke layer — dabs are opaque so overlapping caps cannot pile up — and baked into fill/text colours) + hard/soft (soft sets a shadow blur); options bar stays mounted for option-less tools; true-size cursor ring (show/hide, size × zoom); undo/redo replay snapshots (a move/resize/rotate/vertex drag is one undo step — a scaling drag reverts with Ctrl+Z); **Clear** confirm resets to the aircraft type's default livery (`defaultParts` wins over the primed `initialParts`, so a saved origin livery is replaced by the type default; falls back to the neutral fill; Cancel leaves it untouched); keyboard tool shortcuts + Ctrl+Z (`[` / `]` resize the brush/eraser and are inert for other tools; a click then Shift-click chains straight brush/eraser segments); zoom in/out/fit readout + **wheel** zoom anchored at the cursor; a **Space-held hand icon** follows the pointer for panning (canvas cursor hidden); **right-click** picks the pixel colour without switching tools and the native context menu is suppressed (outside the Select tool's object sub-mode it always picks — so a pen-tool right-click is a colour pick, never the movable menu); sticker import/duplicate/remove; **live objects** — a text commit is a selectable, non-rasterised object (object actions light up, base `fillText` untouched, export flattens it), the pending draft commits on Enter, input blur, a rail/keyboard tool switch or a canvas click (only Escape cancels), deselecting with Escape keeps it, clicking inside re-selects and dragging moves it; **line/rect/ellipse** commits create selectable shape objects (no rasterisation; the shape tool stays active so several can be drawn in a row) that can be picked up and moved, and **`A`** selects the Select tool; **multi-object layer** — a newly drawn shape no longer flattens the previous ones (every object stays selectable/removable, the topmost under the cursor wins), duplicate copies the selected object (original + copy both stay live, nothing stamped on the base), and undo/redo restore the whole object stack alongside the raster; **text re-editing with Select** — selecting a text object re-exposes font/size/bold/italic and applies them in place, and double-click re-opens the inline editor prefilled so its content can change without adding a new object (Escape cancels; Enter clears the selection instead); **Flip Horizontal/Vertical** (disabled without a live object; the H / V keyboard shortcuts mirror the rail buttons) drives `ctx.scale(-1, 1)`/`(-1, -1)` on the next draw for stickers, text and shapes (and Ctrl+C duplicates the selected object, with the rail tooltips advertising H / V / Ctrl+C / Del / Ctrl+Z / Ctrl+Y); export flattens over an opaque (never transparent) background, failed sticker read toast (BAD_IMAGE); save payload is a 2048 PNG data-URL; **layer order** — pure `reorderObjects` moves/no-ops/immutability plus the right-click menu (open on a shape, Send-to-top reorder + close, end-state disabling incl. the lone-object all-disabled case, backdrop/Escape/empty-canvas/left-click dismissal, right-press selects without opening, the menu is gated to Select object mode so a right-click in any other tool picks the colour instead, selection-less Delete takes the topmost, keyboard shortcut dismisses the menu, `reorderObject` via ref, undo restores the order) and keyboard-parity gesture settling (a shortcut commits a mid-drag shape); **selection mask** — Select sub-modes Object/Pen/Wand (Combine default, Erase/Replace switching, wand tolerance slider), pen lasso → closed-path mask fill + white-dot/black-border outline + Deselect, Ctrl+D deselects (mask first, else the selected object), tap/Escape cancel, wand floods the connected VISIBLE-colour region (base → movables in their `clipMask`-clipped form → paint, span runs composited into the mask), a masked brush stroke triggers the `putImageData` clip while an unmasked stroke never does, a live selection never masks movables (full objects render and export), a movable added while a selection exists is stamped with `clipMask` at creation and stays clipped forever (one placed before stays whole; a duplicate inherits the stamp), leaving Object mode cancels the movable selection while a pen/wand mask survives, the mask outline + lasso draft draw last, **Del with a selection is the marquee eraser** (background restore + `erasePolys` holes punched into touched movables; a fully-consumed object is dropped while no selection still removes the selected object), A/L/W switch the Select sub-mode from ANY tool (switching to Select first, which is why Line is U and ellipse M), the five stacked `data-layer` canvases (base → fill → objects → paint → chrome) keep the fill under and the pen above the live movables, a lasso/wand is confined to the active panel and **a single click in another panel both activates it and runs the wand there in the same press** (the active-panel mirror targets the panel just clicked), and all new keys resolve in zh+en; **flipped handles** — after flipping both axes a sticker still scales by dragging the drawn bottom-right dot (and does NOT body-drag instead) and a rect shape scales the same way once the Select tool is active, plus the rotate dot drawn above the box still grabs on a flipped sticker; the box/handles live in the unflipped frame, so the grab zones are not mirrored (the old `flipLocal` mirroring broke scaling for every flipped sticker/shape); **sticker opacity slider** — a selected sticker gets an Opacity 0–100% slider on the options bar (defaults to 100%, `%` readout) that stores the alpha on the object and repaints the overlay at that `globalAlpha`, exports/dedupes the sticker with the same alpha, keeps the value across a deselect/re-select, and is offered only for a sticker (a selected text object shows the text options instead); **multi-image panels** — a 2-panel canvas is 4224×2048 (2 × 2048 + a 128px gutter), there is **no tab strip** (a left click inside a panel makes it active via `onActivePanel`, a click in the gutter activates the nearest panel, and keyboard shortcuts never change it), the padded overlay canvas is `W+2·OVERLAY_PAD` wide so a selection box / scale-rotate knob stays usable outside the 2048 square (a scale drag keeps registering past the edge), each movable renders in ITS OWN panel (clipped to the persisted `panel` — the panel under the POINTER when it was dropped, so dragging by an edge moves it across even before its centre crosses; a movable without one falls back to the panel its centre is in — so an unselected object on another panel is still visible; export does the same, never the active panel), an object can move outside the active panel (overflow clipped, not clamped), `exportParts()` returns one 2048² PNG per panel in order, a single-panel canvas exports a one-entry `Body` list, the pure `panelLayout` helper derives the count/gap/width/panel origins (never fewer than one), and an imported sticker drops on the active panel's centre and hands over to single-select (Object mode) so it is immediately moveable. |
| `components/LiveryScreen/LiveryColorPicker.test.jsx` | 9 | **RGBA colour picker popover** — portals into `document.body` anchored at the swatch rect (left/top from the anchor); renders hue + opacity rails, the saturation/value square and the hex field with the alpha readout; an SV-square drag emits `{color, opacity}` (keeps the current alpha, #804040 at the jsdom centre); the hue rail re-derives the colour (#0000ff at 240°); the alpha rail emits the new opacity; the hex commits on blur and on Enter (3-digit shorthand expanded) and rejects malformed input; Escape closes via the window capture listener, the hex field, and the backdrop pointerdown/right-click; the hue is retained across achromatic colours and updated for saturated ones. |
| `components/LiveryScreen/InstallPackTab.test.jsx` | 9 | **Pack installer** — explanatory panel without a target; Mods target derived from `rootPath` (backslash + slash); Install opens the download overlay + calls `download-livery`; successful download installs the ZIP and toasts; `NO_GAME_ROOT` mapped message; generic failure verbatim; failed download falls back to the local ZIP picker; cancelled picker stays silent; Close dismisses the modal. |
| **Electron backend:** | **144** | |
| `electron/cloud-llm.test.js` | 49 | Multi-vendor cloud LLM module. **VENDORS registry (6):** all 4 vendors have name/icon/models/baseURL, model list matches expectations. **getVendorForModel (10):** resolves all 8 models to correct vendor key+name, null for unknown/empty, baseURL present for non-Claude. **getAvailableModels (4):** empty when no keys set, filters by key presence, returns all 8 models when all keys configured. **mcpToolsToOpenAITools (3):** MCP→OpenAI function format conversion, preserves minItems/maxItems. **sanitizeToolsForVendor (6):** strips OpenAI-only keywords (minItems/maxItems/default/const) for Gemini, recursive stripping of nested items, leaves non-Gemini unchanged. **chat entry errors (5):** unknown model throws, missing/empty API key throws per vendor. **chat success OpenAI path (2):** single-turn response, existing system message preserved. **tool calling loop (3):** multi-turn tool calls→final text, tool error recovery, malformed JSON arguments. **conversation tracking (1):** multi-tool conversation grows correctly across iterations. **Gemini sanitization via chat (1):** keywords stripped before Gemini API call. **Claude Anthropic path (4):** basic chat, tool→input_schema format conversion, tool_use loop, tool error handling. **thinking (3):** Claude thinking blocks + DeepSeek reasoning_content passed through, accumulation across tool turns. **empty-content nudge (2):** OpenAI + Claude nudged when only thinking returned. |
| `electron/updater.test.js` | 35 | Auto-update module. **computeFileMd5 (3):** known content hash, different content produces different hashes, rejects on non-existent file. **isUpdateSupported (5):** true on win32+packaged+PORTABLE_EXECUTABLE_FILE, false when not packaged, false on darwin, false when PORTABLE_EXECUTABLE_FILE not set — the voice build is now supported too (auto-updates via the shared `/editor` route, header-scoped). **isVoiceBuild (4)** + **variantName (2)** + **variantHeader (2):** normal/voice names and the `X-AC27-Variant` header they produce (single `/editor` route — the Worker selects objects per header, no path change). **createUpdaterScript (3):** generates .bat with expected commands, handles paths with spaces, cleans up stale .old before rename. **checkForUpdate (3):** no update when not supported, no update when exe missing, skipped etag recognized. **resolveTargetExe (5):** PORTABLE_EXECUTABLE_FILE, execPath fallback, AC27_UPDATE_TARGET in dev, auto-discovered artifact, null when no candidate. **checkForUpdate gates (6):** packaged but not portable, voice build proceeds to the network route, dev with AC27_UPDATE_TARGET, dev by default (opt-out), dev with AC27_UPDATE_DEV_CHECK=1, dev with no target exe. **installUpdate (2):** dev dry-run default, dry-run skips spawn+quit. |
| `electron/bepinex.test.js` | 28 | BepInEx lifecycle: checkStatus (null, partial, full, empty); findDownloadUrl (URL extraction, artifact not found, HTTP error); downloadZip (happy path + file content + incremental progress, HTTP 404, network error, timeout — all with file cleanup); extractZip (non-Windows guard); installFiles (subdirectory, missing items, flat structure); removeFiles; installLatest (full pipeline, error cleanup, progress normalization) |
| `electron/cache-flags.test.js` | 10 | **Cache flag bag** (`electron/cache-flags.js`, node env) — the pure whitelist + merge logic behind `get-cache-flag`/`set-cache-flag`: `CACHE_FLAG_KEYS` contains `liveryModHintDismissed` and rejects unknown/proto keys; `readCacheFlag` returns `BAD_FLAG` for unknown keys, reads set/unset/missing payloads as booleans (coercing truthy), and tolerates a null cache or missing `flags` bag; `writeCacheFlag` returns `BAD_FLAG`/`NO_CACHE`, merges without dropping sibling flags, creates the `flags` bag, coerces to boolean, and round-trips through `readCacheFlag`. |
| `electron/api-server-air.test.js` | 2 | **Air MCP tools registry** — `MCP_TOOLS` contains `create_airway_nodes`, `create_airway_procedures`, `delete_airway_objects`, `move_airway_objects`, `rename_airway_object`, `create_airway_fillet`; `get_ground_painter_state` description mentions graph. |
| `electron/api-server-air-functional.test.js` | 20 | **Air MCP functional** — end-to-end exercise of the 6 air MCP tools (`create_airway_nodes`→`create_airway_procedures`→`move`→`rename`→`fillet`→`delete`) against a live `buildSceneryGraph` graph + `groundPainterHistory`. Also pins `delete_ground_objects` on a runway: the orphan GC receives duplicate candidate indices (thresholds ARE pavement-strip endpoints) and must dedup — without it a nearby segment collapses to a self-loop |
| `components/voice_listener_leak.test.jsx` | 1 | **Voice listener leak guard** — `VoicePTTButton`/`VoiceCommands` event-listener cleanup on unmount (no dangling `udp-aircraft-state` / `keydown` listeners) |
| **MapWindows (21 files):** | **738** | |
| `components/MapWindows/voiceNumberParser.test.js` | 46 | `parseEnglishFlightNumber`: individual digits, "oh"→0, teens, grouped pairs, "triple X"/"double X" aviation shorthand, stop at non-numbers, >6-digit filter, empty input, "the" mid-number skip, digit confusables ("new"→two/nine). `parseChineseFlightNumber`: 幺-series, 一-series, 洞/两/零 variants, multi-token, stop at non-digits. `generateCallsignCandidates`, `lookupEnNumberToken` fuzzy guard ("right" blocked), `lookupUnitWord` |
| `components/MapWindows/voiceCallsignParser.test.js` | 71 | `detectLanguage`: EN/ZH/empty/mixed. `parseCallsign` (EN): "united eleven eleven"→UAL1111, full airline name, 3-letter code, "delta"→DAL, KLM, longest-match priority, teen numbers, callsign-only (no command), null on no-match/empty. `parseCallsign` (ZH): 东方/中国东方航空/国航 with digits. Proximity + phonetic-skeleton fallbacks, pre-number "at" strip, "new" confusables, "the" skip, Korean Air→KAL, `callsignCandidates` |
| `components/MapWindows/voiceCommandMatcher.test.js` | 21 | Exact alias matching (EN): cleared to land, clear for takeoff, go around, line up and wait, contact ground/tower, push back, taxi via with sub-item, stand by, hold position. Fuzzy fallback with partial word overlap. Chinese aliases: 可以落地/可以起飞/复飞/联系地面/等待/穿越跑道. `buildSpeechGrammar` JSGF output |
| `components/MapWindows/voiceTranscriptParser.test.js` | 60 | Transcript → command-chain parsing, cfa + runway, chaining, notices/reason contract, `parseVoiceCandidates` alternates, synthetic aircraft list |
| `components/MapWindows/voiceDeviationMatrix.test.js` | 293 | Human-language deviation matrix — every row pins the FULL parse outcome (incl. groups 6b/8c: cfa deviation budget, runway golden path, callsign proximity + phonetic skeleton + round-3 rows (letter-spelled ILS, callsign noise at/the/new, KAL code, runway through/urine); 12 = direct-to payload exactness + flight-prefix direct rows) |
| `components/MapWindows/voiceSpokenNumberValue.test.js` | 34 | `parseSpokenNumberValue` EN/ZH values incl. the runway fuzzyGuard (three one right → 31, never 318) |
| `components/MapWindows/voiceFuzzy.test.js` | 32 | D-L/curated-confusable policy leaf behavior |
| `components/MapWindows/voiceFuzzyAcceptance.test.js` | 17 | Round-trip of the exhaustive acceptance fixture + flight-number guard pins |
| `components/MapWindows/voiceSkeleton.test.js` | 6 | `enSkeleton`/`skeletonMatch` (phonetic stage: digraphs, guards, ties) + runway fallback integration |
| `components/MapWindows/voiceWaypointMatcher.test.js` | 19 | Direct-to waypoint slot: single-token exact → D-L ≤ 2 → spelled-letter sequences |
| `components/MapWindows/voiceCandidates.test.js` | 14 | `parseVoiceCandidates` primary/alternate ordering + waypoint threading |
| `components/MapWindows/voiceGrammarConsistency.test.js` | 3 | Pins `electron/voice-grammar.json` ⇄ live parser tables (en + zh) |
| `components/MapWindows/SimClock.test.jsx` | 5 | Null/0/undefined → null output; valid timestamp → HH:MM:SS UTC; midnight → "00:00:00" |
| `components/MapWindows/useSvgZoom.test.js` | 22 | Init state, auto-init on data load, zoomIn/zoomOut bounds + center, panLeft/panRight/panUp/panDown with clamping, wheel zoom cursor-centered, drag pan start, reset functions preserve zoom + axis |
| `components/MapWindows/useUdpAircraftState.test.js` | 7 | Default state (incl. `udpConnected: null`), subscribe on mount, unsubscribe on unmount, handler updates state, null/undefined safety, missing API methods, `udpConnected` mirrors the pushed payload (`true`/`false`) and stays `null` when the field is absent (unknown ≠ disconnected) |
| `components/MapWindows/SpinKnob.test.jsx` | 16 | Rendering with/without label, SVG structure (bezel, face, ticks, center, indicator, arrow), position→angle mapping at 0/0.5/1/clamp, indicator sync, scroll up/down direction, click-reset |
| `components/MapWindows/ControlSidebar.test.jsx` | 6 | 3 spin knobs rendered, actions section, children in actions, airspaceKnob optional, label presence |
| `components/MapWindows/GroundMapWindow.test.jsx` | 21 | Loading/error states, data fetch args, window title, SVG rendering, aircraft filtering (airborne y>1, stand proximity), Show All toggle, click-to-select UDP command, taxiway polylines, runway polygons, non-aircraft type=0 filtered out, type=4 (unknown) renders; **no-session overlay** shows on `udpConnected === false` (with the `map_no_session` copy) and is hidden while a session is live |
| `components/MapWindows/AirMapWindow.test.jsx` | 24 | Loading/error states, border overlay, airport mismatch filter, airborne filter, click-to-select UDP command, range rings, runway thresholds, route polylines, toggle states (the old bg-image toggle is gone), emergency double-click, airspace knob, non-aircraft entity filtering (type=0 excluded, type=4 shown), v4 active-runway variant filtering, fixes/waypoints layer (hidden by default, Waypoints toggle, Labels-gated fix names, runway-filter independence); **no-session overlay** shows on `udpConnected === false`, hides while live, and dismisses on a backdrop click but not on a click inside the notice |
| `components/MapWindows/LiveSessionOverlay.test.jsx` | 6 | **No-session blur notice** — renders nothing while a live session is detected; shows the `map_no_session` copy when disconnected; clicking inside the notice does not dismiss it while a backdrop click does; the dismissed state re-arms on the next reconnect→disconnect transition (a later disconnect must show it again); the notice is translated in Chinese (未检测到进行中的关卡。) |

### Expected outcomes

| Category | Expected |
|----------|----------|
| Time utils | All conversions round-trip correctly. Edge cases (null, empty, overflow) handled without throw. |
| Validators | Duplicate callsigns detected; no false positives on empty values. `detectStandConflicts` enforces the game's stand-overlap rules (dep/dep flagged, arr/arr allowed, offblock strictly before landing). `runTripleValidation` skips InBlockTime/TakeoffTime time-order checks (v4 stores them as 0) but still runs dropdown + stand-conflict + **RunwayTimeline** (empty/duplicate time/pair) + **inactive runway at landing** (chronological active-set sweep) validations. The inactive-runway rule is **skipped when the level has no active-runway source** (empty `initialRunways` + empty `timeline`). It applies a **10-min transition grace** (a runway deactivated within 600 s of landing — aircraft already on final — is not flagged; `KJFK_runwaychange`). `getActiveColumns` hides InBlockTime/TakeoffTime columns. `_isNew` stripped from sidecar JSON at all nesting levels. |
| Store | All actions produce correct state transitions. `modified` flag set on mutations. Chat panel open/close, messages, errors, config, and setup steps all correctly managed. |
| Modal | Opens/closes via store state. Backdrop click calls `hideModal`. Internal clicks stop propagation. |
| BrowserScreen | Help overlay, debug mode toggle, livery navigation, demo file filtering (whitelisted/non-whitelisted .demo files hidden in non-demo mode, shown in demo mode), tooltip positioning, collapsible airport cards (header click toggle; one-shot session auto-collapse keeps all airport headers visible; collapse state persists across remounts). |
| Livery page | Own-pack list/create/delete/read/export/load round-trips on disk; own `mod_info.json` (re)written on load/create with the custom liveries name, repairing the reference-named one the official pack zip ships; free-form filesystem-safe folder names used verbatim (airline/aircraft always from the manifest, never parsed from the folder); `../` traversal rejected; reference pack read-only. Painter: airline combobox, Save (live form — unchanged→origin folder in place, airline/aircraft change→re-derived `{TYPE}_{AIRLINE}` + manifest rewrite, reference locked) vs Save As (live form), naming dialog + free-form names, Save As overwrite confirm when the folder name is taken (Cancel aborts), post-save "enable the mod in game" prompt (priority-to-top + Refresh-list guidance) with a persisted don't-show-again flag, page-scoped help overlay (list vs painter buttons), import image/ZIP, export ZIP, new/dirty-canvas guard, per-aircraft built-in UV template priming (opaque 2048 export with live stickers flattened), and the full tool set (brush/eraser/picker/fill/shapes/text, undo/redo, clear, zoom), plus floating sticker/text objects (import, move, rotate, duplicate, remove, horizontal/vertical flip). Pack install downloads → installs, with a local-ZIP fallback on download failure. |
| Toast | Renders based on store state. `show` CSS class controls visibility. |
| Electron — cloud-llm | All VENDORS entries consistent. Model→vendor lookup correct for all 8 models. getAvailableModels filters by key presence. MCP→OpenAI tool conversion preserves schema keywords. Gemini sanitization strips OpenAI-only keywords recursively. Chat throws on missing key / unknown model. OpenAI chat completes single-turn, multi-turn tool loops, handles tool errors. Claude chat uses Anthropic SDK format (tools→input_schema, system top-level). Thinking blocks accumulated and passed to callback. Empty-content nudge triggers when model returns thinking-only. |
| Electron — updater | MD5 computed correctly. Platform/package gates prevent unsupported updates. createUpdaterScript generates valid .bat with path-safe quoting + stale .old cleanup. checkForUpdate gates correctly: skips non-portable, enforces dev opt-in (AC27_UPDATE_DEV_CHECK / AC27_UPDATE_TARGET), reaches HEAD when past gates. resolveTargetExe resolves correctly for all modes. installUpdate defaults to dry-run in dev mode. |
| Map Window hooks | `useSvgZoom` zoom/pan bounded correctly, imperative API functions. `useUdpAircraftState` lifecycle clean. |
| Map Window components | Loading/error states render correctly. Aircraft filtering logic (airborne, stand proximity, airport match). v4 active-runway variant filtering. Click-to-select sends correct UDP command. Toggle buttons toggle state. |
| Voice parsers | Spoken numbers → digits correct for EN (individual, teens, tens, triple/double shorthand) and ZH (幺/洞/两 variants). Callsign extraction matches airline name→ICAO + number against live aircraft. Command matching: exact aliases hit with score 1.0, fuzzy partial-word overlap recovers unmatched phrases, ZH aliases match character-for-character. |

### Known Vitest failures (none)

All 2086 Vitest tests pass (109 files; verified). The former `scenery_delete_cascade.test.js` timeout flake (~3.4s of repeated full re-tokenization vs the 5s default vitest timeout) is resolved by the global `testTimeout: 30000` in `vitest.config.js` — the suite now passes under parallel workers AND under coverage instrumentation. The previously failing/todo items have been fixed:

1. **BepInExInstallOverlay — escape key closes error overlay**: Fixed by dispatching `keyDown` on `document.body` instead of `document` (capture-phase listener was never triggered when dispatching directly on document). The dispatch + assertion now also run inside `waitFor`, because the `Escape` listener is attached by an effect that depends on `error` and under full parallel load the passive effect could land a tick after the error text rendered — the old single synchronous dispatch was a flake that only failed in the complete suite (verified stable across repeated full runs).

2. **AirMapWindow — renders route polylines when paths are provided**: Fixed by adding `_runwayList: ['19']` to the mock data so the component's runway filter doesn't suppress all STAR variants.

3. **downloadZip — tested indirectly via installLatest (todo)**: Replaced the empty skeleton test and `it.todo` with 5 proper direct tests (happy path + file flush fix, incremental progress, HTTP 404, network error, timeout). The production `file.end()` callback was also added to wait for the write stream flush before resolving the promise.

---

## Layer 2 — Playwright E2E Tests (18 tests, 16 pass, 2 skipped)

Launches the real Electron app against a temp copy of real game data (via `E2E_GAME_ROOT` env var set by `run-all.mjs`). File isolation is guaranteed — the real game installation is never touched. The 18 tests = the browser/editor specs below + S1b (24-level integrity) + S1 + the two fuzz specs (gated). The only skips are the two fuzz specs (`FUZZ_RUN` not set); `E12a` runs for real (it no longer skips — see below).

### `npm run test:e2e` — requires `npm run build` first, Playwright + Electron capable environment

⚠ **Known limitation**: The E2E suite requires an interactive display (X11/Wayland/Windows desktop) for Electron to render. In headless/CI environments without a display server, the first test (B1 — airport list) fails with a worker teardown timeout. Run locally on a desktop machine.

⚠ **Known open failures**: none. The three formerly-red gated-fuzz items are fixed — Ground Painter can synthesize a runway on real v5 levels (type sampling resolves from the per-scope blobdoc type table and omits the optional `IsActive`); save fuzz `KJFK_peakarrival` re-declares a stripped `FlightPlanArrivalLeg` type (`_bdTnOrAlloc`); `KJFK_runwaychange` no-change save is unblocked by the 10-min inactive-runway transition grace. Two latent bugs surfaced while re-running the ground fuzz are fixed: renamed runways dropped by the dangling-threshold gate left orphan `flags=4` pavement strips (`_cancelRunwayRegistryForDrops`), and the runway-delete orphan GC spliced duplicate candidate node indices (thresholds are also pavement-strip endpoints) — double-splicing collapsed a segment to a zero-length self-loop that `_validateNoDegenerateEdges` refused. `doOrphanGC` now dedups its orphan set (UI + MCP paths) and the writer drops any NEW self-loop segment as a safety net. Three more fuzz-discovered classes are fixed: `encodeV2Archive` now re-encodes each decodable v2 checkpoint frame from its edited decoded text, so save-pipeline runtime-entity/`$fstrref` edits persist (`resolution-missing-leg` is enforced again in `F1`, previously filtered); a scenery save prunes dead `InitialRunways`/runway-change names from the embedded `RunwayTimeline` (`_pruneRunwayTimelineReferences`, the `ZSJN_leisure_2` NRE); and a deleted stand's stale `taxi-navigation` points (`RelatedStand` names a missing stand while `Reference` is live) are cascaded by `_cascadeOrphanEntries`.

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
| **E12a** | Help button | Click "Help" (label "Help"/"帮助"; the tooltip is bound, so the old `title="Help"` selector was wrong) → tutorial overlay appears; Escape closes it |
| **E12d** | Back button (no changes) | Click Back → returns to Browser screen without unsaved-changes modal |

### Save Integrity — single file (1 test, fixture-based)

| ID | Test | Expected |
|----|------|----------|
| **S1** | No-change save round-trip | Open level → Ctrl+S (no edits) → compare `.acl` vs `.acl.bak`: v4 has no GUIDs to regenerate (0 pre-save), `$id`s shift, flight data identical (32 flights, 24 weather, 4 wind) |

### Save Integrity — all 24 production files (E2E, requires `E2E_GAME_ROOT`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **S1b** | `save-integrity-all-e2e.spec.mjs` | 24 production files across ZSJN + KJFK + ZGSZ + KDCA | 24 passed (`KJFK_runwaychange` included — the 10-min inactive-runway transition grace in `runTripleValidation` unblocked its no-change save); coverage guard: 24/24 staged prod files exercised |

```bash
# Run standalone (requires E2E_GAME_ROOT env var):
$env:E2E_GAME_ROOT = "<game-root>"
npx playwright test --config=playwright.config.mjs tests/e2e/save-integrity-all-e2e.spec.mjs
```

Iterates every level row in the browser: open → disable time validation → Ctrl+S → confirm → run checker → go back → repeat. Takes ~6 minutes for 24 files. The list is derived directly from `PROD_VISIBLE_BASES` in `src/utils/constants/ui.js` (global-setup stages exactly those files, so it can never drift; a coverage guard fails the run if any staged prod file is not exercised). **Before counting rows the spec expands every collapsed airport card** (`.airport-card[data-expanded="false"] .airport-card-header`) — the browser's one-shot auto-collapse collapses trailing airports on load and a collapsed card conditionally renders no `.level-row`, so without the expansion only the first airport is exercised and the coverage guard reports the rest as `notAttempted`. The spec excludes `.demo.acl` files from the browser list — demo coverage lives in the Node save-integrity and jetway-rebuild layers instead:

| File | Status | Note |
|------|--------|------|
| ZSJN_leisure_1 | ✓ | all state identical |
| ZSJN_leisure_2 | ✓ | all state identical |
| ZSJN_peakdeparture | ✓ | all state identical |
| ZSJN_runwaychange | ✓ | all state identical |
| ZSJN_taixwayclosed | ✓ | all state identical |
| KJFK_leisure_1 | ✓ | all state identical |
| KJFK_leisure_2 | ✓ | all state identical |
| KJFK_runwaychange | ✓ | all state identical — unblocked by the 10-min inactive-runway transition grace in `runTripleValidation` (was skipped) |
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
| ZSJN_surfaceradarinvisible | ✓ | all state identical |
| KJFK_surfaceradarinvisible | ✓ | all state identical |
| KDCA_surfaceradarinvisible | ✓ | all state identical |
| ZGSZ_surfaceradarinvisible | ✓ | all state identical |

The 24 files are exactly `PROD_VISIBLE_BASES`. `ZGSZ_Endless.acl` is deliberately **not** listed there: it is a flightless scenery level (`flight_schedule_endless.csv` is header-only), so the browser renders no row and it cannot go through a save-integrity round-trip. The spec derives its expected list from the same `PROD_VISIBLE_BASES` constant global-setup stages from and fails if any staged prod file is not exercised.

### Fuzz Save — randomized flight edit storm + real SAVE (E2E, requires `E2E_GAME_ROOT` + `FUZZ_RUN=1`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **F1** | `fuzz-save.spec.mjs` | All 24 production files (or `FUZZ_ACL_FILES` subset) | `.acl.bak` created per file, saved file reloads with matching flights. `KJFK_peakarrival` passes — a stripped `FlightPlanArrivalLeg` blobdoc type is re-declared by `_bdTnOrAlloc` (was: `not in bdTypeMap`); the harness `storeSnap` stale-snapshot bug is fixed; v2 checkpoint-frame edits persist (`encodeV2Archive` re-encodes each decodable frame), so `resolution-missing-leg` is enforced (its filter was removed), and the level's `flight_schedule_<level>.csv` is propagated into the sandbox alongside the `.acl`. The level open step expands every auto-collapsed airport card first (a collapsed card renders no `.level-row` — same handling as the S1 suite) |

### Fuzz Ground+Air Save — randomized Ground/Air Painter edit storm + real SAVE (E2E, requires `E2E_GAME_ROOT` + `FUZZ_RUN=1`)

| ID | Spec | Coverage | Expected |
|----|------|----------|----------|
| **F2** | `fuzz-ground-save.spec.mjs` | All 24 production files (or `FUZZ_ACL_FILES` subset) | `.acl.bak` created per file, saved scenery + flight reconciliation verified. Real v5 runway synthesis now encodes (per-scope type sampling + optional `IsActive`); renamed runways dropped by the dangling-threshold gate no longer leave orphan `flags=4` pavement strips (`_cancelRunwayRegistryForDrops`); the runway-delete orphan GC no longer double-splices duplicate threshold/strip node indices (self-loop refusal), and the writer drops any NEW self-loop segment as a safety net; a deleted stand's stale `taxi-navigation`/`RelatedStand` points are cascaded, and the embedded `RunwayTimeline` is pruned of dead `InitialRunways`/change-frame names. The `.gp-error` refusal path returns the summary shape (no more faceless `undefined` target). Slow saves on large levels are tolerated (extended observe loop, long confirm-click timeout, Back click retries after a modal re-sweep) |

Drives the Ground Painter the same way `F1` drives flights: opens each level, opens the Ground Painter, applies **50–200 randomized ops per level** through the MCP Ground/Air Painter API split **2/3 ground / 1/3 air** (e.g. 200 ops → ~133 ground + ~67 air) across **two mode-partitioned phases**, then hits **SAVE through the real Ground Painter UI** (Save → backup confirm → success/warnings) — still in air mode, exercising the mode-independent save path. **Phase 1 (ground mode):** 7% runway (new/move/rename), 7% taxiway new, 25% taxiway mod (move whole/move endpoint/rename), 25% fillet (half connect a new taxiway onto a runway `Flags=4` strip then fillet that junction), 12% area (new/move/move-vertex), 6% stand (new/move/rename), 18% select+delete (single/multi/selectAll move + delete). **Mode swap:** the real toolbar air/ground toggle (`[data-testid="air-ground-toggle"]`, `set_ground_painter_mode` MCP fallback) is clicked and the run asserts `get_ground_painter_state().mode === 'air'`. **Phase 2 (air mode, air bounds), 30% node-related / 70% procedure-related:** node-related — 16% `create_airway_nodes`, 6% `move_airway_objects` (node target), 5% `rename_airway_object(kind='airwayNode')`, 3% `delete_airway_objects` (node target); procedure-related — 30% `create_airway_procedures`, 18% `create_airway_fillet` (intra-procedure AAA, radius 50..500 GU, MCP auto-picks the sharpest corner), 8% `move_airway_objects` (procedure-body target), 7% `rename_airway_object(kind='procedure')`, 7% `delete_airway_objects` (procedure-body target). Ground coordinates come from the live graph extents (5% padding); air coordinates from the authored airway-node extents (or a wide box around the ground center when the level has no fixes). Runway names are suffix-deduped and always satisfy the save-time validation. Post-save, the airside is gated: no non-finite airway node, every procedure has ≥2 distinct in-range fixes, no NEW consecutive duplicate fixes, and the save never adds air objects.

**Post-save flight reconciliation** is verified against the file (not the store — demo-classified basenames like `ZSJN_leisure_1.acl` ship as prod but the editor filters the store to the CDT demo window): flights whose stand/runway was deleted are purged, renamed references are remapped, and the saved file must never keep an unresolved reference, add a flight, or drop one whose reference still resolves. Game-load gates are also checked: no bowtie area polygons (Triangulator), no duplicate runway `$k` ("found 0 named runways"), no pavement strips orphaned from a deleted runway.

```bash
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz:ground                                   # all 24 production levels
$env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl"; npm run test:fuzz:ground # subset
$env:FUZZ_SEED = "12345"; npm run test:fuzz:ground         # reproduce deterministically
npm run test:fuzz:ground -- --replace                      # copy PASSED .acl + .acl.bak (+ .bg.json/.csv) into the real game install
# E2E_KEEP_TMP=1 preserves tests/tmp-e2e for post-mortem (decode with tests/tmp-decode/decode.mjs)
```

The fuzz test drives the editor the same way an AI agent would: it opens each level in
the real Electron app, then applies **50–200 randomized operations per level** through the
editor's built-in **MCP API** (`127.0.0.1:31415`, the same `tools/call` JSON-RPC protocol
`mcp/bridge.js` speaks), and finally hits **SAVE through the real UI** (Ctrl+S → backup
confirmation modal with backup checked → success modal).

**Randomized operations** (seeded, reproducible via `FUZZ_SEED`):

| Operation | MCP / store path | Randomized values |
|-----------|------------------|-------------------|
| Add flight | `create_flights` | airline, flight number, aircraft (any profiled type, airline-independent), runway, stand, STAR (runway-compat), registration (pair-compat), voice/language, ARR/DEP with in-range times |
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
# All 24 production levels (default):
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
| `test_api_server.js` | 133 | All 7 HTTP endpoints (status, airport/values, flights, create-batch, modify-batch, delete-batch, validation) + MCP protocol (initialize, tools/list, 7 tools/call) + 13-point validation suite (airline, flight number, stand, runway, STAR compat, registration pair, time bounds, time order, duplicate callsigns, stand conflicts, duplicate registrations, **runway inactive at landing** via chronological `initialRunways` + `timeline` active-set sweep; aircraft type is airline-independent) + cascade logic + AND-match regression tests. Mock Electron window — no real app needed. | 133/133 pass |
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
| `test_udp_listener.js` | 21 | Binary protocol parsing (40B header + N×112B records, little-endian), aircraft state tracking, trail ring buffer (600-tick gap, max 5), empty packets, bad magic rejection, flight direction 0/1, callsign trimming, reset/clear, simTimeUnixMs tracking, airport transition auto-reset, simFlags/heartbeatSeq v2 header, hasLevel transition logic, `getUdpAircraftState().connected` true right after a packet and false once the socket is stopped | 21/21 pass (skips when port 20266 in use) |
| `test_type_number_integrity.js` | 6 | Save→reload type number stability: runs the full `_rebuildStaticDataSections` save (`generateFullAcl`, approach cache passed — same as the app) on the v4 fixture, then verifies every `$type` declaration in the output matches the `.bak` snapshot — catches type-number shift regressions (6 checks, 0 type mismatches). | 6/6 pass |
| `test_jetway_rebuild.js` | v4 files | Constructive jetway rebuild round-trip: runs `_rebuildJetwayEntries`, verifies only jetway entries in RuntimeEntities are modified (other entries preserved byte-identical). Runnable offline against the v4 fixture (`--acl tests/fixtures/.../ZSJN_leisure_1.acl`). **Departed-stand rule**: a departure whose OffBlockTime ≤ the segment's snapshot time (`GameTime.CurrentDateTime`) is treated as already departed → empty jetway, matching the game's own entries (the 7/30/26 playtest update produces checkpoints taken after some off-block times); an unresolvable spec (no cache + empty original entry) falls back to an empty jetway instead of throwing. | 16/16 pass on the v4 game root (`--prod-demo --no-cache`); 1/1 fixture |

```bash
node tests/integration/test_udp_listener.js
node --require ./tests/integration/preload.cjs tests/integration/test_type_number_integrity.js --root <game-root>
```

### v4 GATCArc binary format tests (no game root needed)

| File | Tests | What it validates | Expected |
|------|-------|-------------------|----------|
| `test_gatcarc_roundtrip.js` | varies × all .acl files | GATCArc4 binary round-trip: `parseArchive` validates magic/SHA-256/commit markers; `decodeArchive(bin)` → `encodeArchive(text)` → `decodeArchive` is byte-identical. For text files: `encodeTextToPayload`/`decodePayloadToText` round-trip reproduces game-written text. Type reference form (full `"N\|Name"` vs bare `N`) is normalized before comparison. Runs against every .acl in the game airports directory (KDCA 9, KJFK 10, ZGSZ 8, ZSJN 13). | 120/120 pass (40 files × 3 checks each) |
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
| `test_save_integrity_all.js` | 27 (`--prod-demo`) or 28+ (`--all`) | Full save→reload→compare on every .acl file. Validates: flights (14 fields × N), config (startTime/endTime/scheduleFile), scenery maps (runway/stand counts), embedded timelines (weather/wind/runway), source format, text-level `_departureTakeoffTime` / `_arrivalInBlockTime` zero validation. Builds the approach cache per level dir (jetway DockingPositions lookup needs it, same as the app) | 27/27 pass on the v4 game root (24 prod + 3 demo): 0 field diffs, config identical, scenery identical, timelines identical |

```bash
# 24 production + 3 demo files (ZSJN/KJFK/ZGSZ/KDCA):
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

**Production (24 prod levels across ZSJN/KJFK/ZGSZ/KDCA)** — with `--prod-demo` the runner tests 27 files (24 prod + 3 demo).

**Demo (3 .demo files + 1 shared):** KJFK_leisure_1.demo, KJFK_peakarrival.demo, ZSJN_leisure_1 (shared with prod), ZSJN_peakdeparture.demo

---

## Master Test Runner

```bash
npm run test:all      # or: node tests/run-all.mjs [--game-root <path>]
```

Runs all three layers sequentially (Vitest → save integrity 27 files → jetway rebuild 27 v4 files → v4 runway pair extraction → build → Playwright E2E) and reports a pass/fail summary. Default game root: `D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest`.

---

## v4 Format Coverage

All supported .acl files use the **v4 GATCArc4 binary** format (StaticData.$blobdoc; flight plans are StaticItems dictionary entries keyed `"$k": "flight-plan:<REG>"`, referenced by `$fstrref` tokens). v2/v3 text-format support has been removed from the code and tests.

- **Save integrity**: 27/27 files pass (24 production + 3 demo) — flights, config, scenery, timelines all match after save→reload through `generateFullAcl` (`_rebuildStaticDataSections`).
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

1. **`global-setup.mjs`**: copies 27 prod+demo files from real game → `tmp-e2e/`, writes `lastRoot.json`
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
| `integration/test_save_integrity_all.js` | Save→reload→compare on all .acl files (supports `--prod-demo` for 27 specific files) |
| `integration/test_jetway_rebuild.js` | Constructive jetway rebuild — verifies `_buildActiveJetwayEntry` only-modifies-jetway invariant across 27 v4 prod+demo files |
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

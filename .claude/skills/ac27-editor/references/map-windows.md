# AC27 Map Windows

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [IPC Handlers](#ipc-handlers-main--renderer)
- [Preload API](#preload-api-windowelectronapi-additions)
- [GroundMapWindow](#groundmapwindow-srccomponentsmapwindowsgroundmapwindowjsx)
- [AirMapWindow](#airmapwindow-srccomponentsmapwindowsairmapwindowjsx)
- [FlightStripsWindow](#flightstripswindow-srccomponentsmapwindowsflightstripswindowjsx)
- [Patch Command Composer](#patch-command-composer-flightpatchcommandbarjsx--live)
- [Shared Hooks](#shared-hooks)
- [BrowserScreen Integration](#browserscreen-integration)
- [Zustand Store Additions](#zustand-store-additions-appstorejs)
- [Map Window i18n Keys](#map-window-i18n-keys)
- [New Constants](#new-constants)

## Architecture Overview

Map windows are separate Electron `BrowserWindow` instances (one per airport ICAO + type pair), NOT React components rendered in the main window. They provide real-time radar visualization of aircraft positions streamed via UDP telemetry from the running game, plus flight strip progress boards.

- `electron/main.js` manages three `Map` instances:
  - `groundMapWindows` — keyed by airport ICAO, holds `BrowserWindow` for Surface Radar
  - `airMapWindows` — keyed by airport ICAO, holds `BrowserWindow` for Approach Radar
  - `flightStripsWindows` — keyed by airport ICAO, holds `BrowserWindow` for Flight Strips
- Each map window loads the same Vite SPA with query params:
  - `?window=groundMap&airport=XXXX&root=...` → renders `<GroundMapWindow>`
  - `?window=airMap&airport=XXXX&root=...` → renders `<AirMapWindow>`
  - `?window=flightStrips&airport=XXXX&root=...` → renders `<FlightStripsWindow>`
- `App.jsx` checks `URLSearchParams` **before** the normal screen router
- On window `closed`, the main process deletes the entry from its Map and sends `radar-window-closed` to the main window so the UI can update its toggle state

## IPC Handlers (main → renderer)

| Channel | Args | Direction | Purpose |
|---------|------|-----------|---------|
| `open-ground-map` | `(airportIcao, gameRoot)` | invoke | Creates/focuses Surface Radar BrowserWindow |
| `open-air-map` | `(airportIcao, gameRoot)` | invoke | Creates/focuses Approach Radar BrowserWindow |
| `open-flight-strips` | `(airportIcao, gameRoot)` | invoke | Creates/focuses Flight Strips BrowserWindow |
| `close-ground-map` | `(airportIcao)` | invoke | Closes Surface Radar window |
| `close-air-map` | `(airportIcao)` | invoke | Closes Approach Radar window |
| `close-flight-strips` | `(airportIcao)` | invoke | Closes Flight Strips window |
| `get-flight-strip-data` | `(airportIcao, gameRoot)` | invoke | Scans ACL files for callsign→registration/airport/squawk mappings |
| `radar-window-closed` | `{ icao, type }` | main→renderer | Notifies main window that user closed a map window (X button) |
| `select-aircraft-in-map` | `(airportIcao, callSign)` | invoke | Sets selected aircraft, sends UDP SelectAircraft command, broadcasts to all map windows for that airport |
| `get-selected-aircraft` | `(airportIcao)` | invoke | Returns currently selected callSign for an airport (or null) |
| `aircraft-selected-in-map` | `{ icao, callSign }` | main→renderer (push) | Broadcasts selection change to ALL map windows (ground + air + strips) for the same airport |
| `reset-udp-aircraft` | none | invoke | Clears all UDP aircraft state (used by map refresh button) |
| `send-udp-command` | `(commandId, payloadB64)` | invoke | Sends fire-and-forget UDP command to game on port 20267 |
| `debug-log` | `(args[])` | invoke | Logs renderer messages to main process terminal (debug only) |
| `udp-aircraft-state` | `state` | main→renderer (push) | Live aircraft state pushed every 200ms to all open map windows |
| `set-emergency-aircraft` | `(airportIcao, callSign)` | invoke | Sets/clears emergency aircraft, broadcasts to all map windows |
| `get-emergency-aircraft` | `(airportIcao)` | invoke | Returns current emergency callSign for an airport (or null) |
| `emergency-aircraft-changed` | `{ icao, callSign }` | main→renderer (push) | Broadcasts EM change to ALL map windows (ground + air + strips) |

## Preload API (`window.electronAPI` additions)

```js
// Map window launchers
openGroundMap(airportIcao, gameRoot)    // → ipcRenderer.invoke('open-ground-map', ...)
openAirMap(airportIcao, gameRoot)       // → ipcRenderer.invoke('open-air-map', ...)
closeGroundMap(airportIcao)             // → ipcRenderer.invoke('close-ground-map', ...)
closeAirMap(airportIcao)                // → ipcRenderer.invoke('close-air-map', ...)
openFlightStrips(airportIcao, gameRoot)  // → ipcRenderer.invoke('open-flight-strips', ...)
closeFlightStrips(airportIcao)          // → ipcRenderer.invoke('close-flight-strips', ...)
getFlightStripData(airportIcao, gameRoot) // → ipcRenderer.invoke('get-flight-strip-data', ...)
onRadarWindowClosed(cb)                 // → ipcRenderer.on('radar-window-closed', handler)

// Linked aircraft selection (synced across ground + air map for same airport)
selectAircraftInMap(airportIcao, callSign)  // → ipcRenderer.invoke('select-aircraft-in-map', ...)
getSelectedAircraft(airportIcao)            // → ipcRenderer.invoke('get-selected-aircraft', ...)
onAircraftSelectedInMap(cb)                 // → ipcRenderer.on('aircraft-selected-in-map', handler)
offAircraftSelectedInMap(cb)                // → ipcRenderer.removeListener(...)

// Emergency aircraft (EM label → squawk 7700)
setEmergencyAircraft(airportIcao, callSign) // → ipcRenderer.invoke('set-emergency-aircraft', ...)
getEmergencyAircraft(airportIcao)           // → ipcRenderer.invoke('get-emergency-aircraft', ...)
onEmergencyAircraftChanged(cb)              // → ipcRenderer.on('emergency-aircraft-changed', handler)
offEmergencyAircraftChanged(cb)             // → ipcRenderer.removeListener(...)

// UDP telemetry
getUdpStatus()                          // → { connected, lastPacketTime, currentAirport, simFlags, heartbeatSeq }
getUdpAircraftState()                   // → { aircraft, currentAirport, recordCount, simTimeUnixMs, simFlags, timeScale }
resetUdpAircraft()                      // → clears all aircraft state (map refresh button); also resets lastHasLevel
sendUdpCommand(commandId, callSign)     // → base64-encodes 12B callSign, invokes 'send-udp-command'
debugLog(...args)                       // → ipcRenderer.invoke('debug-log', args) — logs to main terminal
onUdpAircraftState(cb)                  // subscribe to live ~10 Hz pushes
offUdpAircraftState(cb)                 // unsubscribe (must be SAME function reference)
onCacheBuildProgress(cb)                // subscribe to cache build progress: cb({ current: number, total: number })
offCacheBuildProgress(cb)               // unsubscribe (must be SAME function reference)
```

## GroundMapWindow (`src/components/MapWindows/GroundMapWindow.jsx`)

**Purpose:** SVG surface radar for tracking aircraft movement on the ground at a specific airport.

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan), push-button toggles (parked aircraft, taxiway labels, refresh), and a **help button** (`?` icon). All controls (except the help/witch button) have on-hover portal tooltips sourced from the map help page i18n content, gated by `MAP_TOOLTIPS_ENABLED`. Sim-time clock displayed in top-left corner.

**Data sources:**
- `_taxiwayPaths` — taxiway centerline polylines from approach cache (via `electronAPI.collectValues()`)
- `_runwayData` — runway rectangles (threshold pairs + width) computed in `collect-values` IPC
- `_standPositions` — stand midpoints from approach cache (via `electronAPI.collectValues()`)
- `_areaData` — area polygons by AreaType (0=airport boundary, 1=stand/apron, 2=building) from approach cache
- `useUdpAircraftState()` — live aircraft positions + `simTimeUnixMs` from UDP telemetry
- `GROUND_MAP_CENTER_OFFSET` — per-airport viewBox center offset (game units)

**Rendering layers:**
1. Radar-blue background (`#0a1628`). Witch mode: `witch/groundradar.png` image stretched to viewBox, background color `#24150a`.
2. Taxiway centerlines — uniform grey (`#444`) polylines. Segments touching stand-position nodes are marked `isStandAccess: true` and rendered with square linecap + configurable width multiplier (`GROUND_MAP_STAND_ACCESS_WIDTH_MULT`). Stand-access segments are no longer excluded — they render alongside main taxiways for differentiated styling. **Runway-named taxiway segments** (name matches a runway in `runwayData`) are excluded from this layer — they render as runway-style polygons instead (see layer 4b).
3. Area polygons — semi-transparent fills by AreaType: blue boundary, grey apron, black buildings. Default stroke color `#444` (matches taxiways). Parsed from `SceneryData.Areas` via `_parseAreas()`.
4. Runway rectangles — black filled polygons from threshold endpoints + width
5. **Runway-named taxiway segments** — taxiway centerlines whose name matches a runway entry are rendered as black filled polygons (same style as runways), using `computeRunwayCorners()` with the matching runway's width. These represent runway surfaces stored as taxiway centerline segments.
6. Taxiway labels — name labels at path midpoints with proximity dedup (`GROUND_MAP_TAXIWAY_LABEL_SPACING`). Placed **above** runways in layer order. Only rendered for non-runway taxiway segments.
7. Live ground aircraft — filtered to `position.y <= 1.0` (ground-level, not airborne) with inactive aircraft hidden by default:
   - **Inactivity filter:** Aircraft are hidden when parked — determined by `controlSeat` (UDP v2 record field at offset 21). If `controlSeat` is None (0) or Unknown (255), the aircraft has no active controller → parked/hidden. If `controlSeat` is 1-7 (Ramp/Ground/Tower/Departure/Approach/Delivery/Apron), the aircraft is under active control → always shown, even when at a stand. As a fallback (pre-v2 UDP data without `controlSeat`), aircraft at a known stand within `GROUND_RADAR_STAND_PROXIMITY` (0.5 GU ≈ 50m) are hidden.
   - **"Parked" toggle:** Push-button (i18n: `ground_map_show_all`) bypasses the inactivity filter, showing all ground-level aircraft
   - **Icon:** `MAP_ICON_PATH` (IonIons IoAirplane SVG path) rotated by `noseDirection.x/z`
   - **Label:** Green callsign text with a short connector line from aircraft to label
   - **Selection highlight:** Yellow icon + label when aircraft is selected (click-to-select)
   - **Witch mode:** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). **Sprite assignment is centralized in the main process:** `witchSpriteMap` (Map<callSign, spriteIndex>) assigns each callsign a stable 0–14 index round-robin. The `spriteIdx` is injected into each aircraft object during the 200ms UDP push (`electron/main.js`), guaranteeing all windows show the same character. `witchMode.js` accepts `spriteIdx` as a parameter to `getSpriteSheet()`; without it (standalone/testing), falls back to a deterministic djb2 hash of the callsign. Moving: walk sprites (direction-aware via `witchDirection()`); parked/stopped: stand sprites (`isParked()` uses `controlSeat` — None (0) or Unknown (255) = parked; any active seat (1-7) = not parked). Airport boundary (AreaType 0) is hidden. Any click exits witch mode. Labels and connector lines hidden. Background replaced with `witch/groundradar.png`, sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Airport transition auto-reset:** When `udpAirportChanged` is true and the new airport matches this window's ICAO, calls `electronAPI.resetUdpAircraft()` to clear stale aircraft from the previous airport.

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `GROUND_MAP_DEFAULT_ZOOM` + `GROUND_MAP_CENTER_OFFSET`, pan clamped to initial bounds.

**Click-to-select:** Calls `electronAPI.selectAircraftInMap(airportIcao, callSign)` — centralized IPC handler that stores selection in main process, sends `SelectAircraft` UDP command, and broadcasts the change to all map windows for the same airport (ground + air). On mount, fetches current selection via `getSelectedAircraft` so a newly-opened map window inherits any existing selection. Background click deselects via `selectAircraftInMap(airportIcao, null)`. The selected callSign is rendered with yellow highlight.

## AirMapWindow (`src/components/MapWindows/AirMapWindow.jsx`)

**Purpose:** SVG approach radar for tracking airborne aircraft and visualizing STAR/SID/APPR/missed-approach routes with range rings, runway extensions, and border overlay.

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan, airspace with gauge indicators), push-button toggles (STAR, SID, APPR, Labels, ILS, Map, Refresh), and a **help button** (`?` icon). All controls (except the help/witch button) have on-hover portal tooltips sourced from the map help page i18n content, gated by `MAP_TOOLTIPS_ENABLED`. The left `RunwaySidebar` (Waypoints above ARR, DEP, per-runway toggles) also has tooltips. Sim-time clock in top-left corner.

**Data sources:**
- `_starPaths` (STAR routes, Type=0) — rendered in grey; trimmed at APPR overlap points
- `_sidPaths` (SID departure routes, Type=2) — rendered in grey
- `_missedAppPaths` (Missed Approach routes, Type=3) — rendered in grey
- `_apprPaths` (RNAV approach routes, Type=1) — rendered in grey; points used to trim STAR display
- `_runwayThresholds` from approach cache — for threshold lines and runway extensions
- `_airwayNodes` from approach cache (`airwayNodes` in `buildApproachCache`: `{pk, name, osmId, x, z}` per `airway-node` PK entity) — fixes/waypoints layer. **Only ICAO-style fixes survive extraction**: the node's `Name` must match `/^[A-Z]{3,5}$/` (all-uppercase 3-5 letters). Turn points (`TurnPoint19`, `TP19W1`), numbered nodes (`JN210`), and unnamed nodes are filtered out at the source — the cache never contains them.
- `useUdpAircraftState()` — live aircraft positions + `simTimeUnixMs`
- `AIR_MAP_BG_OFFSETS` from `src/utils/constants.js` — per-airport background image config
- `AIR_MAP_DEFAULT_ZOOM` from `src/utils/constants.js` — per-airport initial zoom scale
- `NM_TO_GU` from `src/utils/constants.js` — nautical mile to game-units conversion (18.52)

**Rendering layers (bottom to top):**
1. Background map image (toggleable): `/{ICAO}.png` positioned via `bgCfg`, opacity 20%. Background color via CSS custom property `--air-map-bg`. Witch mode (see below) uses `witch/{ICAO}.png` at full opacity with independent `WITCH_MAP_BG_OFFSETS` positioning.
2. Range rings (airspace knob, 12 levels from 10–120 NM gap): centered on geometric mean of all runway thresholds, radius labels when route labels enabled.
3. SID / STAR / APPR routes — each independently toggleable, grey (`#888888`) at 50% opacity. Additionally filtered by the active runway set from the left `RunwaySidebar`: only paths whose procedure-runway mapping includes at least one active runway are rendered. STAR paths are trimmed at APPR overlap points so each category shows its unique portion.
4. Route name labels (toggleable + per-category): positioned with vertical spreading to avoid overlaps. STAR/APPR labels at path **start** (arrival entry points); SID labels at path **end** (departure fixes) to keep them clustered near the map edges rather than fanning out from the runway.
5. Runway extension lines (toggleable): 1–20 NM dashed white lines from each threshold with tick marks at 5/10/15/20 NM.
6. Runway thresholds — runway-width lines connecting threshold pairs.
7. Fixes/waypoints (toggleable via **Waypoints**, in the left `RunwaySidebar` above ARR) — white X symbols (two crossing strokes, `#ffffff`, opacity 0.7, width `max(1, fixRadius×0.4)`) at every `airway-node` position. Name labels shown when the **Labels** toggle is on (same toggle as route-name labels; `showRouteLabels`). **Not filtered by the runway selector** — unlike routes, fixes render from unfiltered `airwayNodes` and never pass `filterByRunway`.
8. Border overlay — independent SVG with white border rect and 10° tick marks with degree labels. Tick/label sizes scale inversely to container width via `ResizeObserver` (baseline 800px) so they stay fixed in pixels when the window resizes.
9. Live airborne aircraft — filtered to `position.y > 1.0`:
   - **Direction-based coloring:** Outbound aircraft (`flightDirection === 0`) render with green labels/indicators (`#66ff66`); inbound aircraft (`flightDirection === 1`) use white. Dots remain `#1a4a8a` blue for all. Selected aircraft always get yellow highlights.
   - **Circle:** Small colored circle at aircraft position (unselected) or yellow (selected)
   - **Trail dots:** Ring buffer of historical positions (max 5 snapshots, minimum 600-tick gap), rendered as shrinking circles with decreasing opacity
   - **Heading line:** For selected aircraft only, projects nose direction forward 12× planeScale
   - **Label:** By default, Tower aircraft and selected aircraft show full label (callsign + altitude + speed/type); other aircraft show altitude only. The ARR/DEP toggles on the left RunwaySidebar override this — when active, all aircraft of that direction show the full label. Speed/type toggles every 5 seconds between airspeed/10 and aircraft type. Dynamically positioned via anti-overlap layout (4 candidate positions: right/top/left/bottom). Emergency aircraft show a red "EM" label — above the callsign in full-label mode, above the altitude in altitude-only mode.
   - **A/D indicator:** "A" or "D" text next to the current position dot
   - **Witch mode:** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame fly sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). Characters assigned round-robin (centralized in main process via `spriteIdx`, see GroundMapWindow witch mode docs), stable per callsign. Direction-aware via `witchDirection()` (dominant axis of nose vector). Any click exits witch mode. Labels, connectors, and heading lines hidden. Map background switches to `witch/{ICAO}.png` at full opacity with `WITCH_MAP_BG_OFFSETS`, background color `#160900`. Sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Airspace knob:** `SpinKnob` passed via `airspaceKnob` prop to `ControlSidebar` — controls range ring density (0=10NM gap … 11=120NM gap, default 40NM). Double-click knob to reset to default.

**Emergency call sign:** Refresh button (double-click) randomly picks an active aircraft and marks it with a red "EM" label. Single click resets UDP aircraft state. EM state is synced across all map windows via `emergencyCallSigns` Map in the main process (`set-emergency-aircraft` / `get-emergency-aircraft` IPC handlers, `emergency-aircraft-changed` push event). Flight strips override the squawk to **7700** for the EM aircraft. Airport transitions clear the EM state.

**Airport transition auto-reset:** When `udpAirportChanged` is true and the new airport matches this window's ICAO, calls `electronAPI.resetUdpAircraft()` to clear stale aircraft from the previous airport.

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `AIR_MAP_DEFAULT_ZOOM`, pan clamped to initial bounds. Spin knobs show gauge positions derived from current zoom/pan relative to initial viewBox.

**RunwaySidebar:** Vertical bar on left (60px black). **Top section:** ARR/DEP label toggle buttons (default off) — when active, all aircraft of that direction show full labels (callsign + altitude + type) instead of just altitude. **Bottom section:** one RWY-prefixed toggle per runway, stacked from bottom. Both sections reuse `.air-map-toggle` classes for witch mode sprites. Only runways with resolved path data appear. Each runway and the ARR/DEP buttons get dynamic entries in the help overlay.

**Click-to-select:** Same centralized `electronAPI.selectAircraftInMap(airportIcao, callSign)` pattern as GroundMapWindow. Selection syncs across both map windows for the same airport.

**Help overlay:** A `?` button in the control sidebar opens a context-sensitive `MapHelpOverlay` (type `"air"` or `"ground"`) that documents all knobs, toggle buttons, and interactions with interactive inline button visuals. Closes on Escape key or background click.

## FlightStripsWindow (`src/components/MapWindows/FlightStripsWindow.jsx`)

**Purpose:** Live flight progress strips organized by controller seat (RAMP, GROUND, TOWER, DEPARTURE, APPROACH, DELIVERY, APRON), with drag-to-reorder and cross-window selection sync.

**Layout:** Horizontal row of columns with a bottom bar: sim clock + game speed multiplier (×1/×2 from UDP `timeScale`), refresh (portal tooltip from map help i18n, gated by `MAP_TOOLTIPS_ENABLED`), help (no tooltip — doubles as witch-mode toggle). Runway separator bars have solid black (`#000`) background. i18n: strips use hardcoded English only (seat labels, headers, runway separators never translated); help overlay has full i18n.

**Data sources:**
- `useUdpAircraftState()` — live aircraft + `simTimeUnixMs` + `timeScale` + `udpAirportChanged` from UDP
- `electronAPI.getFlightStripData()` — registration/airport/airway/squawk from ACL files
- `electronAPI.onAircraftSelectedInMap()` — cross-window selection sync (broadcast now includes strips)

**Strip layout (5 sections):**
1. **Callsign column** — bordered callsign box + aircraft type + stand label
2. **Procedure column** — STAR/SID procedure + registration + destination/origin airport
3. **Squawk column** — 4-digit squawk code (deterministic hash of callsign, 2000–6000)
4. **Route column** — stacked route history (fills remaining width, flex-column)
5. **Runway column** — runway designator + seat channel box (e.g. "GND", "TWR")

**Arrival vs Departure:** Orange left border + warm background for arrivals; blue for departures.

**Telemetry status styling:**
- `telemetryStatus` from UDP v2 records (offset 23) drives CSS modifier classes:
  - `2` (ActionRequired) → `strip-telemetry-action-required` — muted border via `color-mix(in srgb, var(--orange/blue) 50%, #000)`
  - `3` (HandoffPending) → `strip-telemetry-handoff-pending` — channel box gets `var(--accent)` border + `var(--accent-dim)` background
  - `4` (PendingAtStand) → `strip-telemetry-pending-stand` — same channel box highlight
- Combined with `.strip-selected` for selected aircraft with active telemetry status
- Applied to both the real strip and the drag ghost via `TELEMETRY_STRIP_CLASS` constant

**Route history:**
- `routeHistory` state: `{ callsign: [{ text, struck }] }` — tracks taxiway/airway changes
- `prevRouteRef` stores last-seen route per callsign for change detection
- On route change: all previous lines marked `struck: true` (struck-through CSS), new line appended unstruck
- Max 4 lines per callsign (`slice(-4)`)
- Rendered in `.strip-col-route` as stacked `<span>` elements; struck lines get `.strip-route-struck` (line-through + 45% opacity)

**Selection sync:**
- Click toggles; broadcasts via `select-aircraft-in-map` → `broadcastSelectedAircraft()` sends to ground + air + strips
- Selected strips scale up (1.20×) with solid backdrop (`#2a1a05` arr / `#0a1a2a` dep)
- **Dynamic transform-origin:** `useLayoutEffect` in `FlightStripContent` computes per-strip `transformOrigin` based on viewport edge detection, preventing the 1.20× scaled strip from overflowing the window. Grows away from overflowing edges (e.g., if right edge overflows → `originX = 'right'`).
- `selectedCallSignRef` keeps stable `handleDragEnd` in sync for correct toggle/deselect IPC

**Drag reorder (runway-group constrained):**
- Long-press (400ms) enters drag mode
- **Runway-group constraint:** Drag targets are validated against the source strip's runway group. `runwayRanges` (memoized per seat) maps each runway → `{ start, end }` flat indices. A drop is only valid if `hoverIdx` falls within the source runway's range, at `end+1` (end of group), or at the very end when source is the last group.
- Invalid targets (cross-runway drops) snap back immediately (no animation, selection cleared)
- Valid drops trigger `isDropping` state → drop animation plays → selection cleared on animation end
- **Drop animation:** Double-rAF waits for React re-render with new strip order, then animates ghost from mouse position to the strip's new DOM position. Ghost gets `.strip-dropping` class: `transition: top 0.22s, left 0.22s, transform 0.22s, opacity 0.18s` — scales to 1.0, fades to opacity 0. Falls back to 400ms timeout if `transitionend` doesn't fire. Cleanup: cancels rAF frames, removes class.
- Pixel-level ghost tracking via direct DOM (`ghostRef`) — no React re-render; only `hoverIdx` changes trigger `setDragState`. Drag metadata in `dragMetaRef` (now includes `srcRunway`).
- Ghost only appears after `hasMoved` is true (not during initial long-press). During drop animation (`isDropping`), ghost is hidden.
- Source position: placeholder shown only when `hoverIdx === srcIdx` (still at source). Once dragged away, placeholder collapses to `null` so other strips push up.
- Target gaps: `.strip-gap-above` (46px margin, within same runway group only), `.strip-sep-gap` (46px margin above runway separator when dropping at end of previous group), `.strip-end-gap` (only when source runway is the last group)
- `applyReorder` flattens runway groups, moves item, rebuilds; keys sorted for stable ordering across UDP updates
- Ghost: fully opaque solid background, `will-change: transform, top, left` GPU hint

**Airport transition auto-reset:**
- Listens for `udpAirportChanged` flag from `useUdpAircraftState`
- When transitioning to this window's airport: calls `loadFlightData()` + `resetUdpAircraft()`

**Witch mode:**
- **Activation:** Double-click the help `?` button (300ms timeout between clicks). Single click still opens the help overlay. When exiting witch mode (single click while in witch mode), the help overlay opens.
- **Animation:** 2-frame sprite animation at 500ms per frame via `setInterval` (`witchFrame` toggles 0↔1). Timer is cleaned up on unmount or when witch mode is disabled.
- **Sprite rendering:** Each strip and drag ghost renders an inline `<svg>` (48×48) inside a `.strip-witch-sprite` container (flex, left-aligned, 30px left padding). Same `clipPath` + `<image>` pattern as ground/air maps — loads the assigned sprite sheet, clips to the correct cell, and applies `feDropShadow` glow on selected aircraft only.
- **RPG stats:** In witch mode, each strip and drag ghost displays HP/MP/ATK/DEF stats computed by `computeWitchStats()` — HP from first 2 digits of callsign (if "00" → 100), MP from last 2 digits (if "01" → 1), ATK from `airSpeedKnot / 10`, DEF from `position.y / 0.3048` (altitude in feet). Stats render in a 2×2 CSS Grid (`.strip-witch-stats`) with gold labels (`.witch-stat-label`) and white values (`.witch-stat`). Drag ghosts also show stats.
- **Action selection:** Airborne (`position.y > 1.0`) → `'fly'` sprites; parked on ground (`isParked()` via `controlSeat`) → `'stand'` sprites; otherwise → `'walk'` sprites with direction from `witchDirection(noseDirection)`.
- **Strip theming:** `.flight-strips.witch-mode` class on root enables themed CSS:
  - Window background: `witch/groundradar.png` cover
  - Strip backgrounds: `witch/arrivalstrip.png` / `witch/departurestrip.png` (100% width, no-repeat)
  - All text columns hidden (`.strip-col-callsign`, `.strip-col-proc`, `.strip-col-squawk`, `.strip-col-route`, `.strip-col-runway` → `display: none`)
  - Column headers and runway separators hidden
  - Selected strip: white box-shadow glow (`0 0 16px rgba(255,255,255,0.5)`) instead of scale transform
  - Drag ghost: themed backgrounds, scale 1.08×, fades to opacity 0 with scale 1.0 on drop
  - Bottom bar: `witch/bar_h.png` stretched to fill (`background: url(/witch/bar_h.png) center/100% 100% no-repeat`)
  - Scrollbar: brown-themed (`#2a1506` track, `#5c3a1e` thumb)
  - Telemetry status borders suppressed
  - Hover: `brightness(1.15)` filter
  - Refresh/help buttons show `witch/refresh.png` and `witch/help.png` images (22×22)
- **Cross-window consistency:** Uses the same centralized `spriteIdx` from the main process (see GroundMapWindow witch mode docs), so a callsign shows the same character in ground radar, air radar, and flight strips simultaneously.

**Squawk codes:**
- Generated server-side in `get-flight-strip-data` IPC handler
- Deterministic: same callsign always gets the same squawk (djb2 hash + linear probe)
- Unique across all callsigns (collision-free), range 2000–6000
- **EM override:** When an aircraft is marked as emergency (via air radar double-click refresh), its squawk overrides to **7700** in both `FlightStripContent` and `DragGhost`. Reverts to the static hash-based squawk when EM is cleared or reassigned to a different aircraft.

**Help overlay:** `MapHelpOverlay type="strips" title="Map Help"` — 3 sections: Buttons (Refresh, Help), Display (seat columns, runway separators, arrival/departure colors), Interaction (click to select, deselect, drag reorder). Full i18n (zh + en) for overlay content; `title` prop forces English header.

**IPC handlers:** `open-flight-strips`, `close-flight-strips`, `get-flight-strip-data`.
**Preload additions:** `openFlightStrips`, `closeFlightStrips`, `getFlightStripData`.

### Strip Command Interface (planned, UI hidden)

When a strip is selected (clicked), a command bar slides up above the bottom status bar showing context-sensitive ATC commands. Commands are filtered by `controlSeat`, airborne/ground status (`position.y > 1.0`), and flight direction (0=departure, 1=arrival).

Branch commands (marked with `→`) navigate to a sub-menu showing dynamic options (runway designators or taxiway names). Leaf commands send a UDP command to the game and dismiss the bar.

**Data files:** `src/components/MapWindows/commandTree.js` (command definitions), `FlightStripCommandBar.jsx` (UI component), `src/utils/constants.js` (`CMD_*` constants 22–47).

**Taxiway names** are fetched via `collectValues` IPC → `_taxiwayPaths.paths[].name` on mount and passed to `setTaxiways()` so sub-menus can generate dynamic taxiway options.

#### Command Table

| Seat | Aircraft State | Commands |
|------|---------------|----------|
| **RAMP** (1) | Ground | PUSH BACK APPR, CHANGE RWY TO →, CONTACT GND |
| **GROUND** (2) | Ground | PUSH BACK APPR, CHANGE RWY TO →, TAXI VIA →, HOLD SHORT →, DISPATCH TOW VIA →, CONTACT TWR, STAND BY, HOLD POSITION |
| **TOWER** (3) | DEP — Ground | CLEAR FOR TKOF, LINE UP & WAIT, HOLD SHORT →, CHANGE RWY TO →, TAXI VIA →, HOLD SHORT →, DISPATCH TOW VIA →, STAND BY, CROSS RWY, CONTACT DEP, CONTACT GND |
| **TOWER** (3) | ARR — Airborne | CLEARED TO LAND, GO AROUND, CONTINUE APPR, SELECT EXIT AT → |
| **TOWER** (3) | ARR — Ground | SELECT EXIT AT →, CHANGE RWY TO →, CROSS RWY, CONTACT DEP, CONTACT GND |

#### Sub-Menu Sources

| Sub-Menu | Options From | Used By |
|----------|-------------|---------|
| `→` (runway) | `ac.runway` split on `/` (e.g. "13L/31R" → ["13L", "31R"]) | HOLD SHORT (TOWER DEP), CHANGE RWY TO (all seats) |
| `→` (taxiway) | `_taxiwayPaths` from airport scenery cache, unique sorted names (A, B, C, A1…) | TAXI VIA, HOLD SHORT, DISPATCH TOW VIA, SELECT EXIT AT |

#### Command ID Registry

| Constant | ID | Used By |
|----------|----|---------|
| `CMD_CONTACT_TOWER` | 22 | CONTACT TWR (GROUND, also used in flight_plans.js) |
| `CMD_CLEARED_TO_LAND` | 23 | CLEARED TO LAND (TOWER ARR, also used in flight_plans.js) |
| `CMD_GO_AROUND` | 24 | GO AROUND (TOWER ARR) |
| `CMD_CONTINUE_APPROACH` | 25 | CONTINUE APPR (TOWER ARR) |
| `CMD_CLEAR_FOR_TAKEOFF` | 26 | CLEAR FOR TKOF (TOWER DEP) |
| `CMD_LINE_UP_WAIT` | 27 | LINE UP & WAIT (TOWER DEP) |
| `CMD_HOLD_SHORT` | 28 | HOLD SHORT of runway (TOWER DEP) |
| `CMD_PUSH_BACK` | 31 | PUSH BACK APPR (RAMP, GROUND) |
| `CMD_CONTACT_GROUND` | 33 | CONTACT GND (RAMP, TOWER) |
| `CMD_HOLD_SHORT_TAXI` | 39 | HOLD SHORT at taxiway (GROUND, TOWER DEP) |
| `CMD_HOLD_POSITION` | 40 | HOLD POSITION (GROUND) |
| `CMD_TAXI_VIA` | 41 | TAXI VIA taxiway (GROUND, TOWER DEP) |
| `CMD_CONTACT_DEP` | 42 | CONTACT DEP (TOWER) |
| `CMD_CHANGE_RWY` | 43 | CHANGE RWY TO (all seats) |
| `CMD_DISPATCH_TOW` | 44 | DISPATCH TOW VIA (GROUND, TOWER DEP) |
| `CMD_SELECT_EXIT` | 45 | SELECT EXIT AT (TOWER ARR) |
| `CMD_STAND_BY` | 46 | STAND BY (TOWER DEP) |
| `CMD_CROSS_RWY` | 47 | CROSS RWY (TOWER) |

> **Note:** Command IDs 22–23 are confirmed correct (used in `src/acl/flight_plans.js:805`). IDs 24–47 are placeholders pending game protocol verification.

### Patch Command Composer (`FlightPatchCommandBar.jsx`) — LIVE

Shown at the bottom of the strips window when a strip is selected **and** the aircraft is on the **approach channel** (`aircraft.controlSeat === CHANNEL_TYPE_APPROACH`, seat 5). Hidden for every other seat — including final approach under tower (seat 3) — and for any aircraft while `witchMode` is on. Also gated on `checkBepInEx` resolving to installed (the patch frames only reach the game through the AC27Appoarch plugin, which only exists under BepInEx); the gate re-checks on mount, aircraft change, and window focus — while unknown the composer stays hidden so the gate never flashes.

Command-line-style, mouse-only: the command builds up on ONE line (`CSN9355: Fly Heading 090`); at every step the next choices appear as a horizontal option row flush above the line (`Fly Heading | Clear for Approach | Cancel` → heading values `030…360 | Cancel` → `Send | Cancel`). Send appears once ≥1 option is committed. Escape mirrors Cancel (pending value pick → previous menu; else reset the line). **Send/Cancel/Escape keep the strip selected** — the composer resets its own line (`resetCommand`), so the next command can be composed for the same aircraft without re-clicking the strip; selection is released by clicking the window background (`handleBodyClick`).

- `Fly Heading` — heading-only override: opens a **slider panel** (`<input type="range">` 001–360, `Send`/`Cancel` inside the panel) defaulted to the aircraft's live telemetry heading (`noseDirection` → atan2) so Send always has a value. The thumb is an **airplane icon knob**: `PLANE_THUMB_URI` — a `data:image/svg+xml;charset=utf-8,` URI wrapping the `MAP_ICON_PATH` artwork — applied as a `-webkit-mask-image` on the `::-webkit-slider-thumb` (alpha-only mask over an accent-colored thumb; a data-URI SVG is a separate image document, so `fill=currentColor` would resolve to **black** — a mask tinted by the thumb's `background` is why it works) and rotated by `--hdg` = (heading − 90)° (the artwork points east at rotate 0 — 360 → nose up, 090 → right, matching the maps). **CSP gotcha (fixed):** `index.html`'s CSP must include `img-src 'self' data:` — `default-src 'self'` alone blocks the data: URI and the knob fails SILENTLY (mask never applies → the thumb renders as an accent-colored square). The map windows' inline `<svg><path>` icons never hit `img-src` (they're document elements, not image fetches) — the knob was the first data: image fetch and exposed the gap. Sends `update_heading` with `(dx, dy) = (sin H, cos H)` — **+Z = north, +X = east** (030 → `0.5, 0.8660`; 180 → `0, -1`) — plus a fixed `rate: TURN_RATE_DEG_S` (3°/s of game time — IFR standard rate). No speed: the plugin never touches speed; the aircraft keeps flying its own route at the game's own speed. The rate makes the nose **rotate smoothly** to the heading instead of snapping in one frame — the plugin steps the rotation at rate × game-speed-multiplier per tick, so ×2 turns twice as fast per wall-second (same game time) and a paused game freezes the turn. (Omitted/≤0 rate = instant — for scripts; the composer always sends the rate.)
- `Fly Altitude` — climb/descend-and-maintain: opens the same slider-panel pattern, a 1000-ft range from `ALT_MIN_FT` (1000) up to `max(ALT_MAX_FT (9000), current rounded to the nearest 1000)` — the thumb defaults to the rounded current (3300 ft → 3000) so Send always has a value; hidden while the aircraft has no live telemetry (`altitudeBase` memo — `position.y` in GU → ft via `FT_PER_GU = 100/0.3048` ≈ 328.084; 15.24 GU = 5000 ft). Sends `altitude` with `targetFt` (the picked value) and `rate: ALT_RATE_FPM` (1000 ft/min of game time) — the plugin moves the aircraft's **Y only** smoothly (same game-time scaling + pause rule as the turn); direction is implicit in the picked target.
- `Clear for Approach` — hand a STAR (state 30) aircraft onto final approach (state 5). **Supersedes a composed heading/altitude**: choosing it drops any heading/altitude from the line (never sent) and removes the Fly Heading / Fly Altitude options (which also supersede **each other** — one frame per Send); only the `clear_for_appr` frame goes out (no kts/appr fields — the UI no longer exposes the plugin's optional approach-speed support). The frame also carries the same `rate: TURN_RATE_DEG_S` (keyed field `rate=3` in the frame) — the **handoff turn is smooth too**: the plugin arms a phase-gated turn at the handoff (pass-through while the aircraft still flies the STAR, then rotates the nose onto the approach course at 3°/s of game time once the transition lands, dropping on convergence) — no more one-frame snap onto final.
- `Send` — dispatches ONE frame via `electronAPI.sendPatchCommand`, then resets the line; the strip stays selected (the composer stays mounted — `key={aircraft.callSign}` only remounts when the selection changes to a different aircraft).

**CSS:** `FlightStripsWindow.css` — `.flight-strips-command-wrap` (position: relative, z-index 30), `.fcc-suggest` (absolute, `bottom: 100%`, monospace option row), `.fcc-suggest-item` / `.fcc-suggest-cancel` (hover states), `.fcc-cmd` (the line being built). Slider panels: `.fcc-heading-slider` (plain `::-webkit-slider-thumb` circle — reused by Fly Altitude) + `.fcc-heading-slider.fcc-plane-thumb` (plane-knob variant: 18×18, no border/radius, accent background, `-webkit-mask-image: var(--thumb-plane, none)` with `contain` sizing, `filter: drop-shadow`, `transform: rotate(var(--hdg, 0deg))` — `--hdg`/`--thumb-plane` set inline per element). Hidden with the command bar in witch mode via the existing `.flight-strips.witch-mode .flight-strips-command-bar` rule.

**Protocol:** frames go to the AC27Appoarch plugin via `send-patch-command` (IPC) → 0x00E7 extended UDP frame — see `udp-telemetry.md` "Command Channel" and the `ac27-appoarch` skill for the full contract.

### Voice Command Input (LIVE — vosk offline backend, 2026-08-06)

Push-to-talk voice command system for the Flight Strips window. Speech backend (2026-08-06): **offline vosk recognition** — `electron/voice-stt-vosk.js` (CJS, spawned by `electron/voiceSttWorker.js` via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — electron.exe runs as plain Node, so the child is self-contained CJS with no `require('electron')`). Mic capture is **sox** (`bin/sox/sox.exe`, sox_ng 14.8.0.1 static build) on the Windows default recording device (`-t waveaudio default`), resampled to 16 kHz mono S16LE raw PCM; decoding is **koffi** (`node_modules/koffi`, N-API 8 — loads on Electron's NAPI 9 without rebuilding) driving the vendored `bin/vosk/libvosk.dll` (0.3.39, via `electron/voskFfi.js` — the `vosk` npm package was rejected: its ffi-napi/ref-napi prebuilds are N-API 10, unloadable under Electron's bundled Node 20.18, and its install script aborts at teardown). **Dual-language decode**: one Recognizer per model (`vosk-model-small-en-us-0.15` + `vosk-model-small-cn-0.22`, downloaded into `models/` by `scripts/fetch-vosk-model.mjs`, gitignored; dev-only LARGE pair `vosk-model-en-us-0.22`/`vosk-model-cn-0.22` via `--large` — see the env-override list below, never bundled into builds) on the same PCM — the emitted result is the higher average word-confidence, so no language toggle is needed. Both recognizers are **grammar-constrained** (`electron/voice-grammar.json`, generated by `scripts/gen-vosk-grammar.mjs` from the live parser tables, pinned by a consistency test): EN uses the word list directly; ZH is expanded to **single characters** (the cn model's vocab is character-based — phrase-level words like 爬升保持 are OOV and silently dropped) and emitted space-free (the ZH parser matches contiguous chars). The previous backend (Windows System.Speech via a PowerShell 5.1 worker) was removed for near-0 accuracy (open dictation, post-hoc fuzzy); the original **Web Speech API** was removed earlier still because Chromium streams mic audio to Google's speech API, shut down for shell environments (survives only as a browser-mode fallback). Retargeted to the **patch-command vocabulary** (2026-08-05): the voice chain dispatches `sendPatchCommand` payloads byte-identical to what `FlightPatchCommandBar` composes.

**Flow:**
```
PTT pressed → clear selection → capture speech → parseVoiceCandidates([primary, ...alternates]):
  → try candidates in order; first parse yielding commands wins (the primary is what's displayed)
  → detectLanguage (EN/ZH) → parseCallsign (airline→ICAO + numbers, aircraft lookup)
  → greedy pattern match over the remaining text (fuzzy-tolerant, EN) → command chain
  → bare callsign = selection only (active/yellow via the selection effect)
  → matchedCommand effect: seat-gate (controlSeat === 5) then dispatch the chain
    via sendPatchCommand, one frame per command, in order — the strip stays selected
```

**Translation table** (EN + ZH, in `voiceTranscriptParser.js`): `fly/turn (left|right) (to) heading N` → update_heading (absolute; direction word tolerated); `climb|descend and maintain N` / `climb|descend to N` / `fly altitude N` / `level (off) (at) N` / `flight level N` → altitude; `reduce (speed) to N` / `increase speed to N` / `slow (down) to N` / `fly speed N` / `N knots` → update_speed; `clear(ed) (for) (the) [ils|rnav|visual|loc|vor|ndb] approach|appr` → clear_for_appr (supersedes a chain; a trailing `runway N (left|right|center)` designator is consumed and ignored — the aircraft's assigned runway stays authoritative); bare `maintain/保持 N` disambiguated: unit word wins, then N ≥ 1000 → altitude else speed. Numbers: digit-by-digit, magnitudes (`two thousand`→2000, `九千`→9000), slots (`one eighty`→180), tens+ones (`thirty four`→34/304 — aircraft list disambiguates), `o`/`oh` for zero (speech engines render "oh" as "o"), FL ×100, Arabic fallback. Leading fillers (`um`/`uh`/`okay`/`sir`…) are stripped before the airline and number ("okay delta uh 3401" parses; "Okay Airways" still matches via the original-text-first rule). Unmatched text → `unsupported:` notices, never silently dropped. Parse failures return `reason` naming the failing stage (no airline / candidates not in list + first unparsed token / no aircraft data).

**Fuzzy matching (EN only, post-processing safety net over the vosk grammar):** exact-first, then Damerau-Levenshtein (OSA) with per-slot caps — pattern/airline words ≤1 (≤5 chars) or ≤2 (≥6), number/unit words and approach types flat ≤1 — plus a curated multi-token table for spelled-out forms ("r nav"→rnav, "eye el ess"→ils, "eff el"→fl). At most ONE deviation per pattern match (one connector-skip — "climb and then maintain 9000" — or one fuzzy word, never both). Locked rules in `voiceFuzzy.js`: the two semantic inversions within distance (`ascend`→descend, `decrease`→increase) are **excluded**; fillers (`uh`/`um`/…) never fuzzy-map; 2-char tokens are exact-only except `to`/`an`/`on`/`of` (real SAPI artifacts); 3-letter airline codes are exact-only ("deal" never becomes dal); command words are guarded out of flight-number scans ("CSC6918: right heading 120" must not eat "right" as a misheard digit). The **exhaustive acceptance table** (every dictionary word within cap of every grammar token, 1,449 accepts) is generated by `scripts/gen_voice_fuzzy_acceptance.mjs` from the real vocab tables into `tests/components/MapWindows/voiceFuzzyAcceptance.json`, round-trip-verified against the runtime lookups, and `--check` guards drift. Chinese stays exact-only.

**Source files:**

| File | Purpose |
|------|---------|
| `voiceTranscriptParser.js` | **The core** — `parseVoiceTranscript(transcript, aircraftList)` → `{ ok, callsign, aircraft, lang, commands: [{type, label, payload}], notices, renderedLine, reason? /* non-empty on ok:false */ }` (payloads ready for `sendPatchCommand`) + `parseVoiceCandidates(texts, aircraftList)` (primary-then-alternates — first candidate yielding commands wins, selection-only never wins, no winner → primary unchanged) + `buildSyntheticAircraftList()` (CLI callsign resolution). Pattern matching is fuzzy-tolerant (F3: one connector-skip or one fuzzy word per pattern). Pure, DOM-free, Node-loadable (explicit `.js` specifiers). Shared by the hook AND `scripts/voice_sim.mjs`. |
| `voiceNumberParser.js` | Spoken numbers: `parseEnglishFlightNumber()` / `parseChineseFlightNumber()` (digit candidates) + `parseSpokenNumberValue(tokens|string, lang)` (command values — digits/magnitude/slots/ZH positional, e.g. 幺二洞→120, 一百八→180). Accepts literal Arabic digits + punctuation ("6918:"). Fuzzy D-L ≤1 on number/unit words (`lookupEnNumberToken`, `lookupUnitWord` — "tree"→three, "to"→two, "nots"→knots) with fillers excluded; command words guarded out of flight-number scans. Exports `EN_UNIT_WORDS`/`ZH_UNIT_WORDS` + the key lists (`EN_NUMBER_FUZZY_KEYS` etc.) for the acceptance generator. |
| `voiceCallsignParser.js` | `detectLanguage()` (CJK check), `parseCallsign()` — longest-match airline prefix (`getSpokenToCode()` from `AIRLINE_CODE_MAP`) + number parsing + aircraft lookup; separate EN/ZH paths. EN airline names are fuzzy (D-L ≤1, ≤1 fuzzy word per name — "hainann"→hainan, "untied"→united; 3-letter codes exact-only). Exports `getSpokenToCode()`, `matchPrefix()`, `matchPrefixFuzzy()`, `getSpokenNameWords()`, `callsignCandidates()` (all plausible callsigns for the CLI — fuzzy-aware so the sim mirrors the app). |
| `voiceFuzzy.js` | **Fuzzy policy leaf** (imports nothing) — `damerauLevenshtein()` (OSA), `maxDistForWord()` (≤5→1, ≥6→2), `fuzzyMatch`/`fuzzyLookupKey` (exact-first, deterministic, per-candidate caps), `NON_FUZZY_WORDS` (fillers never fuzzy-map — also re-exported as `EN_FILLER_WORDS`), `SHORT_FUZZY_TOKENS` (`to`/`an`/`on`/`of`), `CURATED_EXCLUDE` (ascend→descend, decrease→increase blocked), `CURATED_CONFUSABLES` + `resolveCuratedPhrase()` (spelled-out forms), `FLIGHT_NUMBER_FUZZY_GUARD` (command words can't be swallowed as digits). |
| `voiceCommandMatcher.js` | **Retained but unused by the pipeline** (legacy fuzzy matcher for the old native `CMD_*` vocabulary; its tests still pass). The active matcher is the greedy pattern engine inside `voiceTranscriptParser.js`. |
| `useVoiceCommands.js` | React hook — recognition session lifecycle (2s silence auto-stop **webkit only** — in Electron the worker's engine owns silence timing; 500ms cooldown). Electron: drives the offline vosk worker over IPC (`voice-stt-start`/`voice-stt-stop`, `voice-stt-event` pushes from the main process); browser fallback: `SpeechRecognition` (webkit). `processCandidates([primary, ...alternates])` → `parseVoiceCandidates` (logs `matchedFrom=primary|alternate#N`); `processTranscript(text)` is the single-candidate form for the browser path. Returns `{ listening, transcript, matchedCallsign, matchedCommand /* array */, confidence, error, voiceResult, matchedAircraft, isSupported, startListening, stopListening }`. |
| `electron/voice-stt-vosk.js` | The worker child — CJS, runs under ELECTRON_RUN_AS_NODE. JSON-lines protocol (in `{cmd:start|stop|exit}`; out `ready`/`started`/`stopped`/`result{text,confidence,language}`/`detected`/`rejected{busy|low-confidence}`/`error{code}`). Session semantics mirror the old ps1: fresh Recognizers per `start`; `stop` flags — the in-flight phrase ALWAYS finalizes (vosk utterance boundary, or a 1.5 s silence grace after `stop` that resets only while speech flows — sox streams continuous silence, so an audio-based keep-alive would never fire) and its result is delivered before `stopped`; a `start` while finalizing resumes the session (re-emits `started`), while actively recognizing → `rejected busy`. Dual-lang: phrase results per recognizer are ACCUMULATED (finalResult() resets a recognizer — a boundary on one must not force the other mid-phrase), the winner is the higher mean word confidence (`result[]` word confs — not `words`; 0.3.39 naming), zh needs ≥3 chars (junk guard on EN speech) and is emitted space-free. Errors: `NO_MODEL`/`MODEL_LOAD_FAILED`/`NO_GRAMMAR` (boot), `SOX_NOT_FOUND`/`NO_AUDIO_DEVICE` (session). CLI: `--wav <file>` (16 kHz mono 16-bit; collects per-recognizer phrases at each own boundary, joins, single winner result), `--test` (model+grammar+sox self-check). |
| `electron/voskFfi.js` | koffi binding to `bin/vosk/libvosk.dll` (0.3.39 C API — `vosk_model_new`/`vosk_recognizer_new_grm(model, rate, grammarJson)`/`accept_waveform`/`result|partial|final_result`). Loads the DLL from `VOSK_LIB_DIR` → packaged `resources/vosk` → repo `bin/vosk`, prepending the DLL dir to PATH (MinGW runtime DLLs). koffi returns `null` for NULL and BigInt addresses for opaque pointers. |
| `electron/voice-grammar.json` | The Vosk `setGrammar` lists (`{words, wordsZh}`) — generated from the LIVE parser tables (EN_PATTERNS, CFA sets, EN_NUMBER_KEYS, EN_UNIT_WORDS, airline words, fillers, phraseology literals, ZH_PATTERNS, ZH_DIGIT, ZH_UNIT_WORDS, zh airline short forms) by `scripts/gen-vosk-grammar.mjs`; committed, deterministic, pinned by `voiceGrammarConsistency.test.js` (any parser-table edit without regeneration fails `npm test`). |
| `electron/voiceSttWorker.js` | Main-process bridge — spawns `process.execPath` (electron.exe) with `ELECTRON_RUN_AS_NODE=1` + `VOICE_RESOURCES` (packaged `process.resourcesPath` / repo root in dev — the child has no `require('electron')`), state machine `idle→starting→ready→recognizing→ready`, **release-drain** (`STOP_DRAIN_MS` 1500): the `stop` command is delayed so the child can finalize the in-flight phrase; a re-press inside the window cancels the pending stop (seamless continuation, no restart), a re-press after it is forwarded and the child continues the finalizing session. Request-scoped event routing to the initiating window, `will-quit` dispose (3s kill grace). `ready` carries `{engine:'vosk', model:'en+zh', culture:'en-US,zh-CN', languages, models, grammarWords}` — the drain test asserts `status.available === true` only. Boot errors flow through the existing `error` → `_failProbes` path (`NO_SCRIPT` when the worker JS isn't shipped, e.g. the normal non-voice build — voice degrades to a tooltip). |
| `VoicePTTButton.jsx` | Hold-to-talk mic button: idle (gray `IoMicOutline`), listening (red `IoMic` + pulse), matched (green flash 300ms), error (dimmed red). `feedback` prop shows the transient result line as tooltip. `witchMode` renders `witch/voice.png`. |

**Integration points in `FlightStripsWindow.jsx`:**
- `handleVoicePress` clears selection before PTT; `handleVoiceStart` = press + `voice.startListening`
- `useEffect` on `voice.matchedCallsign` → `setSelectedCallSign()` + `selectAircraftInMap()` (the active/yellow selection)
- `useEffect` on `voice.matchedCommand` → seat-gate (`controlSeat === 5`, else feedback "not on approach channel"), then dispatches the chain via `electronAPI.sendPatchCommand` one frame at a time — selection kept, transient `.voice-feedback` line ("CSC6918: Fly Altitude 9000, Fly Speed 180 ✓", 4s auto-clear)
- Button visible whenever **BepInEx Debug Mode is active** (`bepInExActive` gate, same check as `FlightPatchCommandBar`) — selection works for any aircraft; commands only on the approach channel
- Command constants + payload builders shared with the composer via `src/utils/patchCommands.js` (`buildHeadingPayload` etc. — single source of truth)

**Audio-free testing:** `node scripts/voice_sim.mjs "CSC6918: climb and maintain 9000, reduce speed to 180 knots" [--live] [--alternates "a|b"]` — runs the exact pipeline (`parseVoiceCandidates`), prints the command-window line + payload JSON, and with `--live` sends the 0x00E7 frames to the game at 127.0.0.1:20267 (send-only socket; never binds 20266). `--aircraft file.json` exercises the seat gate; `--alternates` mirrors the worker's alternate hypotheses (first candidate yielding commands wins, prints `matched from:`); dry-run is the default. Frame builder shared via `electron/patchFrame.js`. **Fuzzy acceptance table:** `node scripts/gen_voice_fuzzy_acceptance.mjs` regenerates `tests/components/MapWindows/voiceFuzzyAcceptance.json` from the real vocab tables (needs network for the 370k-word list; `--check` diffs without writing). **Grammar regeneration:** `node scripts/gen-vosk-grammar.mjs` (or `--check`); **model fetch:** `node scripts/fetch-vosk-model.mjs` (en + zh, ~92 MB, `--check` verifies presence; `--large` fetches the dev-only LARGE pair `vosk-model-en-us-0.22`/`vosk-model-cn-0.22` ~3.3 GB instead — internal accuracy testing only). **STT round-trip (no mic):** `node scripts/voice-stt-test.mjs` — synthesizes EN + ZH phrases via System.Speech **TTS** (16 kHz mono WAVs; SKIPs a language without an installed voice), runs the worker `--wav`, asserts ready → result → stopped + plausible tokens per language. **Vocab coverage:** `node scripts/check-vosk-vocab.mjs` — one child per model reports grammar words missing from the model vocab (Vosk's `Ignoring word missing in vocabulary` stderr lines at recognizer creation; current: en `appr/kts/ndb/rnav/vor` — all optional in the patterns — zh full char coverage). **Worker lifecycle regression:** `node scripts/voice-drain-test.mjs` — start/release/re-press/dispose cycle against the real worker (unchanged protocol, ALL PASS).

**Mic ownership:** the **sox child owns the mic** (`-t waveaudio default` = the Windows default recording device; privacy settings apply to the app/sox). The renderer never requests `media` in Electron, and `main.js`'s permission handler denies everything. Only the browser-mode fallback (vite in Chrome) uses the browser's own mic permission, which is why `index.html`'s CSP still has `media-src 'self' mediastream:`. First use may be silent if the app is blocked in Settings → Privacy → Microphone.

**UX notes:** vosk emits **final results only** (one `result` per phrase — no interim text), so the "Heard: …" tooltip updates per phrase; the first press after launch takes ~1–4 s (both models load — the status probe absorbs it), later presses are instant. Multiple commands within one hold each produce a result. **The PTT release can never discard a phrase** — the child finalizes the phrase in flight (vosk boundary or 1.5 s silence grace) before the session ends, and a fast re-press continues the same session. A result therefore lands up to ~1.5 s after you stop speaking; if none appears, the main-process log distinguishes the failure: `detected` + `rejected` lines = the mic heard audio but it couldn't be parsed; nothing at all = the mic heard nothing (check the Windows default recording device — sox only uses the default). A worker crash mid-hold surfaces a visible error (button tooltip). **Model paths / env overrides** (child-side, env-first): en model `VOSK_MODEL_DIR` → `<VOICE_RESOURCES>/models/vosk-model-small-en-us-0.15`; zh model `VOSK_ZH_MODEL_DIR` → `<VOICE_RESOURCES>/models/vosk-model-small-cn-0.22`; sox `VOSK_SOX_PATH` → `resources/sox/sox.exe` (packaged) → `bin/sox/sox.exe` (dev); vosk DLLs `VOSK_LIB_DIR` → `resources/vosk` → `bin/vosk`. **`VOSK_USE_LARGE=1`** (set by `npm start -- --large`, dev-only) switches the defaults to the LARGE pair `vosk-model-en-us-0.22`/`vosk-model-cn-0.22` — the per-model env vars above still take precedence, and the large models are never bundled into builds.

**Tests:** the voice Vitest suites (`voiceNumberParser`, `voiceCallsignParser`, `voiceCommandMatcher` legacy, `voiceSpokenNumberValue`, `voiceTranscriptParser`, `voiceDeviationMatrix`, `voiceFuzzy`, `voiceCandidates`, `voiceFuzzyAcceptance`) are unchanged, plus `voiceGrammarConsistency.test.js` (pins `voice-grammar.json` ⇄ live parser tables, en + zh). End-to-end gates are the script harnesses above (drain test, STT round-trip, vocab check).

## Shared Hooks

### `useSvgZoom.js`

- Scroll-wheel zoom: cursor-centered, 1.12× factor per tick, clamped between 2% and 100% of initial viewBox
- Click-drag pan: pixel-to-viewBox coordinate conversion, **clamped** to stay within initial viewBox bounds
- Reset on first data load only (not subsequent prop changes)
- **Imperative zoom/pan API** (for sidebar spin knobs, uses `viewBoxRef` to avoid stale closures):
  - `zoomIn()` / `zoomOut()` — center-based, 1.12× factor, clamped
  - `panLeft()` / `panRight()` / `panUp()` / `panDown()` — 5% step, clamped to initial bounds
- **Axis-specific resets:** `resetPanH()` (horizontal only) and `resetPanV()` (vertical only) preserve zoom + opposite-axis offset
- Returns `{ viewBox, svgRef, resetZoom, resetPanH, resetPanV, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp, zoomIn, zoomOut, panLeft, panRight, panUp, panDown }`

### `useUdpAircraftState.js`

- Subscribes to `electronAPI.onUdpAircraftState` on mount, unsubscribes on unmount
- Returns `{ aircraft: Array, currentAirport: string|null, simTimeUnixMs: number, simFlags: number, timeScale: number, udpAirportChanged: boolean }` updated at ~200ms (5 Hz push interval)
- Each aircraft object includes `spriteIdx` (0–14) injected by the main process during the push interval — used by witch mode for cross-window consistent character assignment
- `simFlags` bit field: bit 0=isPaused, bit 1=isStarted, bit 2=hasLevel; `timeScale` = game speed multiplier (0=unknown)
- `udpAirportChanged`: true for exactly one render when the UDP airport code transitions from one valid code to a different one. Uses `useRef` to track `prevAirportRef` across renders. Map windows use this to auto-reset aircraft state + reload data when the user switches airports in-game.
- Used by GroundMapWindow, AirMapWindow, and FlightStripsWindow (simTimeUnixMs drives the SimClock component)

### `hooks/map/useCrossWindowSelection.js`

- Shared IPC listener for cross-window aircraft selection sync
- `useCrossWindowSelection(airportIcao, electronAPI, setSelectedCallSign)` — fetches current selection on mount via `getSelectedAircraft`, then subscribes to `aircraft-selected-in-map` IPC events scoped to the given airport ICAO
- `useCrossWindowEmergency(airportIcao, electronAPI, setEmergencyCallSign)` — same pattern for emergency (squawk 7700) aircraft state
- Used by: AirMapWindow, GroundMapWindow, FlightStripsWindow
- Replaces duplicated `useEffect` blocks in each map window component

### `hooks/map/useWitchAnimation.js`

- Shared 500ms frame-toggle timer for witch mode sprite animations
- `useWitchAnimation(witchMode)` — when `witchMode` is true, toggles between frame 0 and frame 1 on a 500ms `setInterval`; when false, clears the interval and resets to frame 0
- Returns `witchFrame` (0 or 1)
- Used by: AirMapWindow, GroundMapWindow, FlightStripsWindow
- Replaces duplicated `useState`/`useRef`/`useEffect` blocks in each map window

### `hooks/map/useKnobPositions.js`

- Maps the current SVG `viewBox` to 0-1 knob gauge positions for ControlSidebar SpinKnobs
- `useKnobPositions(viewBox, initialViewBox)` — returns `{ zoom, panH, panV }` via `useMemo`
- Zoom: higher value = zoomed in (smaller viewBox w/h), range is 15%-150% of initial viewBox
- Pan: centre of current viewBox relative to initial centre, range +-40% of initial width
- Used by: AirMapWindow, GroundMapWindow

## BrowserScreen Integration

- **Airport card background:** Each airport card renders a mini ground-radar SVG via `AirportCardMap` component (same geometry data as GroundMapWindow: area polygons, taxiway paths, runway rectangles). The SVG is oversized (`cardHeight / 0.30`) and centered behind the card; `overflow: hidden` clips it to card bounds so the card acts as a window showing ~30% of the total background. ViewBox aspect ratio is forced to match the card's (984 / cardHeight) so `preserveAspectRatio="slice"` has no distortion. Card height is computed from row count: `HEADER_H + numRows × ROW_H` (46 + n×35 px). Replaces the old static `public/{ICAO}.png` images.
- **Toggle buttons:** Each airport card shows up to three map toggle buttons when NOT in demo mode (`!isDemo`):
  - "Surface Radar" (`IoMapOutline` icon, i18n: `toolbar_surface_radar`)
  - "Approach Radar" (`IoNavigateOutline` icon, i18n: `toolbar_approach_radar`)
  - "Flight Strips" (`IoListOutline` icon, i18n: `toolbar_flight_strips`)
  - Buttons have an `.active` class when the corresponding window is open for that airport
  - In demo mode (`rootPath` includes `'Airport Control 27 Demo'`), radar buttons are hidden entirely
- **Toggle handler:** Checks `openGroundRadarAirports` / `openAirRadarAirports` / `openFlightStripAirports` Sets — if ICAO present, calls `closeXxxMap` IPC; otherwise calls `openXxxMap` IPC. Updates zustand state on both paths.
- **Window-closed sync:** `onRadarWindowClosed` listener updates zustand Sets when user closes a map window via its X button (the main process notifies the renderer so toggle state stays in sync).

## Zustand Store Additions (`appStore.js`)

```js
// State
openGroundRadarAirports: new Set(),   // ICAO codes of open Surface Radar windows
openAirRadarAirports: new Set(),      // ICAO codes of open Approach Radar windows
openFlightStripAirports: new Set(),   // ICAO codes of open Flight Strips windows
udpConnected: false,                   // UDP telemetry listener is receiving packets
udpCurrentAirport: null,              // Current airport ICAO from UDP (null if no packets)

// Actions
setGroundRadarOpen(icao, open)  // Add/remove from openGroundRadarAirports Set
setAirRadarOpen(icao, open)     // Add/remove from openAirRadarAirports Set
isGroundRadarOpen(icao)         // → openGroundRadarAirports.has(icao)
isAirRadarOpen(icao)            // → openAirRadarAirports.has(icao)
setFlightStripOpen(icao, open)  // Add/remove from openFlightStripAirports Set
isFlightStripOpen(icao)         // → openFlightStripAirports.has(icao)
setUdpStatus(connected, currentAirport)  // Update UDP health state
```

**Important:** Set mutations must create a new `Set(...)` rather than mutating in place, per existing zustand Immutability rules.

## Map Window i18n Keys

| Key | Chinese | English |
|-----|---------|---------|
| `toolbar_surface_radar` | åœºé¢é›·è¾¾ | Surface Radar |
| `toolbar_approach_radar` | è¿›è¿‘é›·è¾¾ | Approach Radar |
| `toolbar_flight_strips` | è¿›ç¨‹å• | Flight Strips |
| `air_map_bg` | Map | Map |
| `air_map_waypoints` | Waypoints | Waypoints |
| `air_map_airspace` | Airspace | Airspace |
| `air_map_runway_ext` | ILS | ILS |
| `air_map_labels` | Label | Label |
| `air_map_star` | STAR | STAR |
| `air_map_sid` | SID | SID |
| `air_map_appr` | APPR | APPR |
| `map_help_air_waypoints` | 显示/隐藏雷达上的航路点/定位点。不受跑道过滤影响。 | Show/hide fixes (waypoints) on the radar. Not affected by runway filtering. |
| `ground_map_taxiway` | Label | Label |
| `ground_map_show_all` | Parked | Parked |
| `map_refresh` | Refresh | Refresh |
| `knob_zoom` | Range | Range |
| `knob_pan_h` | E-W | E-W |
| `air_map_runways` | Runway | Runway |
| `map_help_air_runways` | (generic help) | (generic help) |
| `map_help_air_arr` | æ˜¾ç¤º/éšè—è¿›æ¸¯èˆªç­æ ‡ç­¾ | Show/hide arrival aircraft labels |
| `map_help_air_dep` | æ˜¾ç¤º/éšè—ç¦»æ¸¯èˆªç­æ ‡ç­¾ | Show/hide departure aircraft labels |
| `map_help_air_rwy_desc` | æ˜¾ç¤º/éšè—RWY{rwy}çš„STAR/SID/è¿›è¿‘ç¨‹åºè·¯å¾„ | Show/hide STAR/SID/APPR paths for RWY{rwy} |
| `knob_pan_v` | S-N | S-N |
| `map_help_title` | åŠŸèƒ½æŒ‡å— | Map Help |
| `map_help_air_knobs_heading` | æ—‹é’® | Knobs |
| `map_help_air_toggles_heading` | æŒ‰é’® | Buttons |
| `map_help_air_interact_heading` | äº¤äº’ | Interaction |
| `map_help_ground_knobs_heading` | æ—‹é’® | Knobs |
| `map_help_ground_toggles_heading` | æŒ‰é’® | Buttons |
| `map_help_ground_interact_heading` | äº¤äº’ | Interaction |
| `map_help_strips_buttons_heading` | æŒ‰é’® | Buttons |
| `map_help_strips_interact_heading` | äº¤äº’ | Interaction |
| `flight_strips_loading` | åŠ è½½ä¸­… | Loading… |
| `flight_strips_waiting` | ç­‰å¾…æ•°æ®… | Waiting for data… |
| `flight_strips_empty` | æ— æ´»è·ƒé£žæœº | No active aircraft |
| `flight_strips_runway` | è·‘é“ | RUNWAY |
| `seat_1`–`seat_7` | RMP/GND/TWR/DEP/APPR/DEL/APN | RMP/GND/TWR/DEP/APPR/DEL/APN |
| `seat_1_full`–`seat_7_full` | RAMP/GROUND/TOWER/DEPARTURE/APPROACH/DELIVERY/APRON | RAMP/GROUND/TOWER/DEPARTURE/APPROACH/DELIVERY/APRON |

## Map-Window Portal Tooltips

All three map windows (AirMapWindow, GroundMapWindow, FlightStripsWindow) use the shared `useTooltip` hook (`src/components/BrowserScreen/useTooltip.jsx`) for on-hover button tooltips. Tooltip text is extracted from existing map help page i18n strings and is fully bilingual (EN/ZH). The entire system is gated behind `MAP_TOOLTIPS_ENABLED` in `src/utils/constants.js` (default `false`).

### Pattern

```js
import useTooltip from '../BrowserScreen/useTooltip';
import { MAP_TOOLTIPS_ENABLED } from '../../utils/constants';

// In component body:
const { bind, TooltipPortal } = useTooltip();

// Extract description from a help i18n string (strips {{btn:...}} — prefix)
const helpTip = useCallback(
  (key) => t(key).replace(/^\{\{btn:\w+\}\}\s*[—–\-ï¼š:]\s*/, ''), [t]);

// Gated bind wrapper — returns {} when disabled (zero overhead)
const tipBind = useCallback(
  (text) => MAP_TOOLTIPS_ENABLED ? bind(text) : {}, [bind]);

// On a button:
<div className="air-map-toggle"
  onClick={...}
  {...tipBind(helpTip('map_help_air_star'))}>

// At bottom of component:
{MAP_TOOLTIPS_ENABLED && TooltipPortal}
```

### Component-Specific Prop Additions

**SpinKnob** — accepts optional `tooltip` string prop. Uses `useTooltip` internally, spreads `bind(tooltip)` on root `.spin-knob` div. Render `{TooltipPortal}` after the label. All gated by `MAP_TOOLTIPS_ENABLED`.

**RunwaySidebar** — accepts optional `arrTooltip`, `depTooltip`, `waypointsTooltip`, `getRunwayTooltip(rwy)` props. Also accepts `showWaypoints` + `onToggleWaypoints` — when `onToggleWaypoints` is a function, renders the Waypoints toggle (hardcoded label, like ARR/DEP) above ARR in `.runway-sidebar-labels`. Uses `useTooltip` internally. Replaces old `title` attributes with portal tooltips. All gated by `MAP_TOOLTIPS_ENABLED`.

**ControlSidebar** — accepts optional `knobTooltips` prop: `{ zoom?, panH?, panV?, airspace? }`. Passes tooltip strings to each `SpinKnob`. For `airspaceKnob` (injected as a React element), uses `React.cloneElement` to add the `tooltip` prop when enabled.

### Exclusions

- The **help/witch-mode toggle button** (`map-help-btn` / help `strips-bar-btn`) never gets a tooltip — it already has native `title` attributes and its double-click behavior toggles witch mode.

## New Constants

- **`MAP_TOOLTIPS_ENABLED`** (`src/utils/constants.js`): Feature flag controlling on-hover portal tooltips on all radar/strip buttons. Default `false` (OFF). When `true`, tooltips appear on mouse hover for all toggle buttons, spin knobs, refresh buttons, and runway sidebar buttons. Tooltip text is extracted from map help i18n strings (the description portion after the `{{btn:...}}` token). The help/witch-mode toggle button is always excluded. Setting this to `false` disables all map-window tooltips with zero runtime overhead (the `tipBind()` wrapper returns `{}` and `TooltipPortal` renders `null`).
- **`AIR_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for approach radar background image (renamed from `STAR_BG_OFFSETS`). Fields: `dx`/`dy` (fine-tune position offset), `w` (image width in viewBox units when height=3000), `bg` (color outside map image), `bgUnder` (color behind semi-transparent image). Entries for ZSJN and KJFK. Witch mode uses separate `WITCH_MAP_BG_OFFSETS`.
- **`NM_TO_GU`** (`src/utils/constants.js`): Nautical mile to game-units conversion (18.52 = 1852m ÷ 100 m/unit). Used by AirMapWindow for runway extension lines, tick marks, and range rings.
- **`AIR_MAP_DEFAULT_ZOOM`** / **`GROUND_MAP_DEFAULT_ZOOM`** (`src/utils/constants.js`): Per-airport default zoom scale. 1.0 = full dataBounds, <1 = tighter initial view. Entries for ZSJN (0.75 ground) and KJFK (1.0 both).
- **`GROUND_RADAR_STAND_PROXIMITY`** (`src/utils/constants.js`): Max distance (0.5 GU ≈ 50m) from aircraft position to its assigned stand midpoint to consider it "parked at stand." Used by GroundMapWindow to hide inactive aircraft.
- **`GROUND_MAP_CENTER_OFFSET`** (`src/utils/constants.js`): Per-airport viewBox center offset in game units (`{x, z}`). Used by GroundMapWindow to fine-tune initial camera position. Entries for ZSJN and KJFK.
- **`GROUND_MAP_TAXIWAY_LABEL_SPACING`** (`src/utils/constants.js`): Minimum distance (10.0 GU) between same-name taxiway labels to prevent label clutter. Used by GroundMapWindow for proximity dedup.
- **`GROUND_MAP_STAND_ACCESS_WIDTH_MULT`** (`src/utils/constants.js`): Multiplier (1.0) for stand-access taxiway line width. Stand-access segments are rendered with square linecaps for differentiated styling. Change this to make stand-access stubs visually distinct from main taxiways.
- **`WITCH_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for witch mode map background images (`witch/{ICAO}.png`). Independent of normal mode offsets. Fields: `dx`/`dy` (fine-tune position), `w` (override image width, 0 = use default). Entries for ZSJN and KJFK.

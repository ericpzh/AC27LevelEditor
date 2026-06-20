# AC27 Map Windows

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [IPC Handlers](#ipc-handlers-main--renderer)
- [Preload API](#preload-api-windowelectronapi-additions)
- [GroundMapWindow](#groundmapwindow-srccomponentsmapwindowsgroundmapwindowjsx)
- [AirMapWindow](#airmapwindow-srccomponentsmapwindowsairmapwindowjsx)
- [FlightStripsWindow](#flightstripswindow-srccomponentsmapwindowsflightstripswindowjsx)
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

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan), push-button toggles (parked aircraft, taxiway labels, refresh), and a **help button** (`?` icon). Sim-time clock displayed in top-left corner.

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
   - **Witch mode (v1.1.5):** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). **Sprite assignment is centralized in the main process:** `witchSpriteMap` (Map<callSign, spriteIndex>) assigns each callsign a stable 0–14 index round-robin. The `spriteIdx` is injected into each aircraft object during the 200ms UDP push (`electron/main.js`), guaranteeing all windows show the same character. `witchMode.js` accepts `spriteIdx` as a parameter to `getSpriteSheet()`; without it (standalone/testing), falls back to a deterministic djb2 hash of the callsign. Moving: walk sprites (direction-aware via `witchDirection()`); parked/stopped: stand sprites (`isParked()` uses `controlSeat` — None (0) or Unknown (255) = parked; any active seat (1-7) = not parked). Airport boundary (AreaType 0) is hidden. Any click exits witch mode. Labels and connector lines hidden. Background replaced with `witch/groundradar.png`, sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Airport transition auto-reset (v1.1.6):** When `udpAirportChanged` is true and the new airport matches this window's ICAO, calls `electronAPI.resetUdpAircraft()` to clear stale aircraft from the previous airport.

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `GROUND_MAP_DEFAULT_ZOOM` + `GROUND_MAP_CENTER_OFFSET`, pan clamped to initial bounds.

**Click-to-select:** Calls `electronAPI.selectAircraftInMap(airportIcao, callSign)` — centralized IPC handler that stores selection in main process, sends `SelectAircraft` UDP command, and broadcasts the change to all map windows for the same airport (ground + air). On mount, fetches current selection via `getSelectedAircraft` so a newly-opened map window inherits any existing selection. Background click deselects via `selectAircraftInMap(airportIcao, null)`. The selected callSign is rendered with yellow highlight.

## AirMapWindow (`src/components/MapWindows/AirMapWindow.jsx`)

**Purpose:** SVG approach radar for tracking airborne aircraft and visualizing STAR/SID/APPR/missed-approach routes with range rings, runway extensions, and border overlay.

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan, airspace with gauge indicators), push-button toggles (STAR, SID, APPR, Labels, ILS, Map, Refresh), and a **help button** (`?` icon). Sim-time clock in top-left corner.

**Data sources:**
- `_starPaths` (STAR routes, Type=0) — rendered in grey; trimmed at APPR overlap points
- `_sidPaths` (SID departure routes, Type=2) — rendered in grey
- `_missedAppPaths` (Missed Approach routes, Type=3) — rendered in grey
- `_apprPaths` (RNAV approach routes, Type=1) — rendered in grey; points used to trim STAR display
- `_runwayThresholds` from approach cache — for threshold lines and runway extensions
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
7. Border overlay — independent SVG with white border rect and 10° tick marks with degree labels. Tick/label sizes scale inversely to container width via `ResizeObserver` (baseline 800px) so they stay fixed in pixels when the window resizes.
8. Live airborne aircraft — filtered to `position.y > 1.0`:
   - **Direction-based coloring:** Outbound aircraft (`flightDirection === 0`) render with green labels/indicators (`#66ff66`); inbound aircraft (`flightDirection === 1`) use white. Dots remain `#1a4a8a` blue for all. Selected aircraft always get yellow highlights.
   - **Circle:** Small colored circle at aircraft position (unselected) or yellow (selected)
   - **Trail dots:** Ring buffer of historical positions (max 5 snapshots, minimum 600-tick gap), rendered as shrinking circles with decreasing opacity
   - **Heading line:** For selected aircraft only, projects nose direction forward 12× planeScale
   - **Label:** By default, Tower aircraft and selected aircraft show full label (callsign + altitude + speed/type); other aircraft show altitude only. The ARR/DEP toggles on the left RunwaySidebar override this — when active, all aircraft of that direction show the full label. Speed/type toggles every 5 seconds between airspeed/10 and aircraft type. Dynamically positioned via anti-overlap layout (4 candidate positions: right/top/left/bottom). Emergency aircraft show an "EM" label above the callsign in red.
   - **A/D indicator:** "A" or "D" text next to the current position dot
   - **Witch mode (v1.1.5):** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame fly sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). Characters assigned round-robin (centralized in main process via `spriteIdx`, see GroundMapWindow witch mode docs), stable per callsign. Direction-aware via `witchDirection()` (dominant axis of nose vector). Any click exits witch mode. Labels, connectors, and heading lines hidden. Map background switches to `witch/{ICAO}.png` at full opacity with `WITCH_MAP_BG_OFFSETS`, background color `#160900`. Sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Airspace knob:** `SpinKnob` passed via `airspaceKnob` prop to `ControlSidebar` — controls range ring density (0=10NM gap … 11=120NM gap, default 40NM). Double-click knob to reset to default.

**Emergency call sign:** Refresh button (double-click) randomly picks an active aircraft and marks it with a red "EM" label. Single click resets UDP aircraft state.

**Airport transition auto-reset (v1.1.6):** When `udpAirportChanged` is true and the new airport matches this window's ICAO, calls `electronAPI.resetUdpAircraft()` to clear stale aircraft from the previous airport.

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `AIR_MAP_DEFAULT_ZOOM`, pan clamped to initial bounds. Spin knobs show gauge positions derived from current zoom/pan relative to initial viewBox.

**RunwaySidebar:** Vertical bar on left (60px black). **Top section:** ARR/DEP label toggle buttons (default off) — when active, all aircraft of that direction show full labels (callsign + altitude + type) instead of just altitude. **Bottom section:** one RWY-prefixed toggle per runway, stacked from bottom. Both sections reuse `.air-map-toggle` classes for witch mode sprites. Only runways with resolved path data appear. Each runway and the ARR/DEP buttons get dynamic entries in the help overlay.

**Click-to-select:** Same centralized `electronAPI.selectAircraftInMap(airportIcao, callSign)` pattern as GroundMapWindow. Selection syncs across both map windows for the same airport.

**Help overlay:** A `?` button in the control sidebar opens a context-sensitive `MapHelpOverlay` (type `"air"` or `"ground"`) that documents all knobs, toggle buttons, and interactions with interactive inline button visuals. Closes on Escape key or background click.

## FlightStripsWindow (`src/components/MapWindows/FlightStripsWindow.jsx`)

**Purpose:** Live flight progress strips organized by controller seat (RAMP, GROUND, TOWER, DEPARTURE, APPROACH, DELIVERY, APRON), with drag-to-reorder and cross-window selection sync.

**Layout:** Horizontal row of columns with a bottom bar: sim clock + game speed multiplier (×1/×2 from UDP `timeScale`), refresh, help. Runway separator bars have solid black (`#000`) background. i18n: strips use hardcoded English only (seat labels, headers, runway separators never translated); help overlay has full i18n.

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

**Telemetry status styling (v1.1.6):**
- `telemetryStatus` from UDP v2 records (offset 23) drives CSS modifier classes:
  - `2` (ActionRequired) → `strip-telemetry-action-required` — muted border via `color-mix(in srgb, var(--orange/blue) 50%, #000)`
  - `3` (HandoffPending) → `strip-telemetry-handoff-pending` — channel box gets `var(--accent)` border + `var(--accent-dim)` background
  - `4` (PendingAtStand) → `strip-telemetry-pending-stand` — same channel box highlight
- Combined with `.strip-selected` for selected aircraft with active telemetry status
- Applied to both the real strip and the drag ghost via `TELEMETRY_STRIP_CLASS` constant

**Route history (v1.1.6):**
- `routeHistory` state: `{ callsign: [{ text, struck }] }` — tracks taxiway/airway changes
- `prevRouteRef` stores last-seen route per callsign for change detection
- On route change: all previous lines marked `struck: true` (struck-through CSS), new line appended unstruck
- Max 4 lines per callsign (`slice(-4)`)
- Rendered in `.strip-col-route` as stacked `<span>` elements; struck lines get `.strip-route-struck` (line-through + 45% opacity)

**Selection sync:**
- Click toggles; broadcasts via `select-aircraft-in-map` → `broadcastSelectedAircraft()` sends to ground + air + strips
- Selected strips scale up (1.20×) with solid backdrop (`#2a1a05` arr / `#0a1a2a` dep)
- **Dynamic transform-origin (v1.1.6):** `useLayoutEffect` in `FlightStripContent` computes per-strip `transformOrigin` based on viewport edge detection, preventing the 1.20× scaled strip from overflowing the window. Grows away from overflowing edges (e.g., if right edge overflows → `originX = 'right'`).
- `selectedCallSignRef` keeps stable `handleDragEnd` in sync for correct toggle/deselect IPC

**Drag reorder (v1.1.6 — runway-group constrained):**
- Long-press (400ms) enters drag mode
- **Runway-group constraint:** Drag targets are validated against the source strip's runway group. `runwayRanges` (memoized per seat) maps each runway → `{ start, end }` flat indices. A drop is only valid if `hoverIdx` falls within the source runway's range, at `end+1` (end of group), or at the very end when source is the last group.
- Invalid targets (cross-runway drops) snap back immediately (no animation, selection cleared)
- Valid drops trigger `isDropping` state → drop animation plays → selection cleared on animation end
- **Drop animation (v1.1.6):** Double-rAF waits for React re-render with new strip order, then animates ghost from mouse position to the strip's new DOM position. Ghost gets `.strip-dropping` class: `transition: top 0.22s, left 0.22s, transform 0.22s, opacity 0.18s` — scales to 1.0, fades to opacity 0. Falls back to 400ms timeout if `transitionend` doesn't fire. Cleanup: cancels rAF frames, removes class.
- Pixel-level ghost tracking via direct DOM (`ghostRef`) — no React re-render; only `hoverIdx` changes trigger `setDragState`. Drag metadata in `dragMetaRef` (now includes `srcRunway`).
- Ghost only appears after `hasMoved` is true (not during initial long-press). During drop animation (`isDropping`), ghost is hidden.
- Source position: placeholder shown only when `hoverIdx === srcIdx` (still at source). Once dragged away, placeholder collapses to `null` so other strips push up.
- Target gaps: `.strip-gap-above` (46px margin, within same runway group only), `.strip-sep-gap` (46px margin above runway separator when dropping at end of previous group), `.strip-end-gap` (only when source runway is the last group)
- `applyReorder` flattens runway groups, moves item, rebuilds; keys sorted for stable ordering across UDP updates
- Ghost: fully opaque solid background, `will-change: transform, top, left` GPU hint

**Airport transition auto-reset (v1.1.6):**
- Listens for `udpAirportChanged` flag from `useUdpAircraftState`
- When transitioning to this window's airport: calls `loadFlightData()` + `resetUdpAircraft()`

**Witch mode (v1.1.6):**
- **Activation:** Double-click the help `?` button (300ms timeout between clicks). Single click still opens the help overlay. When exiting witch mode (single click while in witch mode), the help overlay opens.
- **Animation:** 2-frame sprite animation at 500ms per frame via `setInterval` (`witchFrame` toggles 0↔1). Timer is cleaned up on unmount or when witch mode is disabled.
- **Sprite rendering:** Each strip and drag ghost renders an inline `<svg>` (48×48) inside a `.strip-witch-sprite` container (flex, left-aligned, 30px left padding). Same `clipPath` + `<image>` pattern as ground/air maps — loads the assigned sprite sheet, clips to the correct cell, and applies `feDropShadow` glow on selected aircraft only.
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

**Help overlay:** `MapHelpOverlay type="strips" title="Map Help"` — 3 sections: Buttons (Refresh, Help), Display (seat columns, runway separators, arrival/departure colors), Interaction (click to select, deselect, drag reorder). Full i18n (zh + en) for overlay content; `title` prop forces English header.

**IPC handlers:** `open-flight-strips`, `close-flight-strips`, `get-flight-strip-data`.
**Preload additions:** `openFlightStrips`, `closeFlightStrips`, `getFlightStripData`.

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
- `udpAirportChanged` (v1.1.6): true for exactly one render when the UDP airport code transitions from one valid code to a different one. Uses `useRef` to track `prevAirportRef` across renders. Map windows use this to auto-reset aircraft state + reload data when the user switches airports in-game.
- Used by GroundMapWindow, AirMapWindow, and FlightStripsWindow (simTimeUnixMs drives the SimClock component)

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
| `toolbar_surface_radar` | 场面雷达 | Surface Radar |
| `toolbar_approach_radar` | 进近雷达 | Approach Radar |
| `toolbar_flight_strips` | 进程单 | Flight Strips |
| `air_map_bg` | Map | Map |
| `air_map_airspace` | Airspace | Airspace |
| `air_map_runway_ext` | ILS | ILS |
| `air_map_labels` | Label | Label |
| `air_map_star` | STAR | STAR |
| `air_map_sid` | SID | SID |
| `air_map_appr` | APPR | APPR |
| `ground_map_taxiway` | Label | Label |
| `ground_map_show_all` | Parked | Parked |
| `map_refresh` | Refresh | Refresh |
| `knob_zoom` | Range | Range |
| `knob_pan_h` | E-W | E-W |
| `air_map_runways` | Runway | Runway |
| `map_help_air_runways` | (generic help) | (generic help) |
| `map_help_air_arr` | 显示/隐藏进港航班标签 | Show/hide arrival aircraft labels |
| `map_help_air_dep` | 显示/隐藏离港航班标签 | Show/hide departure aircraft labels |
| `map_help_air_rwy_desc` | 显示/隐藏RWY{rwy}的STAR/SID/进近程序路径 | Show/hide STAR/SID/APPR paths for RWY{rwy} |
| `knob_pan_v` | S-N | S-N |
| `map_help_title` | 功能指南 | Map Help |
| `map_help_air_knobs_heading` | 旋钮 | Knobs |
| `map_help_air_toggles_heading` | 按钮 | Buttons |
| `map_help_air_interact_heading` | 交互 | Interaction |
| `map_help_ground_knobs_heading` | 旋钮 | Knobs |
| `map_help_ground_toggles_heading` | 按钮 | Buttons |
| `map_help_ground_interact_heading` | 交互 | Interaction |
| `map_help_strips_buttons_heading` | 按钮 | Buttons |
| `map_help_strips_interact_heading` | 交互 | Interaction |
| `flight_strips_loading` | 加载中… | Loading… |
| `flight_strips_waiting` | 等待数据… | Waiting for data… |
| `flight_strips_empty` | 无活跃飞机 | No active aircraft |
| `flight_strips_runway` | 跑道 | RUNWAY |
| `seat_1`–`seat_7` | RMP/GND/TWR/DEP/APPR/DEL/APN | RMP/GND/TWR/DEP/APPR/DEL/APN |
| `seat_1_full`–`seat_7_full` | RAMP/GROUND/TOWER/DEPARTURE/APPROACH/DELIVERY/APRON | RAMP/GROUND/TOWER/DEPARTURE/APPROACH/DELIVERY/APRON |

## New Constants

- **`AIR_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for approach radar background image (renamed from `STAR_BG_OFFSETS`). Fields: `dx`/`dy` (fine-tune position offset), `w` (image width in viewBox units when height=3000), `bg` (color outside map image), `bgUnder` (color behind semi-transparent image). Entries for ZSJN and KJFK. Witch mode uses separate `WITCH_MAP_BG_OFFSETS`.
- **`NM_TO_GU`** (`src/utils/constants.js`): Nautical mile to game-units conversion (18.52 = 1852m ÷ 100 m/unit). Used by AirMapWindow for runway extension lines, tick marks, and range rings.
- **`AIR_MAP_DEFAULT_ZOOM`** / **`GROUND_MAP_DEFAULT_ZOOM`** (`src/utils/constants.js`): Per-airport default zoom scale. 1.0 = full dataBounds, <1 = tighter initial view. Entries for ZSJN (0.75 ground) and KJFK (1.0 both).
- **`GROUND_RADAR_STAND_PROXIMITY`** (`src/utils/constants.js`): Max distance (0.5 GU ≈ 50m) from aircraft position to its assigned stand midpoint to consider it "parked at stand." Used by GroundMapWindow to hide inactive aircraft.
- **`GROUND_MAP_CENTER_OFFSET`** (`src/utils/constants.js`): Per-airport viewBox center offset in game units (`{x, z}`). Used by GroundMapWindow to fine-tune initial camera position. Entries for ZSJN and KJFK.
- **`GROUND_MAP_TAXIWAY_LABEL_SPACING`** (`src/utils/constants.js`): Minimum distance (10.0 GU) between same-name taxiway labels to prevent label clutter. Used by GroundMapWindow for proximity dedup.
- **`GROUND_MAP_STAND_ACCESS_WIDTH_MULT`** (`src/utils/constants.js`): Multiplier (1.0) for stand-access taxiway line width. Stand-access segments are rendered with square linecaps for differentiated styling. Change this to make stand-access stubs visually distinct from main taxiways.
- **`WITCH_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for witch mode map background images (`witch/{ICAO}.png`). Independent of normal mode offsets. Fields: `dx`/`dy` (fine-tune position), `w` (override image width, 0 = use default). Entries for ZSJN and KJFK.

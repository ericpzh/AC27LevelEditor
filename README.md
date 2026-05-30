# AC27 Level Editor

Cross-platform (Windows + macOS) GUI tool for editing **Airport Control 25** `.acl` flight schedule and level files. Built with Electron + Node.js.

## User Flow

1. **Setup** — Select game root folder (with Steam instructions)
2. **Browser** — All `.acl` files across all airports auto-scanned and displayed, grouped by airport. Hidden levels (tutorial/test/demo/bench/endless) are toggleable.
3. **Editor** — Full flight table editor + embedded timeline editors:
   - Dropdown menus per column (values auto-collected per airport: KJFK ≠ ZSJN)
   - Instant inline editing — no per-row save dialog needed
   - Auto-sort: arrivals by LandingTime, departures by OffBlockTime
   - Batch operations: add/delete/copy flights, batch callsign assignment
   - Search + arrival/departure filter via toolbar
   - **Timeline editors**: Weather presets, Wind direction/speed, Runway usage — editable in collapsible panels within the flight tab

### Save Flow
- **Save** (Ctrl+S) — triple validation (options legality → time range → runway set), then writes `.acl` + `.csv` + timeline `.json` files, creating `.bak` backups automatically
- **Save As** — write to any location
- **Import** — load external `.acl` to override current level
- **CSV Export/Import** — export flights to generic CSV, or bulk-import from CSV into a `.acl` template
- **Backup/Restore** — manual backup to any location, restore latest `.bak` chain (`.acl` + `.csv` + timeline `.json`)

## Data Flow

```
Phase 0 (Setup, once):
  Game Root → scan all CSVs per airport → load audio_clips en+zh → AirportCache

Phase 1 (Load):
  .acl file → parse flights (FlightSchedule or WorldState.FlightPlans)
           → load .aclcfg config (time bounds, airport code, sceneries)
           → load timeline JSONs (weather, wind, runway)
           → collect per-airport dropdown values (ACL + CSV + audio merge)
           → appState

Phase 3 (Save):
  Edit → triple validation → .bak backup → write .acl + .csv + timeline .json
```

## ACL File Format

`.acl` files use Newtonsoft.Json serialization with `$type` and `$rcontent`. The editor supports **two input formats**:

| Format | Section | Description |
|--------|---------|-------------|
| Legacy | `FlightSchedule` | Array of `FlightPlanState` entries with time ticks |
| Current | `WorldState.FlightPlans` | Dictionary of keyed `FlightPlanState` entries, each containing either an `Arrival` or `Departure` leg |

Save always produces the same format as the original file. Flight data fields:

| Field | Type | Description |
|-------|------|-------------|
| CallSign | string | Flight callsign (e.g. CCA0001) |
| DepartureAirport | string | ICAO departure |
| ArrivalAirport | string | ICAO arrival |
| Stand | string | Gate/stand number |
| Runway | string | Runway identifier |
| OffBlockTime | ticks/HH:MM:SS | Pushback time |
| TakeoffTime | ticks/HH:MM:SS | Takeoff time |
| LandingTime | ticks/HH:MM:SS | Landing time |
| InBlockTime | ticks/HH:MM:SS | Gate arrival time |
| AirlineName | string | Airline code |
| AircraftType | string | Aircraft model |
| Voice | string | Voice profile (from audio_clips) |
| Language | string | en / zh |

## Project Structure

```
├── main.js              # Electron main process + all IPC handlers
├── preload.js           # Secure contextBridge IPC layer
├── build.js             # Electron-builder build script
├── package.json
├── src/
│   ├── acl_parser.js    # Core: ACL read/write, FlightPlans/WorldState sync, CSV import/export, audio callsign loading
│   ├── acl_scanner.js   # Game root scanner (discovers airports & .acl files)
│   ├── renderer.js      # All UI logic (3-screen state machine, cell editing, validation, timeline editors)
│   ├── index.html       # 3-screen SPA shell (Setup / Browser / Editor)
│   ├── style.css        # Dark theme styles
│   └── logger.js        # File-based logging (dev mode)
├── test/
│   ├── e2e_save_load.js         # End-to-end round-trip: load → save → load → compare
│   ├── parse_airport.js         # Smoke test: parse all airports, validate field coverage
│   ├── csv_vs_flightplans.js    # Cross-check CSV imports against ACL FlightPlans entries
│   ├── callsign_gen_test.js     # Verify CallSign prefixes match airline ICAO codes
│   └── timeline_comparison.js   # Compare JSON timeline files against ACL-embedded data
└── dist/                # Build output (AC27 Level Editor.exe)
```

## Development

```bash
npm install
npm start
```

## Tests

```bash
node test/parse_airport.js              # Parse all airports, check field coverage
node test/callsign_gen_test.js          # Validate CallSign → ICAO consistency
node test/csv_vs_flightplans.js         # CSV ↔ ACL FlightPlans cross-check
node test/e2e_save_load.js              # Full save/load round-trip test
node test/timeline_comparison.js <acl>  # Compare ACL timelines vs JSON files
```

## Build

### Prerequisites (Windows — first time only)

The `winCodeSign` cache contains broken macOS symlinks (`libcrypto.dylib` / `libssl.dylib` are 0 bytes).
Run this once after the first build attempt fails:

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

### Build (Windows portable)

**Always use `build.js`**, never `npm run build:win` — the latter gets killed mid-way by PowerShell's watch-mode detection.

1. Close any running instance of the editor:
   ```powershell
   Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
   ```

2. Clean `dist/`:
   ```powershell
   Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
   ```

3. Run the build:
   ```bash
   node build.js
   ```

Output: `dist\AC27 Level Editor.exe` (~180 MB portable executable).

If the build fails with file-locking errors, try disabling real-time antivirus or reboot before building.

### Icon notes

- Edit `icon.png` (512×512 PNG), then regenerate `icon.ico`:
  ```bash
  node -e "const p=require('png-to-ico').default;require('fs').writeFileSync('icon.ico',await p('icon.png',[256,128,64,48,32,16]))"
  ```

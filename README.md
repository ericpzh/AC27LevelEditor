# AC27 Level Editor

Cross-platform (Windows + macOS) GUI tool for editing **Airport Control 25** `.acl` flight schedule files. Built with Electron.

## User Flow

1. **Setup** — Select game root folder (with Steam instructions)
2. **Browser** — All `.acl` files across all airports auto-scanned and displayed, grouped by airport
3. **Editor** — Full table editor with:
   - Dropdown menus per column (values auto-collected per airport: KJFK ≠ ZSJN)
   - Instant editing — no per-row save needed
   - Auto-sort: arrivals by LandingTime, departures by OffBlockTime
   - Batch operations: callsign, voice, language
   - Search + arrival/departure filter

### Save Flow
- **Save** (Ctrl+S) → auto-generates `filename_backup_YYYY-MM-DDTHH-MM-SS.acl` before writing
- **Backup** → manual backup to any location
- **Import** → load external `.acl` to override current
- **Save As** → write to any location

## Development

```bash
npm install
npm start
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

> **Important:** `npm run build:win` (`npx electron-builder`) does **not** work in PowerShell — the watch mode kills the builder process mid-way.

Use `build.js` instead:

```bash
node build.js
```

The output `.exe` will be in the `dist/` folder.

### Icon notes

- Edit `icon.png` (512×512 PNG), then regenerate `icon.ico`:
  ```bash
  node -e "const p=require('png-to-ico').default;require('fs').writeFileSync('icon.ico',await p('icon.png',[256,128,64,48,32,16]))"
  ```
- Both `package.json` and `build.js` reference `icon.ico` (the proper Windows format).

## Project Structure

```
├── main.js           # Electron main process + all IPC handlers
├── preload.js        # Secure IPC bridge
├── src/
│   ├── acl_parser.js # .acl file parser (read/write/collect values)
│   ├── acl_scanner.js# Game root scanner (discovers airports & .acl files)
│   ├── index.html    # 3-screen UI shell
│   ├── style.css     # Dark theme styles
│   └── renderer.js   # All UI logic (3-screen state machine)
└── package.json
```

## File Format

`.acl` files use Newtonsoft.Json serialization with `$type` and `$rcontent`. Each file contains a `FlightSchedule` object with an array of `FlightPlanState` entries:

| Field | Type | Description |
|-------|------|-------------|
| CallSign | string | Flight callsign (e.g. CCA0001) |
| DepartureAirport | string | ICAO departure |
| ArrivalAirport | string | ICAO arrival |
| Stand | string | Gate/stand number |
| Runway | string | Runway identifier |
| OffBlockTime | ticks | Pushback time |
| TakeoffTime | ticks | Takeoff time |
| LandingTime | ticks | Landing time |
| InBlockTime | ticks | Gate arrival time |
| AirlineName | string | Airline code |
| AircraftType | string | Aircraft model |
| Voice | string | Voice profile |
| Language | string | Language code |

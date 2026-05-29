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

```bash
npm run build:win    # Windows .exe (portable)
npm run build:mac    # macOS .dmg
npm run build:all    # Both
```

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

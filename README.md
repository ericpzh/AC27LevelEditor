# AC27 Level Editor

GUI tool for editing Airport Control 25 `.acl` flight schedule files.

## Features

- Open/save `.acl` level files
- Editable table with 13 flight fields (callsign, airport, stand, runway, times, airline, aircraft type, voice, language)
- Filter by arrival/departure with color-coded rows
- Real-time search across all fields
- Right-click context menu (add, delete, duplicate, move up/down)
- Batch operations: generate callsigns, set voice/language
- CSV import/export (append or replace mode)
- Column sorting

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run
python main.py
```

## Build .exe

```bash
# Option 1: Using build.bat
build.bat

# Option 2: Using PyInstaller directly
pyinstaller --onefile --windowed --name "AC25_Level_Editor" main.py
```

Output: `dist/AC25_Level_Editor.exe`

## File Structure

```
AC27LevelEditor/
├── main.py              # Entry point
├── editor_gui.py        # Tkinter GUI
├── acl_parser.py        # .acl file parser (Newtonsoft.Json format)
├── test_parser.py       # Unit tests for parser
├── requirements.txt     # Python dependencies
├── build.bat            # PyInstaller build script
├── AC25_Level_Editor.spec  # PyInstaller spec
├── .gitignore
└── README.md
```

## ACL Format

The game uses `.acl` files with Newtonsoft.Json serialization (`$type`, `$rcontent`).
The parser extracts `FlightPlanState` entries from `FlightSchedule.$rcontent` arrays
using regex-based parsing to handle non-standard JSON quirks.

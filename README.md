# AC27 Level Editor (Electron)

Cross-platform GUI tool for editing Airport Control 25 `.acl` flight schedule files.

Built with **Electron** — runs on **Windows & macOS**.

## Features

- Open/save `.acl` level files with Newtonsoft.Json format
- Editable table: 13 fields (callsign, airports, stand, runway, times, airline, aircraft, voice, language)
- Color-coded rows: green = arrival, blue = departure
- Multi-select, inline cell editing, sorting
- Search across all fields, filter by flight type
- Right-click context menu (add, delete, duplicate, move)
- **Batch operations**: generate callsigns, set voice/language
- **CSV import/export** (append or replace)
- Keyboard shortcuts: `Ctrl+O` open, `Ctrl+S` save, `Ctrl+N` add, `Del` delete

## Quick Start

```bash
npm install
npm start
```

## Build Standalone Executables

```bash
# Windows (.exe)
npm run build:win

# macOS (.dmg)
npm run build:mac

# Both
npm run build:all
```

Output: `dist/AC27 Level Editor.exe` (Win) or `dist/AC27 Level Editor.dmg` (Mac)

## Project Structure

```
AC27LevelEditor/
├── package.json          # Electron + electron-builder config
├── main.js               # Electron main process
├── preload.js            # Secure IPC bridge
├── src/
│   ├── index.html        # UI shell
│   ├── style.css         # Dark theme styles
│   ├── renderer.js       # Frontend logic
│   └── acl_parser.js     # .acl parser (Node.js)
├── .gitignore
└── README.md
```

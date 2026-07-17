# AC27 Editor

Cross-platform desktop level editor for **Airport Control 27** `.acl` flight schedule files. Built with **Electron 33 + React 19 + Vite 8 + zustand 5**.

[**👇中文**](#chinese)

<img src="public\Screen.png" alt="Screenshot" width="100%"/>

---

# User Guide

<a id="english"></a>

### [Download](https://github.com/ericpzh/AC27LevelEditor/releases)

 On first launch, [Windows Defender](#windowsdefinder) will likely block it (expected — the EXE is unsigned). Once past that, select the game root folder:
- Default Steam path: `...\SteamLibrary\steamapps\common\Airport Control 27 Demo`
- The editor auto-scans all airports and their level files

### Restore Game Files

If the editor corrupts level files, Steam can restore the originals:

1. **Delete all files** under the `Levels\` folder(s) you've edited, e.g.:
   `…\Airport Control 27 Demo\Airports\ZSJN\Levels\*`
2. Steam library → right-click **Airport Control 27 Demo** → **Properties**
3. **Installed Files** → **Verify integrity of game files**
4. Steam re-downloads the original level files

### Replace Main Menu Background

Use any video file (.mp4, .mov, .avi, etc.) as the main menu background:

1. In the browser screen header, click **Background** (video camera icon)
2. A confirmation dialog appears with two options:
   - **Replace Video** — select your source video file; the editor automatically converts it to VP8 WebM and replaces all airport backgrounds
   - **Restore Original** — one-click restore from `.bak` backup (greyed out if no backup exists)
3. The editor automatically converts the video to VP8 WebM and replaces all airport backgrounds

**Backup:** Before replacing, the editor backs up the current videos to `.bak` folders (e.g., `KJFK.webm.bak/`). Use the **Restore Original** button to revert.

**Requires:** ffmpeg (bundled with the editor — no separate install needed).

### Debug Mode (BepInEx)

Enable in-game debugging by installing BepInEx (IL2CPP) with one click:

1. In the browser screen header, click **Debug Mode** (code icon `</>`)
2. The editor automatically downloads the latest BepInEx IL2CPP build and installs it into the game root
3. Toggle OFF to remove BepInEx files — the game returns to normal

**Requirements:** Internet connection (for download only). Windows only.

### Install Realistic Aircraft Livery

Replace default aircraft liveries with realistic paint schemes via ZIP file:

1. Download the livery ZIP file (e.g., `AC27 Realistic Aircraft Livery v26.06.0.zip`)
2. In the browser screen header, click **Livery** (palette icon)
3. Select the downloaded ZIP file in the file dialog
4. The editor extracts the contents to the game's `Mods/` folder automatically

**Note:** If the `Mods/` folder does not exist in the game root, the editor creates it automatically.

### Auto-Update (Windows)

The editor checks for new versions on startup and offers a one-click update when a newer build is available:

1. On launch, the editor sends a lightweight HEAD request to check for a newer build
2. If a new version is detected, a dialog appears with the update prompt
3. Click **Download & Install** — the editor downloads the latest `.exe` and replaces itself
4. The old `.exe` is renamed to `.old` as a safety fallback
5. Click **Skip This Version** to dismiss the prompt until the next release

**How it works:** The editor compares the MD5 hash of the running `.exe` against the ETag of the latest build on Cloudflare R2. If they differ, an update is available. No `version.json` needed — the comparison uses R2's built-in object metadata.

**macOS:** Auto-update is Windows-only (`.exe` portable build). macOS DMG builds are not affected.

### Clear Editor Local Cache

The editor stores data under `%APPDATA%\ac27-level-editor\`. Delete the entire folder to reset the editor to its initial state (startup issues, wrong game directory, etc.):

<a id="windowsdefinder"></a>

### Windows Defender / SmartScreen Popup

The editor is an unsigned Electron app. On first run, Windows shows a **"Windows protected your PC"** warning:

1. Click **More info**
2. Click **Run anyway**
3. The warning won't appear on subsequent launches

---

<a id="chinese"></a>

### [下载](https://github.com/ericpzh/AC27LevelEditor/releases)

首次运行时 [Windows Defender](#windowsdefinderzh) 大概率会拦截（正常现象 — EXE 未做代码签名）。允许运行后选择游戏根目录：
- Playtest 默认路径：`...\SteamLibrary\steamapps\common\Airport Control 27 Playtest`
- Demo 默认路径：`...\SteamLibrary\steamapps\common\Airport Control 27 Demo`

### 恢复游戏文件（Steam 验证完整性）

如果编辑器保存出错导致游戏关卡文件损坏，可通过 Steam 恢复原始文件：

1. **先删除**你所编辑关卡对应的 `Levels\` 文件夹下的所有文件，例如：
   `…\Airport Control 27 Playtest\Airports\ZSJN\Levels\*`
2. Steam 库中右键 **Airport Control 27 Playtest** 或 **Airport Control 27 Demo** → **属性**
3. **已安装文件** → **验证游戏文件的完整性**
4. Steam 会重新下载原始关卡文件

### 替换主菜单背景

使用任意视频文件（.mp4、.mov、.avi 等）替换主菜单背景视频：

1. 在浏览器界面顶栏中，点击 **背景动画**（摄像机图标）
2. 弹出确认对话框，提供两个选项：
   - **替换背景动画** — 选择你的视频文件，编辑器自动转换为 VP8 WebM 格式并替换所有机场的背景视频
   - **还原备份** — 一键从 `.bak` 备份还原（若无备份则灰色不可用）
3. 编辑器自动将视频转换为 VP8 WebM 格式，并替换所有机场的背景视频

**备份：** 替换前，编辑器会将当前视频备份到 `.bak` 文件夹（例如 `KJFK.webm.bak/`）。使用 **还原备份** 按钮即可一键恢复。

**依赖：** ffmpeg（已随编辑器打包，无需单独安装）。

### 安装真实飞机涂装

通过 ZIP 文件一键安装真实飞机涂装：

1. 下载涂装 ZIP 文件（例如 `AC27 Realistic Aircraft Livery v26.06.0.zip`）
2. 在浏览器界面顶栏中，点击 **涂装**（调色板图标）
3. 在弹出的文件选择对话框中选择下载的 ZIP 文件
4. 编辑器自动将内容解压到游戏根目录下的 `Mods/` 文件夹

**注意：** 如果 `Mods/` 文件夹不存在，编辑器会自动创建。

### 清理编辑器本地缓存

编辑器在 `%APPDATA%\ac27-level-editor\` 下存储缓存文件。 如果编辑器启动异常或选择了错误的游戏目录后无法重置，删除整个文件夹即可恢复初始状态。

<a id="windowsdefinderzh"></a>

### Windows Defender / SmartScreen 弹窗

编辑器使用 Electron 打包，未做代码签名。首次运行时 Windows 会弹出 **"Windows 已保护你的电脑"** 警告：

1. 点击 **更多信息**
2. 点击 **仍要运行**
3. 后续运行将不再提示

---

# Developer Documentation

## English

### Tech Stack

- **Version:** v1.2.2
- **Runtime:** Electron 33
- **Frontend:** React 19 + Vite 8 + zustand 5
- **Language:** JavaScript (plain, no TypeScript)
- **Build:** electron-builder (programmatic API via `build.js`)
- **Tests:** Vitest (482 tests, 29 files) + Playwright (E2E) + Node.js (integration, 22 scripts, 129 MCP/API tests)
- **Tests:** Vitest (482 tests, 29 files) + Playwright (E2E) + Node.js (integration, 22 scripts, 129 MCP/API tests)

### Quick Start

```bash
npm install
npm start          # Launch in dev mode (no build step needed)
```

### Architecture (High-Level)

```
electron/main.js     →  Electron main process, 65 IPC handlers, file I/O, map window management, video background replacer, BepInEx debug mode, livery download & install, auto-update check & install
electron/preload.js  →  contextBridge: exposes 68 methods on window.electronAPI
electron/updater.js  →  Auto-update: HEAD check (R2 ETag), MD5 comparison, exe download, batch script generation
electron/api-server.js →  HTTP API + MCP server (port 31415, auto-starts with app, 7 tools)
electron/bepinex.js     →  BepInEx debug mode — download, install, uninstall (IL2CPP bleeding edge)
electron/udp_listener.js →  UDP telemetry engine (10 Hz aircraft state v2: simFlags, timeScale, heartbeatSeq, auto-reset)
mcp/bridge.js        →  MCP stdio↔HTTP bridge (launched by Claude Code for AI agent control)
index.html           →  Vite HTML entry, loads src/main.jsx
src/main.jsx         →  React entry: ReactDOM.createRoot → <App />
src/App.jsx          →  Root component: providers + screen routing (+ map window routing + MCP store listener)
src/components/      →  React component tree (Setup, Browser, Editor, common, MapWindows)
src/hooks/           →  Custom React hooks (useTranslation, useEditorShell, etc.)
src/store/           →  zustand store (single source of truth for all UI state)
src/acl/             →  CommonJS backend modules (parser facade + 13 modules)
src/utils/           →  Shared utilities (ESM for frontend + CJS for backend)
```

The app has three screens managed by React component rendering: **Setup → Browser → Editor**. Three additional window types — **Surface Radar**, **Approach Radar**, and **Flight Strips** — open as separate Electron windows. Surface/Approach Radar show live aircraft positions from the game's UDP telemetry stream (v2 protocol with simFlags/timeScale/heartbeatSeq). Aircraft state auto-resets on 5s stale timeout or game level change (hasLevel 0→1 transition). Flight Strips display live progress strips sorted by controller seat (RAMP→GRO→TWR→DEP→APPR→DEL→APN) with drag-to-reorder, game speed multiplier display (×1/×2 from timeScale), cross-window selection sync, and push-to-talk voice command input (planned, UI hidden). Double-click the Label button on either radar to toggle **witch mode** — replaces aircraft with animated sprites from 15 round-robin character sheets (1536×768, 3×6 grid of 256×256 cells, clipped via nested SVG with `clipPath`). Active (click-selected) aircraft get a white silhouette glow via `feDropShadow`; any click exits witch mode.

All file I/O goes through IPC (`ipcMain.handle` / `ipcRenderer.invoke`). The renderer never touches the filesystem directly.

### Data Flow

```
Phase 0 (once):   Game Root → scan audio + approach data + taxiway/SID/missed-app paths (merged from all .acl files) + dropdowns + runway pairs → AirportCache. Progress bar shows global 0–100% across all airports/files.
Phase 1 (load):   .acl (single source of truth) → parse flights + timelines → zustand store
Phase 2 (edit):   All edits go through zustand store actions
Phase 3 (save):   Validation → generate AircraftStates for approach flights → write .acl + .csv + timeline .json (game compat)
UDP (live):       Game → UDP 20266 (10 Hz) → udp_listener.js → map windows (Surface Radar / Approach Radar / Flight Strips)
MCP (AI agent):   Claude Code → stdio → mcp/bridge.js → HTTP :31415 → api-server.js → IPC → store → UI
```

### MCP / AI Agent Integration

The editor includes a built-in MCP (Model Context Protocol) server that allows AI agents like Claude Code to control the editor — create, read, modify, and delete flights via natural language. The API server auto-starts on `127.0.0.1:31415` when the app opens.

**Setup (one time):**

1. Download the MCP skill file: [`.claude/skills/ac27-editor-mcp/SKILL.md`](https://github.com/ericpzh/AC27LevelEditor/blob/master/.claude/skills/ac27-editor-mcp/SKILL.md)
   - Place it at: `%USERPROFILE%\.claude\skills\ac27-editor-mcp\SKILL.md` (Windows) or `~/.claude/skills/ac27-editor-mcp/SKILL.md` (macOS)
   - This teaches Claude Code the flight data model, airline codes, Chinese support, validation rules, and composition patterns

2. Add `.mcp.json` to your project root (or wherever you keep `.acl` files):
```json
{
  "mcpServers": {
    "ac27-editor": {
      "command": "node",
      "args": ["mcp/bridge.js"]
    }
  }
}
```
   - If you cloned the repo, `mcp/bridge.js` is already there
   - If using the packaged `.exe`, download [`mcp/bridge.js`](https://github.com/ericpzh/AC27LevelEditor/blob/master/mcp/bridge.js) and place it next to your `.mcp.json`

3. Make sure Node.js is installed (the bridge is a tiny Node.js script — requires Node 18+)

**7 MCP tools:** `create_flights`, `get_flights`, `modify_flights`, `delete_flights`, `get_editor_status`, `get_airport_info`, `get_validation_issues`. Supports English and Chinese (中文).

**Testing:**
```bash
node tests/integration/test_api_server.js           # API + MCP protocol (85 tests)
node tests/integration/test_api_e2e_examples.js     # Composition examples (44 tests)
```

### Project Structure

```
├── electron/
│   ├── main.js              # Electron main process + 65 IPC handlers
│   ├── preload.js           # contextBridge (window.electronAPI, 68 methods)
│   ├── updater.js           # Auto-update: HEAD check, MD5, download, batch script
│   ├── bepinex.js           # BepInEx debug mode — one-click install/uninstall
│   └── udp_listener.js      # UDP telemetry — 10 Hz aircraft state + commands
├── index.html               # Vite HTML entry
├── vite.config.js           # Vite 8 + React plugin + Electron plugin
├── build.js                 # Build script (always use this, never npm run build:win)
├── set_icon.js              # Post-build icon embedding
│
├── src/
│   ├── main.jsx             # React entry point (createRoot)
│   ├── App.jsx              # Root component: providers + screen router
│   ├── style.css            # Global dark theme CSS variables + reset
│   │
│   ├── components/
│   │   ├── SetupScreen/         # Game root directory picker
│   │   ├── BrowserScreen/       # Airport & level browser
│   │   ├── EditorScreen/        # Main editor: table + timelines
│   │   │   ├── FlightTable/     # Sortable flight table with inline editing
│   │   │   ├── CellEditor/      # SVG clock & compass popovers
│   │   │   ├── StandMap/        # Interactive stand position map overlay
│   │   │   ├── StarMap/         # Interactive STAR/approach chart overlay
│   │   │   └── TimelineEditors/ # Weather, Wind, Runway editors
│   │   ├── MapWindows/          # Full-window map visualizations (separate windows)
│   │   │   ├── GroundMapWindow.jsx + .css  # Surface radar: taxiways, runways, areas, ground aircraft, help overlay
│   │   │   ├── AirMapWindow.jsx + .css     # Approach radar: STAR/SID/APPR routes, runway extensions, range rings, border overlay, help overlay
│   │   │   ├── FlightStripsWindow.jsx + .css  # Flight strips: seat-sorted strips with drag reorder, selection sync, help overlay
│   │   │   ├── ControlSidebar.jsx + .css   # Vertical sidebar: spin knobs + push-button toggles + help button
│   │   │   ├── SpinKnob.jsx + .css         # Rotary encoder knob (click-drag + scroll-wheel)
│   │   │   ├── SimClock.jsx                # Shared sim-time clock (HH:MM:SS UTC)
│   │   │   ├── MapHelpOverlay.jsx + .css   # Context-sensitive help overlay (air/ground/strips, optional title prop)
│   │   │   ├── MapShared.css               # Shared styles: toggle buttons, clock, help button, animations
│   │   │   ├── useSvgZoom.js               # Scroll-zoom + drag-pan SVG hook (clamped, imperative API)
│   │   │   ├── useUdpAircraftState.js      # Hook subscribing to live UDP state pushes
│   │   │   ├── witchMode.js                # Witch mode: direction mapping + parked detection
│   │   │   ├── commandTree.js              # ATC command definitions for flight strip command bar
│   │   │   ├── voiceNumberParser.js        # Spoken numbers → digits (EN + ZH aviation phraseology)
│   │   │   ├── voiceCallsignParser.js      # Airline name→ICAO + callsign matching against UDP aircraft
│   │   │   ├── voiceCommandMatcher.js      # Fuzzy command matching (aliases, Jaccard, Dice coefficient)
│   │   │   ├── useVoiceCommands.js         # React hook orchestrating full voice pipeline
│   │   │   └── VoicePTTButton.jsx          # Push-to-talk mic button (hold-to-talk, pulse/flash animations)
│   │   └── common/              # Modal, Toast
│   │
│   ├── hooks/               # React custom hooks
│   │   ├── useTranslation.jsx   # I18n Context Provider (zh/en)
│   │   ├── useElectronAPI.jsx   # electronAPI Context Provider
│   │   ├── useEditorShell.jsx   # Keyboard shortcuts
│   │   ├── useKeyboardShortcuts.js  # Generic shortcut registry
│   │   ├── useSaveAcl.jsx       # Save/export/backup logic
│   │   └── useDrag.js          # Shared drag behavior for floating panels
│   │
│   ├── store/
│   │   ├── appStore.js          # zustand store — all app state
│   │   ├── flightDefaults.js    # new flight creation (random airline, cascaded fields, non-conflicting stand)
│   │   └── flightCascade.js     # cascading field updates (CallSign rebuild, airline→type/reg, runway→STAR)
│   │
│   ├── acl/                 # Backend modules (CommonJS)
│   │   ├── parser.js            # FACADE — main.js imports everything through here
│   │   ├── tokenizer.js         # String-aware section boundary scanner
│   │   ├── acl_json.js          # Pre-processor (Unity JSON → valid JSON) + serializer
│   │   ├── acl_document.js      # In-memory document model (lazy parsing, mutation tracking)
│   │   ├── scanner.js           # Game root scanner
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── approach.js         # Approach AircraftState constructor (State=30 & State=5)
│   │   ├── dynamics.js          # Deprecated — calcProgressRatio/buildAircraftEntry stubs
│   │   ├── scenery.js           # SceneryData parser (runway/gate GUIDs)
│   │   ├── taxiway.js           # Taxiway centerline parser (merged from all .acl files, stand-access segments marked)
│   │   ├── sid_goaround.js      # SID + Missed Approach route parser
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/               # Shared utilities (ESM for frontend)
│       ├── constants.js         # Central constants — single source of truth for all app constants
│       ├── timeUtils.js         # Tick↔time conversion + timeline helpers
│       ├── i18n.js              # Chinese/English translation system
│       ├── validators.js        # Save validation logic
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # 390 Vitest + 16 Playwright E2E + 22 Node.js integration tests
└── dist/                # Build output (gitignored)
```

### Coding Conventions

For detailed conventions, see the repo skill (loaded automatically by Claude Code). Quick reference:

- **Backend:** CommonJS (`require`/`module.exports`), `snake_case.js` filenames, `_underscore` = private
- **Frontend:** ESM (`import`/`export`), React components (`PascalCase.jsx`), zustand selectors
- **CSS:** One `.css` file per component, no inline `style={{}}`, CSS custom properties for theming
- **IPC:** All file I/O via `ipcMain.handle` → `preload.js` bridge → `window.electronAPI`
- **Error handling:** Return `{ success: true/false, error?: message }` from all IPC handlers
- **No new dependencies** unless strongly justified — the app uses only Node.js built-ins

### Running Tests

See `tests/README.md` for the full test matrix, expected values, and test infrastructure details.

**Master test runner (all layers):**
```bash
npm run test:all      # Vitest + save integrity (12 files) + Playwright E2E (~3 min, sets E2E_GAME_ROOT)
```

**Component tests (Vitest — 461 tests in 28 files):**
```bash
npm test              # Run all component + store + utility + MapWindow tests (~1s)
npm run test:watch    # Watch mode — re-runs on file changes
```

**E2E tests (Playwright + Electron — 16 tests in 8 files):**
```bash
npm run build         # Build required first (produces dist-electron/main.js)
npm run test:e2e      # UI flow tests against real game data (~3 min)
```

**Demo files:** Save completes but produces a smaller file because the demo save flow strips CurrentDateTime content. Flight data is preserved — verified by the integration test. The 30-min demo window end time is rounded to the nearest 5-minute boundary (:X0 or :X5). Emergency (`_emerg`) files show "Challenge Level" / "挑战关卡" as their time-of-day label instead of dawn/morning/etc.

**Save integrity — all .acl files (Node.js integration — 22 scripts):**

Test every .acl file across all airports for save→reload→compare round-trip:
```bash
# All non-Endless .acl files across all airports:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root>

# 8 production + 4 demo files only:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo
```
Validates flights (all 14 fields), config (startTime/endTime), scenery maps, embedded timelines, and source format for each file.

**Parser module tests (no game root needed):**
```bash
node tests/integration/test_tokenizer.js            # String-aware scanner (18 tests)
node tests/integration/test_acl_json.js             # Pre-processor + serializer round-trips (25 tests)
node tests/integration/test_acl_document.js         # Document model integration (13 tests)
node tests/integration/test_sid_goaround.js         # SID + missed approach route parsers (17 tests)
node tests/integration/test_taxiway.js              # Taxiway centerline parser (10 tests)
```

**UDP telemetry test (mock loopback server, port 20266 must be free):**
```bash
node tests/integration/test_udp_listener.js         # Binary protocol parsing + trail buffer + v2 header + auto-reset (19 tests)
```

**Scan-all (need game root, override with `--root`):**
```bash
node tests/integration/test_parse_airport.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_callsign_gen.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

**Single-ACL (require `--acl <path>`, derive paired files automatically):**
```bash
node tests/integration/test_e2e_save_load.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_sections.js --acl <path>
node tests/integration/test_acl_linkage.js --acl <path>
```

**Timeline (require ACL path, auto-discover JSONs; `--weather`/`--wind`/`--runway` optional):**
```bash
node --require ./tests/integration/preload.cjs tests/integration/test_timeline_comparison.js <acl-path>
node --require ./tests/integration/preload.cjs tests/integration/test_generate_timelines.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_timelines.js --acl <path>
```

### Building

**Always use `build.js`** — `npm run build:win` gets killed by PowerShell's watch-mode detection.

```powershell
# Pre-build cleanup
Stop-Process -Name "AC27 Editor" -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue

# Build
node build.js

# Embed icon (optional)
node set_icon.js
```

Output: `dist\AC27LevelEditor.exe` (~180 MB portable).

**First-time Windows setup** — if the build fails with winCodeSign errors:

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

### CI/CD

The release workflow (`.github/workflows/release.yml`) pushes to `v*` tags triggers **Windows** (portable `.exe`) and **macOS** (`.dmg`) builds in parallel. The Windows build is also uploaded to Cloudflare R2 for auto-update delivery. Both artifacts are attached to a GitHub Release with auto-generated release notes.

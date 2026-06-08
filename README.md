# AC27 Level Editor

Tool for editing **Airport Control 27** level files.

[**👇中文**](#chinese)

<img src="public\Screen.png" alt="Screenshot" width="100%"/>

---

# User Guide

<a id="english"></a>

### [Download](https://github.com/ericpzh/AC27LevelEditor/releases)

 On first launch, [Windows Defender](#windowsdefinder) will likely block it (expected — the EXE is unsigned). Once past that, select the game root folder:
- Default Steam path: `...\SteamLibrary\steamapps\common\Airport Control 27 Demo`
- The editor auto-scans all airports and their level files

### Get the Nightly Game Build

The editor **only works with the nightly build**:

1. In Steam library, right-click **Airport Control 27 Demo** → **Properties** → **Betas**
2. Select the **nigtly** branch from the dropdown
3. Steam will download the update.

### Restore Game Files

If the editor corrupts level files, Steam can restore the originals:

1. **Delete all files** under the `Levels\` folder(s) you've edited, e.g.:
   `…\Airport Control 27 Demo\Airports\ZSJN\Levels\*`
2. Steam library → right-click **Airport Control 27 Demo** → **Properties**
3. **Installed Files** → **Verify integrity of game files**
4. Steam re-downloads the original level files

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

### 获取 Nightly 游戏版本

编辑器 **仅兼容 nightly版本**。如果你只有 Steam 稳定版，需切换到 nightly 分支：

1. 在 Steam 库中右键 **Airport Control 27 Playtest** 或 **Airport Control 27 Demo** → **属性** → **Betas（测试版）**
2. 下拉菜单中选择 **nightly** 分支
3. Steam 会自动下载更新。

### 恢复游戏文件（Steam 验证完整性）

如果编辑器保存出错导致游戏关卡文件损坏，可通过 Steam 恢复原始文件：

1. **先删除**你所编辑关卡对应的 `Levels\` 文件夹下的所有文件，例如：
   `…\Airport Control 27 Playtest\Airports\ZSJN\Levels\*`
2. Steam 库中右键 **Airport Control 27 Playtest** 或 **Airport Control 27 Demo** → **属性**
3. **已安装文件** → **验证游戏文件的完整性**
4. Steam 会重新下载原始关卡文件

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

- **Runtime:** Electron 33
- **Frontend:** React 19 + Vite 8 + zustand 5
- **Language:** JavaScript (plain, no TypeScript)
- **Build:** electron-builder (programmatic API via `build.js`)
- **Tests:** Vitest (component) + Playwright (E2E) + Node.js (integration)

### Quick Start

```bash
npm install
npm start          # Launch in dev mode (no build step needed)
```

### Architecture (High-Level)

```
electron/main.js     →  Electron main process, all IPC handlers, file I/O
electron/preload.js  →  contextBridge: exposes window.electronAPI to renderer
index.html           →  Vite HTML entry, loads src/main.jsx
src/main.jsx         →  React entry: ReactDOM.createRoot → <App />
src/App.jsx          →  Root component: providers + screen routing
src/components/      →  React component tree (Setup, Browser, Editor, common)
src/hooks/           →  Custom React hooks (useTranslation, useEditorShell, etc.)
src/store/           →  zustand store (single source of truth for all UI state)
src/acl/             →  CommonJS backend modules (parser facade + 11 modules)
src/utils/           →  Shared utilities (ESM for frontend + CJS for backend)
```

The app has three screens managed by React component rendering: **Setup → Browser → Editor**.

All file I/O goes through IPC (`ipcMain.handle` / `ipcRenderer.invoke`). The renderer never touches the filesystem directly.

### Data Flow

```
Phase 0 (once):   Game Root → scan audio clips + approach data + dropdown values + runway pairs → AirportCache
Phase 1 (load):   .acl (single source of truth) → parse flights + timelines → zustand store
Phase 2 (edit):   All edits go through zustand store actions
Phase 3 (save):   Validation → generate AircraftStates for approach flights → write .acl + .csv + timeline .json (game compat)
```

### Project Structure

```
├── electron/
│   ├── main.js              # Electron main process + 29 IPC handlers
│   └── preload.js           # contextBridge (window.electronAPI)
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
│   │   │   └── TimelineEditors/ # Weather, Wind, Runway editors
│   │   └── common/              # Modal, Toast
│   │
│   ├── hooks/               # React custom hooks
│   │   ├── useTranslation.jsx   # I18n Context Provider (zh/en)
│   │   ├── useElectronAPI.jsx   # electronAPI Context Provider
│   │   ├── useEditorShell.jsx   # Keyboard shortcuts
│   │   ├── useKeyboardShortcuts.js  # Generic shortcut registry
│   │   └── useSaveAcl.jsx       # Save/export/backup logic
│   │
│   ├── store/
│   │   └── appStore.js      # zustand store — all app state
│   │
│   ├── acl/                 # Backend modules (CommonJS)
│   │   ├── parser.js            # FACADE — main.js imports everything through here
│   │   ├── tokenizer.js         # String-aware section boundary scanner
│   │   ├── acl_json.js          # Pre-processor (Unity JSON → valid JSON) + serializer
│   │   ├── acl_document.js      # In-memory document model (lazy parsing, mutation tracking)
│   │   ├── scanner.js           # Game root scanner
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── approach.js         # Approach AircraftState constructor (State=30)
│   │   ├── dynamics.js          # Deprecated — calcProgressRatio/buildAircraftEntry stubs
│   │   ├── scenery.js           # SceneryData parser (runway/gate GUIDs)
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/               # Shared utilities (ESM for frontend)
│       ├── constants.js         # Field defs, airline codes, getActiveColumns
│       ├── timeUtils.js         # Tick↔time conversion + timeline helpers
│       ├── i18n.js              # Chinese/English translation system
│       ├── validators.js        # Save validation logic
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # Vitest + Playwright + Node.js integration tests
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

**Component tests (Vitest — 101 tests in 9 files):**
```bash
npm test              # Run all component + store + utility tests (~1s)
npm run test:watch    # Watch mode — re-runs on file changes
```

**E2E tests (Playwright + Electron — 16 tests in 8 files):**
```bash
npm run build         # Build required first (produces dist-electron/main.js)
npm run test:e2e      # UI flow tests against real game data (~3 min)
```

**Demo files:** Save completes but produces a smaller file because the demo save flow strips CurrentDateTime content. Flight data is preserved — verified by the integration test.

**Save integrity — all .acl files (Node.js integration — 13 scripts):**

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
Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
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

GitHub Actions workflow (`.github/workflows/release.yml`): pushes to `v*` tags trigger Windows + macOS builds and create a GitHub Release with both artifacts.


# AC27 Level Editor · AC27 关卡编辑器

**《机场管制 27》关卡编辑器** — 用于编辑 `.acl` 航班时刻表文件的跨平台桌面工具。支持完整的航班表格编辑、天气/风向/跑道时间线编辑。

**Airport Control 27 Level Editor** — cross-platform desktop tool for editing `.acl` flight schedule files. Full flight table editor + weather/wind/runway timeline editor.

> ⚠️ **兼容性 Compatibility**: 仅兼容 **Playtest（nightly）** 版本。稳定版使用不同的数据格式。
> Only compatible with the **nightly build (Playtest)**. The stable/release version uses a different data format.

---

# 用户指南 · User Guide

## 中文

### 安装与启动

1. 从 [Releases](../../releases) 下载 `AC27LevelEditor.exe`（Windows 免安装版）
2. 双击运行即可，无需安装

首次启动时需要选择游戏根目录：
- Steam 默认路径：`...\SteamLibrary\steamapps\common\Airport Control 27 Playtest`
- 选择后编辑器会自动扫描所有机场的关卡文件

### 使用流程

**第一步：选择关卡** — 浏览器页面按机场分组显示所有 `.acl` 文件。每个卡片显示关卡时间范围、航班数量等信息。可一键切换隐藏教学/测试关卡。

**第二步：编辑航班** — 进入编辑器后：
- 点击任意单元格即可内联编辑（下拉菜单或文本输入）
- 时间字段点击后弹出 SVG 时钟面板，支持鼠标拖拽和键盘输入
- 到达航班按落地时间排序，出发航班按撤轮挡时间排序
- 工具栏支持搜索、筛选、批量操作

**第三步：保存** — `Ctrl+S` 保存。校验通过后自动创建 `.bak` 备份并写入文件。

### 主要功能

| 功能 | 说明 |
|------|------|
| 航班编辑 | 内联编辑所有字段，下拉值按机场自动收集 |
| 时间线编辑 | 天气预设、风向/风速、跑道使用时段 |
| 保存/另存 | Ctrl+S 保存；另存为 ZIP 打包分享 |
| 导入 | 从 ZIP 或 CSV 导入航班数据 |
| 备份/还原 | 手动备份到任意位置，一键还原最近备份 |

---

## English

### Installation & Launch

1. Download `AC27LevelEditor.exe` from [Releases](../../releases) (Windows portable, no installer)
2. Double-click to run

On first launch, select the game root folder:
- Default Steam path: `...\SteamLibrary\steamapps\common\Airport Control 27 Playtest`
- The editor auto-scans all airports and their level files

### User Flow

**Step 1 — Browse:** All `.acl` files across all airports are listed, grouped by airport. Each card shows time range, flight count, and metadata. Hidden levels (tutorial/test/demo) can be toggled.

**Step 2 — Edit:** Inline editing for every cell:
- Click any cell → dropdown or text input
- Time cells → SVG clock popover (drag hands or type)
- Arrivals auto-sorted by landing time, departures by off-block time
- Toolbar: search, filter, batch operations

**Step 3 — Save:** `Ctrl+S` triggers validation, then writes `.acl` + `.csv` + timeline `.json` files with `.bak` backup.

### Features

| Feature | Description |
|---------|-------------|
| Flight Editor | Inline cell editing, per-airport dropdown values |
| Timeline Editors | Weather presets, wind direction/speed, runway schedule |
| Save / Save As | Ctrl+S to save; export as ZIP bundle |
| Import | Import from ZIP or CSV |
| Backup / Restore | Manual backup, one-click restore from `.bak` chain |

---

# 开发者文档 · Developer Documentation

## English

### Tech Stack

- **Runtime:** Electron 33
- **Frontend:** React 19 + Vite 8 + zustand 5
- **Language:** JavaScript (plain, no TypeScript)
- **Build:** electron-builder (programmatic API via `build.js`)
- **No test framework** — tests are plain Node.js scripts

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
src/acl/             →  CommonJS backend modules (parser facade + 7 modules)
src/utils/           →  Shared utilities (ESM for frontend + CJS for backend)
```

The app has three screens managed by React component rendering: **Setup → Browser → Editor**.

All file I/O goes through IPC (`ipcMain.handle` / `ipcRenderer.invoke`). The renderer never touches the filesystem directly.

### Data Flow

```
Phase 0 (once):   Game Root → scan audio clips → AirportCache
Phase 1 (load):   .acl (single source of truth) → parse flights + timelines → zustand store
Phase 2 (edit):   All edits go through zustand store actions
Phase 3 (save):   Validation → write .acl + .csv + timeline .json (game compat)
```

### Project Structure

```
├── electron/
│   ├── main.js              # Electron main process + ~20 IPC handlers
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
│   │   ├── scanner.js           # Game root scanner
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── dynamics.js          # DynamicParams templates & Aircraft entries
│   │   ├── scenery.js           # SceneryData parser (runway/gate GUIDs)
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/               # Shared utilities (ESM for frontend)
│       ├── constants.js         # Field defs, airline codes, getActiveColumns
│       ├── timeUtils.js         # Tick↔time conversion + timeline helpers
│       ├── i18n.js              # Chinese/English translation system
│       ├── validators.js        # Save validation logic
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV import/export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── test/                # 8 plain Node.js test scripts (no framework)
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

No test framework — each test is a standalone Node.js script. All accept `--help` for usage.

**Scan-all (defaults to `../../../` game root, override with `--root`):**
```bash
node test/test_parse_airport.js [--root <game-root>]
node test/test_callsign_gen.js [--root <game-root>]
```

**Single-ACL (requires `--acl <path>`, derives paired files automatically):**
```bash
node test/test_e2e_save_load.js --acl <path>
node test/test_csv_vs_flightplans.js --acl <path>
node test/test_rebuild_sections.js --acl <path>
```

**Timeline (requires ACL path, auto-discovers JSONs; `--weather`/`--wind`/`--runway` optional):**
```bash
node test/test_timeline_comparison.js <acl-path>
node test/test_generate_timelines.js --acl <path>
node test/test_rebuild_timelines.js --acl <path>
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

---

## 开发者摘要

### 技术栈
- Electron 33，React 19 + Vite 8 + zustand 5，纯 JavaScript（无 TypeScript、无测试框架）
- 后端使用 CommonJS 模块，前端使用 ESM + React 组件
- 所有文件读写通过 Electron IPC，渲染进程不直接访问文件系统

### 快速开始
```bash
npm install
npm start    # 开发模式启动
```

### 运行测试
```bash
node test/test_e2e_save_load.js    # 完整存取往返测试
node test/test_parse_airport.js    # 解析所有机场
# ... 共 8 个测试脚本
```

### 构建
```bash
node build.js    # 输出 dist\AC27LevelEditor.exe
```

> 详细架构、依赖关系图、编码规范请参考 `.claude/skills/ac27-level-editor/SKILL.md`（Claude Code 自动加载）。
> For full architecture, dependency graphs, and coding conventions, see `.claude/skills/ac27-level-editor/SKILL.md` (loaded automatically by Claude Code).

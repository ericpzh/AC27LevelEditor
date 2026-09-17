# AC27 Editor

Cross-platform desktop level editor for **Airport Control 27** `.acl` flight schedule files.

[**👇中文**](#chinese)

<img src="public\Screen.png" alt="Screenshot" width="100%"/>
<img src="public\Radar.png" alt="Screenshot" width="100%"/>
<img src="public\Main.png" alt="Screenshot" width="100%"/>

<img src="public\Livery1.png" alt="Livery" width="49%"/> <img src="public\Livery2.png" alt="Livery" width="49%"/>
<img src="public\Painter1.png" alt="Ground Painter" width="49%"/> <img src="public\Painter2.png" alt="Ground Painter" width="49%"/>

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
2. In the browser screen header, click **Livery** (palette icon) — this opens the **Livery page**
3. Click the **Pack** button in the header bar and wait for the automatic download, or pick a local ZIP in the file dialog fallback
4. The editor extracts the contents to the game's `Mods/` folder automatically

**Note:** If the `Mods/` folder does not exist in the game root, the editor creates it automatically.

### Custom Liveries (Livery Page)
Create and share your own `Body`/`BaseMap` aircraft liveries. The Livery page (browser header → **Livery**) has two views — the livery list and the painter — with every list action in a single header bar:

- **Back** — returns to the browser (from the painter, back returns to the list first).
- **Pack** — the original realistic-livery download/install flow in a dialog.
- **New** — opens the full-page painter: a 2048×2048 **transparent** canvas (brush/eraser/picker/fill/shapes/text/sticker — text and stickers remain selectable floating objects you can move, rotate and flip horizontally/vertically, undo depth 20, no 3D preview). The top bar holds the airline/aircraft plus **Import image** / **Import livery** (ZIP) / **Export livery** / **Save** / **Save As**; the left rail holds the tools; the bottom bar holds zoom. Saving a livery over its own folder via **Save** overwrites silently (no `.bak`); **Save As** — and any Save that is renamed onto another livery's folder — pops a confirm/cancel prompt before overwriting. After a successful save a prompt reminds you to enable the **AC27 Custom Liveries** mod on the in-game "More Liveries" page; tick **Don't show again** to silence it (stored in `cache.json`). Reference liveries are read-only and only offer Save As.
- **Select All**/**Deselect All**, **Export** (single selection), batch **Delete**, and **Find** (filters the list by airline, folder or aircraft).
- The list groups every livery in `<gameRoot>/Mods/AC27 Custom Liveries/` by aircraft type into collapsible folders (reference-pack liveries share the same folders with a lock read-only mark); **click a card to open it in the painter**. Each card carries a selection checkbox pinned over its thumbnail; the header-bar **Export** (needs exactly one selected; saves a shareable ZIP) and **Delete** (one or many, with confirm) act on the selection. Folder names are free-form (filesystem-safe only) and never parsed — the manifest carries the airline/aircraft. The pack root's `mod_info.json` is maintained automatically: it is written on load/create with the **AC27 Custom Liveries** mod name, repairing the copy the official pack ZIP ships (which still names the reference pack).

**Share contract:** Export produces `<FOLDER>.zip` containing `<FOLDER>/aircraft_livery_manifest.json` + `<FOLDER>/base.png`. Send it to a friend — they install it via **Import livery** in the painter, or by unzipping straight into `<gameRoot>/Mods/AC27 Custom Liveries/`.

### Auto-Update (Windows)

The editor checks for new versions on startup and offers a one-click update when a newer build is available:

1. On launch, the editor sends a lightweight HEAD request to check for a newer build
2. If a new version is detected, a dialog appears with the update prompt
3. Click **Download & Install** — the editor downloads the latest `.exe` and replaces itself
4. The old `.exe` is renamed to `.old` as a safety fallback
5. Click **Later** to dismiss the prompt until the next app restart

**How it works:** The editor compares the MD5 hash of the running `.exe` against the ETag of the latest build on Cloudflare R2. If they differ, an update is available. No `version.json` needed — the comparison uses R2's built-in object metadata. The **voice edition** (`AC27EditorVoice.exe`) auto-updates through the **same `/editor` route** — it sends an `X-AC27-Variant: voice` header so the Worker serves its own `.md5` sidecar and exe — so each variant only ever updates onto itself.

**Logging:** Every update decision is logged to both the console and `<userData>/updater.log`, making it possible to diagnose issues in packaged builds with no visible console.

**Dev-mode testing:** By default, `npm start` skips the update check. Opt in with:
- `AC27_UPDATE_DEV_CHECK=1` — auto-discovers a build artifact under the project root
- `AC27_UPDATE_TARGET=<path>` — explicit path to an exe to compare

In dev mode, `installUpdate()` defaults to a dry-run (no `.bat` spawn). Override with `AC27_UPDATE_DRY_RUN=0`.

See `.claude/skills/ac27-editor/references/dev-commands.md` for full env-var reference and mock-server testing.

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
2. 在浏览器界面顶栏中，点击 **涂装**（调色板图标）—— 打开**涂装页面**
3. 点击顶栏的**涂装包**按钮，等待自动下载，或在弹出的文件选择对话框中选择本地 ZIP 文件
4. 编辑器自动将内容解压到游戏根目录下的 `Mods/` 文件夹

**注意：** 如果 `Mods/` 文件夹不存在，编辑器会自动创建。

### 自制涂装（涂装页面）

创建并分享你自己的机身（`Body`/`BaseMap`）涂装。涂装页面（浏览器顶栏 → **涂装**）分为涂装列表与绘制器两个视图，列表的所有操作都集中在单一顶栏中：

- **返回** —— 回到浏览器（在绘制器中则先返回列表）。
- **涂装包** —— 原有的真实涂装下载/安装流程，以弹窗打开。
- **新建** —— 打开整页绘制器：2048×2048 **透明**画布（画笔/橡皮/取色/填充/图形/文字/贴花，文字与贴花均为可移动、可旋转、可水平/垂直翻转的浮动对象，20 步撤销，无 3D 预览）。顶栏放置航司/机型以及**导入图片** / **导入涂装**（ZIP）/ **导出涂装** / **保存** / **另存为**，左侧竖排工具栏，底部为缩放。**保存**到自身文件夹时直接覆盖（无 `.bak`）；**另存为**（或保存时改用其他已存在的文件夹名）会先弹出确认/取消提示再覆盖。保存成功后还会提示前往游戏内“更多涂装”页面启用 **AC27 自定义涂装** Mod，勾选**不再提示**即可关闭（记录在 `cache.json`）。参考涂装只读，仅可另存为。
- **全选**/**取消全选**、**导出**（需单选）、批量**删除**与**查找**（按航司、文件夹名或机型过滤）。
- 列表将 `<游戏根目录>/Mods/AC27 Custom Liveries/` 下的所有涂装按机型分组为可折叠文件夹（真实涂装包中的参考涂装在同一分组内，带锁形只读标记）；**点击卡片即可在绘制器中打开**。每张卡片缩略图上带选择框；顶部栏的**导出**（需单选，保存为可分享的 ZIP）与**删除**（可单选或多选，需确认）作用于所选涂装。文件夹名可自由命名（仅需文件系统安全），编辑器不会解析其含义，航司/机型由清单文件决定。包根目录的 `mod_info.json` 会自动维护：在加载/创建时写入 **AC27 Custom Liveries** 模组名，并修正官方涂装包 ZIP 附带的那份仍使用参考涂装包名称的文件。

**分享约定：** 导出的 `<文件夹名>.zip` 内含 `<文件夹名>/aircraft_livery_manifest.json` + `<文件夹名>/base.png`。发给朋友后，对方在绘制器中使用**导入涂装**即可安装，或直接解压到 `<游戏根目录>/Mods/AC27 Custom Liveries/`。

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

- **Version:** v1.3.7
- **Runtime:** Electron 33
- **Frontend:** React 19 + Vite 8 + zustand 5
- **Language:** JavaScript (plain, no TypeScript)
- **Build:** electron-builder (programmatic API via `build.js`)
- **Tests:** Vitest (100 test files, 1750 tests) + Playwright (E2E, 9 spec files) + Node.js (integration, 60 scripts; 173 MCP/API tests)

### Quick Start

```bash
npm install
npm start          # Launch in dev mode (no build step needed)
```

### Architecture (High-Level)

```
electron/main.js     →  Electron main process, 89 IPC handlers, file I/O, map window management, video background replacer, BepInEx debug mode, livery download & install, auto-update check & install
electron/preload.js  →  contextBridge: exposes ~133 methods on window.electronAPI
electron/updater.js  →  Auto-update: HEAD check (R2 ETag), MD5 comparison, file-based logging to updater.log, resolveTargetExe (dev-mode support), exe download, batch script generation
electron/api-server.js →  HTTP API + MCP server (port 31415, auto-starts with app, 27 tools)
electron/bepinex.js     →  BepInEx debug mode — download, install, uninstall (IL2CPP bleeding edge)
electron/udp_listener.js →  UDP telemetry engine (10 Hz aircraft state v2: simFlags, timeScale, heartbeatSeq, auto-reset)
electron/voice-stt-vosk.js →  Offline vosk STT worker child (EN+ZH models, grammar-constrained, sox mic capture; runs under ELECTRON_RUN_AS_NODE; --wav/--test CLI modes)
electron/voskFfi.js      →  koffi binding to bin/vosk/libvosk.dll (vosk 0.3.39 C API)
electron/voiceSttWorker.js →  Main-process bridge: spawns/drives the vosk worker child (state machine, request-scoped event routing)
mcp/bridge.js        →  MCP stdio↔HTTP bridge (launched by Claude Code for AI agent control)
index.html           →  Vite HTML entry, loads src/main.jsx
src/main.jsx         →  React entry: ReactDOM.createRoot → <App />
src/App.jsx          →  Root component: providers + screen routing (+ map window routing + MCP store listener)
src/components/      →  React component tree (Setup, Browser, Livery, Editor, common, MapWindows)
src/hooks/           →  Custom React hooks (useTranslation, useEditorShell, etc.)
src/store/           →  zustand store (single source of truth for all UI state)
src/acl/             →  CommonJS backend modules (parser facade + 19 modules + OdinSerializer binary codec)
src/acl/config.js    →  Centralized config time resolution: resolveConfigTime (CDT override), resolveDisplayTimes
src/acl/gatcarc.js   →  GATCARC4 binary container: readAclText/writeAcl universal I/O (binary + text)
src/acl/v4_pk_index.js → v4 PK entity index: $iref→$id lookup, vector3/string/iref extraction helpers
src/acl/odin/        →  OdinSerializer binary codec (reader, writer, JSON reader/writer, .NET values)
src/utils/           →  Shared utilities (ESM for frontend + CJS for backend)
```

The app has three main screens managed by React component rendering: **Setup → Browser → Editor** (plus the **Livery** page reached from the browser header). All time display uses `resolveConfigTime()` — a centralized resolver that extracts Config.startTime from the ACL and overrides it with `GameTime.CurrentDateTime` (the player's actual in-game time including warmup). Demo files show a 30-min window at CurrentDateTime. The browser screen caches file infos and geometry data in the zustand store across editor→browser navigation, avoiding a full re-scan on return. Three additional window types — **Surface Radar**, **Approach Radar**, and **Flight Strips** — open as separate Electron windows. Surface/Approach Radar show live aircraft positions from the game's UDP telemetry stream (v2 protocol with simFlags/timeScale/heartbeatSeq). Aircraft state auto-resets on 5s stale timeout or game level change (hasLevel 0→1 transition). Flight Strips display live progress strips sorted by controller seat (RAMP→GRO→TWR→DEP→APPR→DEL→APN) with drag-to-reorder, game speed multiplier display (×1/×2 from timeScale), cross-window selection sync, and push-to-talk voice command input (patch-command vocabulary: heading/altitude/speed/clear-for-approach sent to the AC27Approach plugin; offline vosk recognition — EN+ZH, grammar-constrained, sox mic capture; CLI sim via `scripts/voice_sim.mjs`, TTS round-trip via `scripts/voice-stt-test.mjs`). Double-click the Label button on either radar to toggle **witch mode** — replaces aircraft with animated sprites from 15 round-robin character sheets (1536×768, 3×6 grid of 256×256 cells, clipped via nested SVG with `clipPath`). Active (click-selected) aircraft get a white silhouette glow via `feDropShadow`; any click exits witch mode.

All file I/O goes through IPC (`ipcMain.handle` / `ipcRenderer.invoke`). The renderer never touches the filesystem directly.

### Data Flow

```
Phase 0 (once):   Game Root → scan audio + approach data + taxiway/SID/missed-app paths (merged from all .acl files) + dropdowns + runway pairs → AirportCache. Progress bar shows global 0–100% across all airports/files.
Phase 1 (load):   .acl → readAclText() (GATCARC4 decode) → parse flights + timelines → zustand store. All files are v4: StaticData.$blobdoc.StaticItems (flight-plan: entries). Config startTime resolved via resolveConfigTime (overrides with GameTime.CurrentDateTime if present).
Phase 2 (edit):   All edits go through zustand store actions. InBlockTime/TakeoffTime columns are hidden.
Phase 3 (save):   Validation → generate flights → writeAcl() to .acl + .csv + timeline .json. Rebuilds StaticData.$blobdoc.StaticItems (no AircraftStates). The GATCARC4 container version is preserved on disk (v1 stays v1, v2 stays v2). A **0-flight level** (scenery-only / fully-cleared schedule) is now a valid save — the pipeline runs with an empty flight set, removing every flight-plan/aircraft/animator runtime entity while preserving jetways, radio channels, and scenery, and `loadFlights` reloads it as an empty schedule. Rebuilt runtime-adjacent types (e.g. `AircraftAnimator`) and the `StaticData.$blobdoc` types that the game strips from a flight-less level resolve lazily / with fallback so a lean scope never aborts a save.
UDP (live):       Game → UDP 20266 (10 Hz) → udp_listener.js → map windows (Surface Radar / Approach Radar / Flight Strips)
MCP (AI agent):   Claude Code → stdio → mcp/bridge.js → HTTP :31415 → api-server.js → IPC → store → UI
```

### MCP / AI Agent Integration

The editor includes a built-in MCP (Model Context Protocol) server that allows AI agents like Claude Code to control the editor — create, read, modify, and delete flights plus ground/air scenery via natural language. The API server auto-starts on `127.0.0.1:31415` when the app opens.

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

**27 MCP tools:** the flight tools `create_flights`, `get_flights`, `modify_flights`, `delete_flights`, `get_editor_status`, `get_airport_info`, `get_validation_issues`, `send_voice_command`; the Ground Painter tools `get_ground_painter_state`, `set_ground_painter_mode`, `create_taxiway_lines`, `create_areas`, `create_area`, `create_stands`, `create_runways`, `create_taxiway_fillet`, `delete_ground_objects`, `move_ground_objects`, `move_ground_endpoint`, `rename_ground_object`, `undo_ground_painter`; and the air-mode tools `create_airway_nodes`, `create_airway_procedures`, `delete_airway_objects`, `move_airway_objects`, `rename_airway_object`, `create_airway_fillet`. Supports English and Chinese (中文).

**Testing:**
```bash
node tests/integration/test_api_server.js           # API + MCP protocol (129 tests)
node tests/integration/test_api_e2e_examples.js     # Composition examples (44 tests)
```

### Project Structure

```
├── electron/
│   ├── main.js              # Electron main process + 89 IPC handlers
│   ├── preload.js           # contextBridge (window.electronAPI, ~133 methods)
│   ├── updater.js           # Auto-update: HEAD check, MD5, file logging, resolveTargetExe, download, batch script
│   ├── api-server.js        # HTTP API + MCP server (port 31415, 27 tools)
│   ├── cloud-llm.js         # Multi-vendor cloud LLM chat (DeepSeek/Gemini/Claude/Codex)
│   ├── livery.js            # Custom livery pack logic (list/create/delete/export/load)
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
│   │   ├── LiveryScreen/        # Custom livery list + painter (canvas, stickers, ZIP share)
│   │   ├── EditorScreen/        # Main editor: table + timelines
│   │   │   ├── FlightTable/     # Sortable flight table with inline editing
│   │   │   ├── CellEditor/      # SVG clock & compass popovers
│   │   │   ├── StandMap/        # Interactive stand position map overlay
│   │   │   ├── StarMap/         # Interactive STAR/approach chart overlay
│   │   │   └── TimelineEditors/ # Weather, Wind, Runway editors
│   │   ├── MapWindows/          # Full-window map visualizations (separate windows)
│   │   │   ├── GroundMapWindow.jsx + .css  # Surface radar: taxiways, runways, areas, ground aircraft, help overlay
│   │   │   ├── AirMapWindow.jsx + .css     # Approach radar: STAR/SID/APPR routes, fixes/waypoints layer, runway extensions, range rings, border overlay, help overlay
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
│   │   │   ├── useVoiceCommands.js         # React hook: vosk worker (Electron) / webkit fallback (browser)
│   │   │   └── VoicePTTButton.jsx          # Push-to-talk mic button (hold-to-talk, pulse/flash animations)
│   │   └── common/              # Modal, Toast
│   │
│   ├── hooks/               # React custom hooks
│   │   ├── useTranslation.jsx   # I18n Context Provider (zh/en)
│   │   ├── useElectronAPI.jsx   # electronAPI Context Provider
│   │   ├── useEditorShell.jsx   # Keyboard shortcuts
│   │   ├── useEditorSaveActions.jsx  # Save/export/backup logic
│   │   ├── useKeyboardShortcuts.js  # Generic shortcut registry
│   │   ├── useDrag.js          # Shared drag behavior for floating panels
│   │   └── map/                # Map-window hooks (cross-window selection, witch animation, knob positions)
│   │
│   ├── store/
│   │   ├── appStore.js          # zustand store — all app state
│   │   ├── flightDefaults.js    # new flight creation (random airline, cascaded fields, non-conflicting stand, runway-constrained STAR for arrivals, Airway always cleared for departures)
│   │   └── flightCascade.js     # cascading field updates (CallSign rebuild, airline→type/reg, runway→STAR)
│   │
│   ├── acl/                 # Backend modules (CommonJS)
│   │   ├── config.js            # Centralized time resolution (resolveConfigTime, CDT override)
│   │   ├── parser.js            # FACADE — main.js imports everything through here
│   │   ├── gatcarc.js           # GATCARC4 binary container (universal readAclText/writeAcl)
│   │   ├── id_renumber.js       # Strictly-ascending $id/$iref renumbering for the game's checkpoint reader
│   │   ├── v4_pk_index.js       # v4 PK entity index + $iref resolution
│   │   ├── scenery_graph.js     # Ground Painter read path — id-free scenery Graph + meta
│   │   ├── scenery_write.js     # Ground Painter write path — lossless patchSceneryBlob (+ frame reconcile)
│   │   ├── geo_osm.js           # geo_data.osm sync on Ground Painter save
│   │   ├── odin/                # OdinSerializer binary codec (reader, writer, JSON, .NET values)
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
│       ├── constants/           # Domain constants barrel (timing, fields, aviation, airlines, acl-format, map-config, ui, livery)
│       ├── timeUtils.js         # Tick↔time conversion + timeline helpers
│       ├── starDisplay.js       # STAR/SID display dedup (ZGSZ-style runway-suffixed names grouped under the base route)
│       ├── liveryImage.js       # Livery shrink-to-fit texture normalize + file→dataURL
│       ├── liveryPaint.js       # Pure canvas paint helpers (floodFill, undo stack, colour math)
│       ├── patchCommands.js     # Flight-strip patch-command framing/helpers
│       ├── i18n.js              # Chinese/English translation system
│       ├── validators.js        # Save validation logic
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── safeHtml.jsx         # Renders i18n strings with an allowlist of HTML tags as safe JSX
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       ├── debugLog.js          # Gated debug logging (localStorage + URL param)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # 100 Vitest files (1750 tests) + 9 Playwright E2E specs + 60 Node.js integration scripts
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
npm run test:all      # Vitest + save integrity (16 files) + jetway rebuild (16 v4) + v4 runway pairs + build + Playwright E2E (~4.5 min, sets E2E_GAME_ROOT)
```

**Component tests (Vitest — 100 test files, 1750 tests):**
```bash
npm test              # Run all component + store + utility + MapWindow + updater tests (~8s)
npm run test:watch    # Watch mode — re-runs on file changes
```

**E2E tests (Playwright + Electron — 9 spec files):**
```bash
npm run build         # Build required first (produces dist-electron/main.js)
npm run test:e2e      # UI flow tests against real game data (~4 min)
```

**Demo files:** Save completes but produces a smaller file because the demo save flow strips CurrentDateTime content. Flight data is preserved — verified by the integration test. The 30-min demo window end time is rounded to the nearest 5-minute boundary (:X0 or :X5). Emergency (`_emerg`) files show "Challenge Level" / "挑战关卡" as their time-of-day label instead of dawn/morning/etc.

**Save integrity — all .acl files (Node.js integration):**

Test every .acl file across all airports for save→reload→compare round-trip:
```bash
# All non-Endless .acl files across all airports:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root>

# 13 production + 3 demo files only:
node --require ./tests/integration/preload.cjs tests/integration/test_save_integrity_all.js --root <game-root> --prod-demo
```
Validates flights (all 14 fields), config (startTime/endTime), scenery maps, embedded timelines, and source format for each file.

**Parser/module tests (no game root needed):**
```bash
node tests/integration/test_tokenizer.js            # String-aware scanner (18 tests)
node tests/integration/test_acl_json.js             # Pre-processor + serializer round-trips (25 tests)
node tests/integration/test_acl_document.js         # Document model integration (13 tests)
node tests/integration/test_sid_goaround.js         # SID + missed approach route parsers (19 tests)
node tests/integration/test_taxiway.js              # Taxiway centerline parser (10 tests)
node tests/integration/test_demo_filter.js          # Demo-level flight filtering v2/v3 + v4 (13 tests)
node tests/integration/test_gatcarc_roundtrip.js    # GATCARC4 binary round-trip (96 tests, 32 files)
node tests/integration/test_real_kjfk_jfk5.js       # Real KJFK/JFK5 data parsing (8 tests)
node tests/integration/test_jetway_rebuild.js       # v4 jetway rebuild round-trip (16 prod+demo files)
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

`build.js` is the single source of truth for the electron-builder config (do
not edit the `build` key in package.json — there isn't one). Windows
(normal / voice / workshop), macOS, and Linux builds are produced:

| Command | Artifact | Contents |
| --- | --- | --- |
| `npm run build:win` | `release/AC27Editor.exe` | Normal build — **no voice assets**. This is the auto-update variant served from R2 (small). Voice UI shows "unavailable" (worker JS not shipped). |
| `npm run build:win:voice` | `release/AC27EditorVoice.exe` | Voice build — bundles the offline vosk STT (large EN model `vosk-model-en-us-0.22` ~1.9 GB + small ZH `vosk-model-small-cn-0.22` ~42 MB, sox, vosk DLLs, koffi). Auto-updates through the R2 `/editor` route too — sends `X-AC27-Variant: voice` so the Worker serves its own objects. |
| `npm run build:win:workshop` | `release/AC27EditorWorkshop.exe` | Steam Workshop build — bundles the AC27Approach plugin DLL offline (`resources/AC27Approach.dll`); **auto-update disabled** (Steam Workshop handles updates). Not attached to the GitHub release. |
| `npm run build:mac` | `release/*.dmg` | macOS (voice is Windows-only). |
| `npm run build:linux` | `release/*.AppImage` + `*.deb` | Linux (no auto-update). |

The normal + voice Windows variants go to the GitHub release and both reach R2
for auto-update — both served via the single `/editor` route, the Worker
switching objects on the `X-AC27-Variant` header (`normal` →
`AC27Editor.exe(.md5)`, `voice` → `AC27EditorVoice.exe(.md5)`; the release
workflow pins the exact filenames). The workshop exe is published to Steam
Workshop only.

```powershell
# Normal build
npm run build:win

# Voice build (needs models first: node scripts/fetch-vosk-model.mjs — fetches
# the large en model ~1.9 GB + small zh model)
npm run build:win:voice
```

`node build.js --win [--voice] [--publish never]` also works directly
(the voice build fails up front if `models/` or `bin/sox` is missing).

# Embed icon (optional)
node set_icon.js
```

Output: `release\AC27Editor.exe` (portable).

**First-time Windows setup** — if the build fails with winCodeSign errors:

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

### CI/CD

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags (or a manual `workflow_dispatch`) and builds **Windows** (normal + voice + workshop portable `.exe`), **macOS** (`.dmg`), **Linux** (`.AppImage` + `.deb`), and the **AC27Approach plugin DLL** in parallel. The normal + voice Windows builds are uploaded to Cloudflare R2 for auto-update delivery, and the plugin DLL is uploaded to the dedicated `ac27approach` R2 bucket (`s3://ac27approach/AC27Approach.dll`) — served via the `https://ericpzh.rest/ac27approach*` Worker route that the Flight Strips window's Load DLL button downloads from. The workshop exe auto-deploys to Steam Workshop (appid 4004140). All normal + voice + plugin artifacts are attached to a GitHub Release with auto-generated release notes. See `mods/docs/cloudflare-worker-routes.md` for the Worker/R2 infrastructure.

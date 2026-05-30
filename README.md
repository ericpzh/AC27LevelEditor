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

## Data Flow

```mermaid
flowchart TD
    subgraph P0[Phase 0 机场初始化 仅一次]
        R[选择 Game Root] --> PA[遍历各机场 ICAO]
        PA --> CSV[扫描所有 Session CSV]
        PA --> AUD[加载 audio_clips en+zh]
        CSV & AUD --> CACHE[AirportCache ICAO 按机场缓存]
    end
    CACHE --> P1
    subgraph P1[Phase 1 加载 打开 acl]
        ACL[选择 acl 文件] --> B[loadAcl 解析航班]
        ACL --> CFG[读取 aclcfg]
        B --> D[collect ACL 特有值]
        CFG --> TL[loadTimelines]
        B & CFG & D & TL --> STATE[appState = 缓存 + ACL + Timeline]
    end
    STATE --> UI[render UI 表格 + ConfigBar + 时间线]
    UI --> EDIT[用户点击编辑]
    EDIT --> SW{哪个 Section}
    SW -->|Flight Schedule| FS{哪一列}
    FS -->|AirlineCode| F1[allAirlines 白名单]
    FS -->|FlightNum| F2[byAirline code 强制select]
    FS -->|AircraftType| F3[型号 + compat过滤]
    FS -->|Stand/Runway| F4[ACL+CSV 双源]
    FS -->|Dep/Arr| F5[ACL+CSV 双源]
    FS -->|Voice| F6[CSV voiceOptions]
    FS -->|Language| F7[en zh]
    FS -->|时间字段| F8[时间选择器 hhmmss]
    F1 & F2 & F3 & F4 & F5 & F6 & F7 & F8 --> J[提交修改]
    SW -->|Runway| RT[编辑 initialRunways + changes]
    SW -->|Weather| WT[编辑 weather presets + time]
    SW -->|Wind| WD[编辑 wind dir + speed + time]
    RT & WT & WD --> J
    J --> L{改的是 AirlineCode}
    L -->|是 换航司| K[联动 FlightNum选项 + AircraftType compat过滤 旧值不兼容红高亮]
    K --> UI
    L -->|否| M[更新 appState]
    M --> N{点击保存}
    N -->|是| O
    subgraph P3[Phase 3 保存]
        O[构建 aclData] --> P[三重验证 a选项合法性 b时间范围 c跑道集合]
        P -->|N个问题| Q[弹窗列出问题 仅关闭 阻止保存]
        P -->|通过| R2[备份弹窗 创建bak 默认勾选]
        R2 -->|是| S[bak覆盖备份]
        R2 -->|否| T[跳过]
        S --> U[写入 acl + csv + json]
        T --> U
        U --> V[保存完成]
    end
    N -->|否| W[继续编辑]
    W --> UI
```

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

**Always use `build.js`**, never `npm run build:win` — the latter gets killed mid-way by PowerShell's watch-mode detection.

#### 1. Close any running instance of the editor

The build will **fail** with `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE` if `dist\win-unpacked\resources\app.asar` is locked by a running editor.

```powershell
Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
```

#### 2. Clean the output directory

```powershell
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
```

If this fails with "The process cannot access the file", the `.asar` is still locked by another process
(antivirus scan, File Explorer preview pane, or a crashed builder process). Workaround:

```powershell
# Build to a temp directory instead, then robocopy into dist
node -e "const b=require('electron-builder');b.build({targets:b.Platform.WINDOWS.createTarget('portable'),config:{appId:'com.ac27.level-editor',productName:'AC27 Level Editor',directories:{output:'dist_tmp'},files:['main.js','preload.js','src/**/*','node_modules/**/*'],win:{target:'portable',icon:'icon.ico',artifactName:'${productName}.${ext}'}}})"
robocopy "dist_tmp\win-unpacked" "dist" /E /R:5 /W:3
Remove-Item -Recurse -Force "dist_tmp" -ErrorAction SilentlyContinue
```

#### 3. Run the build

```bash
node build.js
```

The output is `dist\AC27 Level Editor.exe` (~180 MB portable executable).

If the build still fails:
- Check that no folder/file under `dist\` is open in Explorer, VS Code, or any other program
- Try temporarily disabling real-time antivirus scanning if it keeps locking `.asar` files
- As a last resort, reboot and build before opening any other app

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

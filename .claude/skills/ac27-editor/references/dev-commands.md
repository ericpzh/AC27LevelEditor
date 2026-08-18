# AC27 Dev Commands

## Table of Contents

- [Running the App](#running-the-app)
- [Running Tests](#running-tests)
- [Local Build](#local-build)
- [GitHub Release](#github-release)

## Running the App

```bash
npm start          # Launch Electron in dev mode (Vite dev server + Electron)
```

## Running Tests

### Component tests (1200 tests, ~9s)

```bash
npm test              # Run all Vitest component + store + utility + electron + MapWindow + updater tests
npm run test:watch    # Watch mode — re-runs on file changes

# Run only updater tests
npx vitest run tests/electron/updater.test.js
```

### E2E tests

```bash
npm run test:e2e      # Playwright + Electron full user-flow tests
```

### Fuzz save test (E2E, gated on `FUZZ_RUN=1`)

Randomized edit storm over the production levels via the MCP API, gated through the
app's real validator, then a real UI save with backup — all in a temp sandbox. Full
docs in `tests/README.md` ("Fuzz Save"). ⚠️ Requires `npm run build` first and no
other editor instance (port 31415).

```bash
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz                                   # all 13 prod levels, 50–200 ops each
$env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl"; npm run test:fuzz   # subset (comma-separated)
$env:FUZZ_SEED = "12345"; npm run test:fuzz         # reproduce a failure deterministically
npm run test:fuzz -- --replace                      # copy PASSED levels' .acl + .acl.bak into the REAL game install (FUZZ_REPLACE=1 env works too)
```

The `--replace` flag is consumed by the `tests/e2e/fuzz-cli.mjs` wrapper (Playwright
itself rejects unknown flags) — it forwards everything else to Playwright. Without
`--replace` the real game files are never touched.

### Integration tests (plain Node.js, in `tests/integration/`)

All accept `--help` / `-h` for usage. Temp files are written to `tests/integration/` and cleaned up automatically.

**Vitest-based fixture regression suites** (no game root needed, covered by `npm test`):
```bash
npx vitest run tests/integration/save_gamecompat.test.js   # game-load invariants + _normalizeFlightsForGameCompat auto-repair (4 fuzz-discovered crash classes, ZSJN_leisure_1 fixture; see gamecompat-utils.cjs)
npx vitest run tests/integration/id_renumber.test.js       # strictly ascending $id ordering + $iref remap (id_renumber.js, ZSJN_peakdeparture jetway:02 crash pattern)
```

New parser module tests (no game root needed):
```bash
node tests/integration/test_tokenizer.js            # String-aware scanner (18 tests)
node tests/integration/test_acl_json.js             # Pre-processor + serializer round-trips (25 tests)
node tests/integration/test_acl_document.js         # Document model integration (13 tests)
node tests/integration/test_sid_goaround.js         # SID + missed approach route parsers (17 tests)
node tests/integration/test_taxiway.js              # Taxiway centerline parser (11 tests)
```

UDP telemetry test (mock loopback server, requires port 20266 free):
```bash
node tests/integration/test_udp_listener.js         # Binary protocol parsing + trail buffer (13 tests)
```

MCP / API server tests (mock Electron window, no game root needed):
```bash
node tests/integration/test_api_server.js           # API endpoints + MCP protocol + validation (109 tests)
node tests/integration/test_api_e2e_examples.js     # Composition examples from MCP skill (44 tests)
```

Scan-all tests (need game root, default `../../../../` from integration dir):
```bash
node tests/integration/test_parse_airport.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_callsign_gen.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Single-ACL tests (require `--acl <path>`, derive paired files automatically):
```bash
node tests/integration/test_e2e_save_load.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_sections.js --acl <path>
node tests/integration/test_acl_linkage.js --acl <path>
```

Timeline tests (require `--acl <path>`, auto-discover JSONs):
```bash
node --require ./tests/integration/preload.cjs tests/integration/test_timeline_comparison.js <acl-path>
node --require ./tests/integration/preload.cjs tests/integration/test_generate_timelines.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_timelines.js --acl <path>
```

### Debug data-analysis scripts (`tests/_debug/`, gitignored)

```bash
node tests/_debug/extract_aircraft_times.js             # Decode all prod .acl files, extract per-aircraft
                                                        # callsign + 4 times (runtime _departureTakeoffTime/
                                                        # _arrivalInBlockTime from RuntimeEntities, scheduled
                                                        # OffBlockTime/LandingTime from StaticItems) → aircraft_times_report.tsv
                                                        # Flags: --airports=ZSJN,KJFK,KDCA --include-demo --include-test --out=<path>
node tests/_debug/compute_taxi_constants.js             # Per-airport median/avg taxi durations from the TSV;
                                                        # prints ready-to-paste DEPARTURE_TAXI_SECONDS /
                                                        # ARRIVAL_TAXI_SECONDS blocks for src/utils/constants/timing.js
```

Used to re-derive the per-airport taxi-time constants when new production saves become available (e.g. KDCA after playing through a level — its current saves are clean starts with no RuntimeEntities).

## Local Build

```bash
# ALWAYS use build.js for local Windows builds — never npm run build:win directly
node build.js        # Build Windows portable EXE → dist/AC27Editor.exe
node set_icon.js     # Post-build: embed icon.ico into the EXE
```

### Pre-build cleanup (Windows PowerShell)

```powershell
Stop-Process -Name "AC27 Editor" -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
```

### winCodeSign one-time fix (if build fails)

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

## Auto-Update Testing

### Summary of changes in this diff (auto-update refactor)

- **`log()` function added** — every decision step writes to both console and `<userData>/updater.log`
- **`resolveTargetExe()`** — resolves the exe to compare: `PORTABLE_EXECUTABLE_FILE` (packaged portable), `process.execPath` (packaged non-portable), `AC27_UPDATE_TARGET` (dev mode explicit path), or auto-discovered build artifact (`release/AC27Editor.exe`, `dist/AC27 Editor.exe`, etc.) in dev mode
- **Dev mode gating** — `npm start` skips the check by default. Opt in with `AC27_UPDATE_DEV_CHECK=1` (auto-discover) or `AC27_UPDATE_TARGET=<path>` (explicit)
- **`skip-update` IPC removed** — no more `skipped-update.json`. The "Later" button is ephemeral (next restart re-prompts)
- **Voice build auto-updates through the shared `/editor` route** (2026-08-16) — `AC27EditorVoice.exe` is no longer skipped. `isVoiceBuild()` (resources/`voice-stt-vosk.js` present) now sends an **`X-AC27-Variant: voice` header** (`variantHeader()`/`variantName()`) on the SAME `/editor` URL as the normal build — the Worker picks the R2 objects per header, so the voice exe's MD5 is compared/verified/downloaded against its own `AC27EditorVoice.exe.md5` sidecar — never the normal build's objects. The check is gated inside `checkForUpdate()` and covers both the main-process push and the renderer fallback. Dev-mode detection of the voice build is impossible (`!app.isPackaged`), so to test the voice branch locally set `AC27_UPDATE_SERVER` to a TLS server that honors the header (the updater refuses plain http) or drive it from the packaged voice exe.
- **DRY_RUN defaults** differ by context: `false` for packaged (real install), `true` for dev (safe). Override with `AC27_UPDATE_DRY_RUN=0` / `=1`
- **Renderer fallback** — `App.jsx` actively invokes `checkForUpdate()` as fallback if the main-process push arrives before the renderer is ready (race condition guarded by `useRef(false)`)

### Mock update server (local dev testing)

```bash
node tests/update-mock-server.js   # Start mock update server on port 9999
```

Then launch the app pointed at the mock:
```powershell
# Dev mode: opt in and point at the mock
set AC27_UPDATE_DEV_CHECK=1
set AC27_UPDATE_SERVER=http://localhost:9999
set AC27_UPDATE_DRY_RUN=1           # optional — skips actual .bat spawn
npm start
```

The mock is variant-aware — it selects its per-variant dummy exe/MD5 from the
`X-AC27-Variant` request header (`normal` → `AC27Editor.exe`, `voice` →
`AC27EditorVoice.exe`), mirroring the Worker. It returns a random ETag that
never matches any local exe, so the update prompt always appears.

⚠️ The updater only speaks **https** (`ERR_INVALID_PROTOCOL` on plain http), so
this plain-http mock can't drive the packaged update flow end-to-end — it's for
curl/prototyping or wiring into a TLS wrapper (see
`mods/docs/cloudflare-worker-routes.md` for the live Worker script).

### Dev-mode env vars

| Env Var | Default | Effect |
|---------|---------|--------|
| `AC27_UPDATE_SERVER=<url>` | `https://ericpzh.rest/editor` | Redirect update checks to a custom/mock server. Both variants use this exact URL; they differ only in the `X-AC27-Variant` header. |
| `AC27_UPDATE_DRY_RUN=1` / `=0` | `1` (dev) / `0` (packaged) | `1` = skip actual `.bat` spawn for `installUpdate()` |
| `AC27_UPDATE_DEV_CHECK=1` | unset | Dev only: enables the check under `npm start` (auto-discovers a build artifact) |
| `AC27_UPDATE_TARGET=<path>` | unset | Dev only: explicit path to the exe whose MD5 is compared (also enables the check) |
| `AC27_UPDATE_DRY_RUN=0` | — | Dev only: forces a real install (spawns `updater.bat`) — use with caution |

## GitHub Release

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags pushed to GitHub. It builds **Windows** (portable `.exe`, both normal and voice), **macOS** (`.dmg`), **Linux** (`.AppImage` + `.deb` — no auto-update, release-attached only like macOS), and the **AC27Approach plugin DLL** (`mods/AC27Approach`, net6.0) in parallel. The Windows builds are uploaded to Cloudflare R2 (`ac27editor/AC27Editor.exe` + `.md5`, and `AC27EditorVoice.exe` + `.md5` in the same bucket) for auto-update delivery, and the plugin DLL is uploaded to `s3://ac27approach/AC27Approach.dll` (dedicated bucket, endpoint `https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com`) — served through the `https://ericpzh.rest/ac27approach*` Worker route, which the Flight Strips window's Load DLL button pulls from (download-first, file-dialog fallback; see `mods/docs/cloudflare-worker-routes.md`). All artifacts are attached to a GitHub Release with auto-generated release notes.

### How to release a new version

1. **Bump version** in `package.json` if this is a new version (not a re-tag)
2. **Commit** all changes
3. **Tag** the commit: `git tag v<version> <commit-ish>` (defaults to HEAD)
4. **Push** the tag: `git push origin v<version>`
5. **CI** builds Windows + macOS and creates the GitHub Release automatically

### How to re-release the same version (after a hotfix)

If the tag already points to an old commit and you need to move it:

```bash
git tag -f v<version> <new-commit>
git push -f origin v<version>
```

The force-push re-triggers the CI workflow, which rebuilds both platforms and updates the GitHub Release with fresh artifacts. **The tag must be force-pushed** — simply pushing a new commit without moving the tag will NOT trigger a new release.

### Important notes

- The CI uses `npm run build:win/build:mac/build:linux`, NOT `node build.js`. Rule 15 (never `npm run build:win`) applies to **local development only** — `build.js` auto-detects Windows and sets up portable target + icon correctly.
- `--publish never` in CI prevents electron-builder from trying to publish to GitHub Releases (the workflow handles that via `softprops/action-gh-release`).
- `CSC_IDENTITY_AUTO_DISCOVERY: false` disables code signing since we don't have a signing certificate.
- Manual release: trigger the workflow via `workflow_dispatch` on GitHub Actions with an optional version input.
- macOS builds produce a `.dmg`; Windows builds produce a portable `.exe` (no installer); Linux builds produce an `.AppImage` + `.deb` (no auto-update — the updater is win32+portable only).

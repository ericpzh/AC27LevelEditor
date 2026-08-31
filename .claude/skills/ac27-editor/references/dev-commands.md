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

### Coverage (scoped, threshold-gated)

`vitest.config.js` runs coverage through the **v8** provider (`@vitest/coverage-v8` devDependency) scoped to the two trees that hold the real logic — `src/acl/**` and `src/components/EditorScreen/GroundPainter/**` — and **fails the run** below the thresholds (`statements 55 / branches 40 / functions 48 / lines 55`, a few points of slack under the measured 59.8/44.8/53.7/62.4 baseline). Screens and entry points are deliberately out of scope.

```bash
npx vitest run --coverage                                              # full suite + coverage/ report + coverage-summary.json
npx vitest run --coverage tests/components/EditorScreen/GroundPainter/ # Ground Painter only
```

`testTimeout` is **30 s**, not vitest's 5 s default: the integration suites decode and re-patch real multi-MB `.acl` levels, so individual tests take seconds even un-instrumented (one `scenery_delete_cascade` case alone measures ~3.4 s).

### E2E tests

```bash
npm run test:e2e      # Playwright + Electron full user-flow tests
```

### Fuzz save tests (E2E, gated on `FUZZ_RUN=1`)

Randomized edit storms over the production levels via the MCP API, gated through the
app's real validator, then a real UI save with backup — all in a temp sandbox. Full
docs in `tests/README.md` ("Fuzz Save" / "Fuzz Ground Save"). ⚠️ Requires `npm run build` first and no
other editor instance (port 31415).

```bash
$env:E2E_GAME_ROOT = "<game-root>"; $env:FUZZ_RUN = "1"
npm run test:fuzz                                   # flight fuzz: all 20 prod levels, 50–200 ops each
npm run test:fuzz:ground                            # ground fuzz: all 20 prod levels, 50–200 scenery ops each (runway/taxiway/fillet/area/stand/select+delete)
$env:FUZZ_ACL_FILES = "ZSJN/ZSJN_leisure_1.acl"; npm run test:fuzz   # subset (comma-separated)
$env:FUZZ_SEED = "12345"; npm run test:fuzz         # reproduce a failure deterministically
npm run test:fuzz -- --replace                      # copy PASSED levels' .acl + .acl.bak into the REAL game install (FUZZ_REPLACE=1 env works too)
$env:E2E_KEEP_TMP = "1"; npm run test:fuzz:ground   # keep tests/tmp-e2e for post-mortem (decode with tests/tmp-decode/decode.mjs pattern)
```

`test:fuzz` and `test:fuzz:ground` share `fuzz-cli.mjs` / `fuzz-ground-cli.mjs` wrappers — the `--replace` flag is consumed by the wrapper (Playwright itself rejects unknown flags) and forwards everything else to Playwright. Without `--replace` the real game files are never touched. `E2E_KEEP_TMP=1` preserves the Playwright sandbox (otherwise `global-teardown.mjs` deletes `tests/tmp-e2e`/`tmp-e2e-userdata`).

### Integration tests (plain Node.js, in `tests/integration/`)

All accept `--help` / `-h` for usage. Temp files are written to `tests/integration/` and cleaned up automatically.

**Vitest-based fixture regression suites** (no game root needed, covered by `npm test`):
```bash
npx vitest run tests/integration/save_gamecompat.test.js   # game-load invariants + _normalizeFlightsForGameCompat auto-repair (4 fuzz-discovered crash classes, ZSJN_leisure_1 fixture; see gamecompat-utils.cjs)
npx vitest run tests/integration/id_renumber.test.js       # strictly ascending $id ordering + $iref remap (id_renumber.js, ZSJN_peakdeparture jetway:02 crash pattern)
npx vitest run tests/integration/scenery_roundtrip.test.js # Ground Painter §7.1 no-touch invariant: buildSceneryGraph→patchSceneryBlob(no edits) is byte-identical + re-parses equal; shared-node move / add / delete paths
npx vitest run tests/integration/scenery_physical_runway_cleanup.test.js # Ground Painter runway delete/rename consistency: checkpoint-frame physical-runway RuntimeEntities reconciliation (Unity "PhysicalRunway static item" InvalidOperationException) + _remapRunwayNameFields cascade (Unity "Dynamics.RestoreRuntimeData" NullReferenceException) + _remapTaxiwaySegmentName taxiway-strip coupling + runway↔pavement GEOMETRIC coupling (meta.runwayPavement population, move-reprojects-strip, add-persists-collinear-strip)
npx vitest run tests/integration/scenery_delete_cascade.test.js # Ground Painter stand-deletion reference cascade: dropping a stand also drops its jetway STATIC item AND its jetway RUNTIME entity from the checkpoint frame (Unity "Jetway: static item 'jetway:NN' does not exist in CurrentLevel.StaticField.StaticItems" reference-integrity break — _reconcileJetwayFrames), keeps the taxi-navigation graph, and renumbers cleanly; also a no-op save self-heals an already-corrupt frame
npx vitest run tests/components/EditorScreen/GroundPainter/   # Ground Painter pure-math + component suites: snap.js (angle-snap cascade), fillet-connected.test.js (truncation semantics), fillet-virtual.test.js (additive virtual fillet), metrics.test.js (length/path helpers), GroundPainter.test.jsx (mounted component: line tool, fillet tool, Cancel)
```

**Game-root suites** — read a real level through `tests/helpers/gameRoot.js` and **skip cleanly** when the game is not installed (override with `AC27_GAME_ROOT=/path/to/Airport Control 25 Playtest`):
```bash
npx vitest run tests/integration/survivor_ref_gate.test.js    # Ground Painter §8.5/8.6: a deleted taxiway-node must not leave a survivor taxiway-segment/stand holding a dangling $iref (TaxiwaySegment2DFactory NullReferenceException) — rewire to a live coordinate twin / excise from $rcontent / drop the entry, + the last-resort validation pass, + self-heal of a file already corrupt on disk
npx vitest run tests/integration/ghost_ref_invariant.test.js  # Ground Painter ghost-node invariant: a NEW entity referencing a node that will not be written would serialize "$iref:null" and abort the save — repairGhostRefs re-points it onto a live co-located twin or drops it; survivor entities are never touched
```

**Dangling-`$iref` triage scripts** (Ground Painter / game-load crashes — read real `.acl` files directly):
```bash
node tests/integration/scan_dangling_refs.cjs <level.acl> [...]   # every $iref whose $id does not exist, grouped by owning PK + which section of the level owns it
node tests/integration/scan_dangling_refs.cjs --diff a.acl b.acl  # what one save changed
node tests/integration/scan_taxiway_health.cjs <level.acl> [...]  # walks each taxiway-segment's Nodes list the way TaxiwaySegment2DFactory.CreateVisualPaths does: dangling ids, "$iref:null", refs to non-node objects, positionless nodes (the editor's own reader SKIPS non-numeric $irefs, so a level can look fine in the editor and still crash the game)
node tests/integration/scan_level_health.cjs                      # per-level entity-count + dangling-count table for every ZSJN level (level dir is hard-coded to the Steam install)
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

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags **or `workflow_dispatch`** (manual with optional `version` input — resolves `tag_name` from the tag or the input). It builds **Windows** (portable `.exe`, both normal and voice), **macOS** (`.dmg`), **Linux** (`.AppImage` + `.deb` — no auto-update, release-attached only like macOS), and the **AC27Approach plugin DLL** (`mods/AC27Approach`, net6.0) in parallel (artifacts downloaded to per-variant `release-*` dirs, `tag_name` pinned via `steps.version.outputs.version`). The Windows builds are uploaded to Cloudflare R2 (`ac27editor/AC27Editor.exe` + `.md5`, and `AC27EditorVoice.exe` + `.md5` in the same bucket) for auto-update delivery, and the plugin DLL is uploaded to `s3://ac27approach/AC27Approach.dll` (dedicated bucket, endpoint `https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com`) — served through the `https://ericpzh.rest/ac27approach*` Worker route, which the Flight Strips window's Load DLL button pulls from (download-first, file-dialog fallback; see `mods/docs/cloudflare-worker-routes.md`). All artifacts are attached to a GitHub Release with auto-generated release notes. The `release` job also auto-deploys **Steam Workshop** (`appid 4004140`, `publishedfileid 3793213548`): workshop content is filtered to **only `AC27Editor.exe`** (no Voice — Voice stays GitHub+R2 only) via `steam-workshop-content/` (`AC27Editor.exe` only, `*Voice*` assert) and `upload_mod.vdf` generated with absolute `contentfolder` only (no `previewfile` — thumbnail preserved per user request); content is pushed via `CyberAndrii/steam-totp@v1` + `steamcmd +workshop_build_item`; title `AC27Editor` is constant (`workshop/title.txt`) and bilingual descriptions (`workshop/description_en.txt`/`workshop/description_zh.txt`) are pushed per-language via `scripts/update-workshop-i18n.mjs` (`english`/`schinese` → Steam language switcher, requires `STEAM_PUBLISHER_KEY`, gracefully skipped if missing).

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

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

### Component tests (198 tests across 16 files)

```bash
npm test              # Run all Vitest component + store + utility + MapWindow tests
npm run test:watch    # Watch mode — re-runs on file changes
```

### E2E tests

```bash
npm run test:e2e      # Playwright + Electron full user-flow tests
```

### Integration tests (plain Node.js, in `tests/integration/`)

All accept `--help` / `-h` for usage. Temp files are written to `tests/integration/` and cleaned up automatically.

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
node tests/integration/test_api_server.js           # API endpoints + MCP protocol + validation (85 tests)
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

## Local Build

```bash
# ALWAYS use build.js for local Windows builds — never npm run build:win directly
node build.js        # Build Windows portable EXE → dist/AC27LevelEditor.exe
node set_icon.js     # Post-build: embed icon.ico into the EXE
```

### Pre-build cleanup (Windows PowerShell)

```powershell
Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
```

### winCodeSign one-time fix (if build fails)

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

## GitHub Release

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags pushed to GitHub. It builds **Windows** (portable `.exe`) and **macOS** (`.dmg`) in parallel via `npm run build:win/build:mac -- --publish never`, then attaches both artifacts to a GitHub Release with auto-generated release notes.

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

- The CI uses `npm run build:win/build:mac`, NOT `node build.js`. Rule 15 (never `npm run build:win`) applies to **local development only** — `build.js` auto-detects Windows and sets up portable target + icon correctly.
- `--publish never` in CI prevents electron-builder from trying to publish to GitHub Releases (the workflow handles that via `softprops/action-gh-release`).
- `CSC_IDENTITY_AUTO_DISCOVERY: false` disables code signing since we don't have a signing certificate.
- Manual release: trigger the workflow via `workflow_dispatch` on GitHub Actions with an optional version input.
- macOS builds produce a `.dmg`; Windows builds produce a portable `.exe` (no installer).

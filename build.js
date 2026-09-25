/**
 * build.js — electron-builder configuration (single source of truth).
 *
 * Two Windows variants:
 *   node build.js --win        → AC27Editor.exe      (no voice assets — the
 *                                R2 auto-update build, smaller)
 *   node build.js --win --voice → AC27EditorVoice.exe (bundles the vosk
 *                                offline STT: models + sox + koffi/vosk DLLs)
 *   node build.js --mac        → macOS dmg (voice is Windows-only)
 *   node build.js --linux      → Linux AppImage + deb (voice is Windows-only)
 *
 * The voice build fails up front when models/ or bin/sox is missing
 * (run `node scripts/fetch-vosk-model.mjs` first).
 *
 * Extra args after the flags are forwarded to electron-builder
 * (e.g. `node build.js --win --publish never`).
 *
 * Usage: npm run build:win | build:win:voice | build:mac
 */
const builder = require('electron-builder');
const fs = require('fs');
const path = require('path');
const {
  STEAM_WORKSHOP_MARKER,
  STEAM_WORKSHOP_SOURCE_MARKER,
  STEAM_WORKSHOP_ARTIFACT,
} = require('./src/utils/constants/steam.js');

const args = process.argv.slice(2);
const isWin = args.includes('--win') || args.includes('--windows');
const isMac = args.includes('--mac') || args.includes('--darwin');
const isLinux = args.includes('--linux');
const isVoice = args.includes('--voice');
const isWorkshop = args.includes('--workshop');
const publish = args.includes('--publish') ? 'never' : null;   // CI uses --publish never

const BASE = {
  appId: 'com.ac27.editor',
  productName: 'AC27 Editor',
  directories: { output: 'release' },
  files: ['dist/**', 'dist-electron/**'],
  // steamworks.js is a prebuilt N-API native module — it cannot live inside
  // the asar (native .node binaries must be real files on disk for dlopen).
  // Unpacking keeps the require path working from the main process while the
  // steam_api64.dll redistributable ships alongside it.
  asarUnpack: ['node_modules/steamworks.js/**/*'],
  extraResources: [
    { from: 'node_modules/ffmpeg-static', to: 'ffmpeg-static', filter: ['*.exe', 'ffmpeg', '*.dylib*', '*.so*'] },
  ],
};

// The livery Workshop uploader runs SteamAPI in a short-lived plain-node child
// (electron/steam-workshop-worker.js) so Steam stops reporting the game as
// running once the upload finishes. Plain-node children cannot read inside the
// asar, so the worker + its shared core ship as real files in resources/.
const WORKSHOP_WORKER_RESOURCES = [
  { from: 'electron/steam-workshop-worker.js', to: 'steam-workshop-worker.js' },
  { from: 'electron/steam-workshop-core.js', to: 'steam-workshop-core.js' },
];

/** Voice-only extraResources — everything the vosk worker child needs at
 *  runtime (it runs as plain node via ELECTRON_RUN_AS_NODE, which has no
 *  asar support, so these land beside the app in resources/).
 *  Models: en = LARGE vosk-model-en-us-0.22 (~1.9 GB, accuracy — the small
 *  en-us-0.15 was ditched), zh = small vosk-model-small-cn-0.22.
 *  Keep this list in sync with the constants in electron/voice-stt-vosk.js. */
const VOICE_RESOURCES = [
  { from: 'electron/voice-stt-vosk.js', to: 'voice-stt-vosk.js' },
  { from: 'electron/voskFfi.js', to: 'voskFfi.js' },
  { from: 'electron/voice-grammar.json', to: 'voice-grammar.json' },
  { from: 'bin/sox', to: 'sox' },
  { from: 'models/vosk-model-en-us-0.22', to: 'models/vosk-model-en-us-0.22' },
  { from: 'models/vosk-model-small-cn-0.22', to: 'models/vosk-model-small-cn-0.22' },
  { from: 'bin/vosk', to: 'vosk' },
  { from: 'node_modules/koffi', to: 'node_modules/koffi' },
  { from: 'node_modules/@koromix/koffi-win32-x64', to: 'node_modules/@koromix/koffi-win32-x64' },
];

function fail(msg) {
  console.error(`BUILD FAILED: ${msg}`);
  process.exit(1);
}

// Platform configs are added per-request — electron-builder builds whatever
// platforms appear in the config (no explicit `targets` — a string target in
// the config is what it resolves).
const config = { ...BASE };
const win = {
  target: 'portable',
  icon: 'icon.ico',
  artifactName: 'AC27Editor.${ext}',
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg.exe', to: 'ffmpeg.exe' }, ...WORKSHOP_WORKER_RESOURCES],
};

if (isVoice) {
  if (!fs.existsSync(path.join(__dirname, 'models', 'vosk-model-en-us-0.22', 'conf', 'model.conf')) ||
      !fs.existsSync(path.join(__dirname, 'models', 'vosk-model-small-cn-0.22', 'conf', 'model.conf'))) {
    fail('voice build needs the vosk models — run `node scripts/fetch-vosk-model.mjs` first');
  }
  if (!fs.existsSync(path.join(__dirname, 'bin', 'sox', 'sox.exe'))) {
    fail('voice build needs bin/sox/sox.exe (committed binary — see bin/sox/README.md)');
  }
  if (!fs.existsSync(path.join(__dirname, 'bin', 'vosk', 'libvosk.dll'))) {
    fail('voice build needs bin/vosk/libvosk.dll (committed binary — see bin/vosk/README.md)');
  }
  win.extraResources = [...win.extraResources, ...VOICE_RESOURCES];
  win.artifactName = 'AC27EditorVoice.${ext}';
  console.log('[build] voice variant — bundling STT models/sox/vosk');
}

if (isWorkshop) {
  if (isVoice) fail('workshop + voice combo not supported — workshop is non-voice only (Voice stays GitHub/R2)');
  // Marker file baked into resources — updater checks for it even after exe is moved
  const markerPath = path.join(__dirname, STEAM_WORKSHOP_SOURCE_MARKER);
  fs.writeFileSync(markerPath, JSON.stringify({ workshop: true, disableAutoUpdate: true }), 'utf-8');
  const workshopResources = [{ from: STEAM_WORKSHOP_SOURCE_MARKER, to: STEAM_WORKSHOP_MARKER }];
  // Optionally bundle the plugin DLL inside resources/ so the exe is self-
  // contained even if the sibling copy in the Workshop folder is moved. The
  // release workflow also copies the DLL as a sibling alongside the exe in
  // steam-workshop-content/ — either location is accepted by
  // resolveWorkshopBundledDllPath() (resources/AC27Approach.dll or
  // <exe-dir>/AC27Approach.dll). CI builds plugin separately, so the artifact
  // may not exist when the workshop exe is built — that's fine; the release
  // job's sibling copy is the authoritative Workshop distribution.
  const pluginRelCandidates = [
    'mods/AC27Approach/bin/Release/net6.0/AC27Approach.dll',
    'mods/AC27Approach/bin/Debug/net6.0/AC27Approach.dll',
  ];
  const bundledRel = pluginRelCandidates.find(rel => fs.existsSync(path.join(__dirname, rel)));
  if (bundledRel) {
    workshopResources.push({ from: bundledRel, to: 'AC27Approach.dll' });
    console.log('[build] workshop variant — bundling', bundledRel, 'as resources/AC27Approach.dll');
  } else {
    console.log('[build] workshop variant — no plugin DLL found to bundle (release workflow will copy sibling AC27Approach.dll alongside exe)');
  }
  win.extraResources = [...(win.extraResources || []), ...workshopResources];
  win.artifactName = STEAM_WORKSHOP_ARTIFACT + '.${ext}';
  console.log('[build] workshop variant — auto-update DISABLED (Steam Workshop handles updates), plugin via bundled/sibling DLL');
}

if (isWin || (!isWin && !isMac && !isLinux)) config.win = win;
if (isMac) config.mac = {
  // Universal DMG (x64 + arm64) — works on Intel and Apple Silicon. Both
  // slices are merged by @electron/universal, which keeps byte-identical files
  // as-is (SHA-checked) instead of lipo-ing them, so the per-host prebuilt
  // native deps in node_modules do not break the merge. Caveat: the bundled
  // ffmpeg-static binary is host-arch only, so the universal app still carries
  // a single-arch ffmpeg — background-video conversion fails on the opposite
  // architecture (an Intel Mac cannot run an arm64-only ffmpeg).
  target: [{ target: 'dmg', arch: ['universal'] }],
  icon: 'icon.png',
  category: 'public.app-category.utilities',
  artifactName: 'AC27Editor.${ext}',
  // Unsigned distribution — force electron-builder to skip code signing
  // deterministically (no Apple Developer ID cert is provided in CI). The
  // resulting app is unsigned, so macOS Gatekeeper quarantines it on download
  // and reports "AC27 Editor.app is damaged and can't be opened". The fix is
  // documented in the README (macOS Gatekeeper section): clear the quarantine
  // attribute — `xattr -cr "/Applications/AC27 Editor.app"`.
  identity: null,
  x64ArchFiles: '**/Contents/Resources/**/ffmpeg',
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg', to: 'ffmpeg' }, ...WORKSHOP_WORKER_RESOURCES],
};
if (isLinux) config.linux = {
  target: ['AppImage', 'deb'],
  icon: 'icon.png',
  category: 'Utility',
  maintainer: 'AC27 Editor contributors',
  artifactName: 'AC27Editor.${ext}',
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg', to: 'ffmpeg' }, ...WORKSHOP_WORKER_RESOURCES],
};

builder.build({ config, publish }).then((result) => {
  console.log('BUILD SUCCESS!');
  console.log(JSON.stringify(result, null, 2));
}).catch((err) => {
  console.error('BUILD FAILED:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});

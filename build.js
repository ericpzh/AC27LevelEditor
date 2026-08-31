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
  extraResources: [
    { from: 'node_modules/ffmpeg-static', to: 'ffmpeg-static', filter: ['*.exe', 'ffmpeg', '*.dylib*', '*.so*'] },
  ],
};

/** Voice-only extraResources — everything the vosk worker child needs at
 *  runtime (it runs as plain node via ELECTRON_RUN_AS_NODE, which has no
 *  asar support, so these land beside the app in resources/).
 *  Models: en = LARGE vosk-model-en-us-0.22 (~1.9 GB, accuracy — the small
 *  en-us-0.15 was ditched 2026-08-06), zh = small vosk-model-small-cn-0.22.
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
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg.exe', to: 'ffmpeg.exe' }],
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
  const markerPath = path.join(__dirname, '.workshop-marker.json');
  fs.writeFileSync(markerPath, JSON.stringify({ workshop: true, disableAutoUpdate: true }), 'utf-8');
  win.extraResources = [...(win.extraResources || []), { from: '.workshop-marker.json', to: 'workshop.json' }];
  win.artifactName = 'AC27EditorWorkshop.${ext}';
  console.log('[build] workshop variant — auto-update DISABLED (Steam Workshop handles updates)');
}

if (isWin || (!isWin && !isMac && !isLinux)) config.win = win;
if (isMac) config.mac = {
  target: 'dmg',
  icon: 'icon.png',
  category: 'public.app-category.utilities',
  artifactName: 'AC27Editor.${ext}',
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg', to: 'ffmpeg' }],
};
if (isLinux) config.linux = {
  target: ['AppImage', 'deb'],
  icon: 'icon.png',
  category: 'Utility',
  maintainer: 'AC27 Editor contributors',
  artifactName: 'AC27Editor.${ext}',
  extraResources: [{ from: 'node_modules/ffmpeg-static/ffmpeg', to: 'ffmpeg' }],
};

builder.build({ config, publish }).then((result) => {
  console.log('BUILD SUCCESS!');
  console.log(JSON.stringify(result, null, 2));
}).catch((err) => {
  console.error('BUILD FAILED:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});

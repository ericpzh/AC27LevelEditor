import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const gamePaths = require('../../src/utils/gamePaths.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, '..');            // tests/
const ROOT = path.resolve(TESTS_DIR, '..');                 // repo root
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures', 'game-root');
const FIXTURES_V3_DIR = path.join(TESTS_DIR, 'fixtures', 'game-root-v3');
const TMP_DIR = path.join(TESTS_DIR, 'tmp-e2e');
const USERDATA_DIR = path.join(TESTS_DIR, 'tmp-e2e-userdata');

// ── Single source of truth ───────────────────────────────────────
// Import the app's own visibility whitelists instead of duplicating them.
// `ui.js` cannot be imported by file path under Playwright's loader (the repo
// is CommonJS, ui.js is ESM-only), so evaluate its SOURCE via a data: URL —
// Node's ESM loader handles that directly. E2E staging then stays in lockstep
// with prod/demo mode: EVERY production file is staged and iterated. Update
// levels in src/utils/constants/ui.js only.
const UI_CONSTANTS_PATH = path.join(ROOT, 'src', 'utils', 'constants', 'ui.js');
const { PROD_VISIBLE_BASES, DEMO_VISIBLE_ORDER } = await import(
  'data:text/javascript;base64,' + Buffer.from(readFileSync(UI_CONSTANTS_PATH, 'utf-8')).toString('base64')
);
// Union of prod + demo filenames (ZSJN_leisure_1.acl is in both).
const STAGE_BASENAMES = [...new Set([...PROD_VISIBLE_BASES, ...DEMO_VISIBLE_ORDER])];

function copyFileIfPresent(src, dst) {
  if (!src || !dst || !existsSync(src)) return false;
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst);
  return true;
}

export default async function () {
  gamePaths.clearCache();

  // 1. Clean up from previous run
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  if (existsSync(USERDATA_DIR)) rmSync(USERDATA_DIR, { recursive: true });

  // Optional test-only fault injection for exercising the missing-audio
  // staging failure path (e.g. `E2E_OMIT_V3_AUDIO=1` or `clips,channel`).
  const omitTokens = new Set(
    String(process.env.E2E_OMIT_V3_AUDIO || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const omitAllV3Audio = omitTokens.has('1') || omitTokens.has('all') || omitTokens.has('true');
  const omitCatalog = omitAllV3Audio || omitTokens.has('catalog');
  const omitClips = omitAllV3Audio || omitTokens.has('clips');
  const omitChannel = omitAllV3Audio || omitTokens.has('channel');

  // 2. Copy game data → temp
  const gameRoot = process.env.E2E_GAME_ROOT;
  if (gameRoot && existsSync(gameRoot)) {
    console.log(`[E2E setup] Sourcing ${STAGE_BASENAMES.length} prod+demo files from:`, gameRoot);
    const srcAirports = gamePaths.airportsDir(gameRoot);
    const dstAirports = gamePaths.airportsDir(TMP_DIR);

    // Map each whitelisted basename → its airport by scanning the Levels dirs.
    const basenameToIcao = new Map();
    if (existsSync(srcAirports)) {
      for (const ae of readdirSync(srcAirports, { withFileTypes: true })) {
        if (!ae.isDirectory()) continue;
        const levelsDir = gamePaths.levelsDir(gameRoot, ae.name);
        if (!existsSync(levelsDir)) continue;
        for (const le of readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && !basenameToIcao.has(le.name)) basenameToIcao.set(le.name, ae.name);
        }
      }
    }

    const involvedIcaos = new Set();
    let staged = 0;
    for (const name of STAGE_BASENAMES) {
      const icao = basenameToIcao.get(name);
      if (!icao) {
        console.log(`  SKIP (not found): ${name}`);
        continue;
      }
      const srcLevels = gamePaths.levelsDir(gameRoot, icao);
      const dstDir = gamePaths.levelsDir(TMP_DIR, icao);
      const srcFile = path.join(srcLevels, name);
      mkdirSync(dstDir, { recursive: true });
      cpSync(srcFile, path.join(dstDir, name));
      staged++;
      involvedIcaos.add(icao);

      // For .demo.acl files, also copy the parent .acl they derive from.
      if (name.endsWith('.demo.acl')) {
        const parentName = name.replace('.demo.acl', '.acl');
        const parentSrc = path.join(srcLevels, parentName);
        if (existsSync(parentSrc)) cpSync(parentSrc, path.join(dstDir, parentName));
      }
    }

    // Re-clear gamePaths cache now that TMP_DIR/GroundATC_Data/StreamingAssets exists
    gamePaths.clearCache();

    // For every involved airport, stage the non-.acl companions (embedded
    // timeline JSON, .aclcfg, flight-schedule CSVs, legacy v2 audio clips,
    // v3 radio_channel_config.json, airport config) so the editor loads and
    // validates each level against the same inputs as the target game.
    for (const icao of involvedIcaos) {
      const srcLevels = gamePaths.levelsDir(gameRoot, icao);
      const dstLevels = gamePaths.levelsDir(TMP_DIR, icao);
      for (const le of readdirSync(srcLevels, { withFileTypes: true })) {
        if (!le.isFile()) continue;
        if (le.name.endsWith('.acl') || le.name.endsWith('.acl.bak')) continue;
        cpSync(path.join(srcLevels, le.name), path.join(dstLevels, le.name));
      }

      if (!omitChannel) {
        copyFileIfPresent(
          gamePaths.radioChannelConfigPath(gameRoot, icao),
          gamePaths.radioChannelConfigPath(TMP_DIR, icao),
        );
      }

      const srcAirportDir = gamePaths.airportDir(gameRoot, icao);
      const dstAirportDir = gamePaths.airportDir(TMP_DIR, icao);
      for (const extraName of [
        'airport_config.json',
        'airport_brief.json',
        'radio_template_en.csv',
        'radio_template_zh.csv',
        'audio_clips_en.json',
        'audio_clips_zh.json',
        'geo_data.osm',
      ]) {
        const extraSrc = path.join(srcAirportDir, extraName);
        const extraDst = path.join(dstAirportDir, extraName);
        if (existsSync(extraSrc) && !existsSync(extraDst)) {
          copyFileIfPresent(extraSrc, extraDst);
        }
      }
    }

    // Stage the voice catalog (`Voices/voice_catalog.json`) so the editor's
    // Voice/Language/Role validation runs against the real voice catalog.
    if (!omitCatalog) {
      const voicesSrc = gamePaths.voicesDir(gameRoot);
      const voicesDst = gamePaths.voicesDir(TMP_DIR);
      if (existsSync(voicesSrc)) {
        mkdirSync(path.dirname(voicesDst), { recursive: true });
        cpSync(voicesSrc, voicesDst, { recursive: true });
      } else {
        copyFileIfPresent(
          gamePaths.voiceCatalogPath(gameRoot),
          gamePaths.voiceCatalogPath(TMP_DIR),
        );
      }
    }

    // Stage shared `radio_clip_durations.json` so v3 per-voice callsign
    // allocation checks match the installed game's clip library.
    if (!omitClips) {
      copyFileIfPresent(
        gamePaths.radioClipDurationsPath(gameRoot),
        gamePaths.radioClipDurationsPath(TMP_DIR),
      );
    }

    // Stage the airline country registry & registration rules (legacy/v2 + shared).
    copyFileIfPresent(
      gamePaths.airlineCountryRegistryPath(gameRoot),
      gamePaths.airlineCountryRegistryPath(TMP_DIR),
    );
    copyFileIfPresent(
      path.join(gamePaths.streamingAssets(gameRoot), 'aircraft_registration_rules.cfg'),
      path.join(gamePaths.streamingAssets(TMP_DIR), 'aircraft_registration_rules.cfg'),
    );

    // Aircraft placement depends on the real profile wheelbase values.
    const profilesSrc = gamePaths.aircraftProfilesCsvPath(gameRoot);
    const profilesDst = gamePaths.aircraftProfilesCsvPath(TMP_DIR);
    if (!existsSync(profilesSrc)) throw new Error(`Missing aircraft profiles: ${profilesSrc}`);
    copyFileIfPresent(profilesSrc, profilesDst);

    console.log(`[E2E setup] Staged ${staged} files to ${TMP_DIR}`);
  } else {
    // Fall back to committed fixture (`tests/fixtures/game-root` by default, or
    // `tests/fixtures/game-root-v3` when `E2E_FIXTURE_V3=1`); copy
    // `ZSJN_leisure_1.acl` to `ZSJN_leisure_2.acl` if absent so the browser
    // shows two rows in prod mode (only whitelisted names are listed).
    const fixtureSrc = process.env.E2E_FIXTURE_V3 === '1' ? FIXTURES_V3_DIR : FIXTURES_DIR;
    cpSync(fixtureSrc, TMP_DIR, { recursive: true });
    gamePaths.clearCache();
    const zsjnLevels = gamePaths.levelsDir(TMP_DIR, 'ZSJN');
    const srcFile = path.join(zsjnLevels, 'ZSJN_leisure_1.acl');
    const dstFile = path.join(zsjnLevels, 'ZSJN_leisure_2.acl');
    if (existsSync(srcFile) && !existsSync(dstFile)) cpSync(srcFile, dstFile);
    if (omitCatalog) rmSync(gamePaths.voiceCatalogPath(TMP_DIR), { force: true });
    if (omitClips) rmSync(gamePaths.radioClipDurationsPath(TMP_DIR), { force: true });
    if (omitChannel) rmSync(gamePaths.radioChannelConfigPath(TMP_DIR, 'ZSJN'), { force: true });
    console.log('[E2E setup] Fixtures copied from', fixtureSrc, 'to', TMP_DIR);
  }

  // 3. Create userData dir and pre-write lastRoot.json
  mkdirSync(USERDATA_DIR, { recursive: true });
  writeFileSync(
    path.join(USERDATA_DIR, 'lastRoot.json'),
    JSON.stringify({ rootPath: TMP_DIR }),
    'utf-8'
  );

  // Pre-write cache.json with a chosen language so the first-launch language
  // picker never blocks the E2E specs (cacheVersion 0 → get-cache-state reports
  // 'mismatch', which boot still treats as usable; the scan rebuilds it).
  writeFileSync(
    path.join(USERDATA_DIR, 'cache.json'),
    JSON.stringify({ cacheVersion: 0, gameRoot: TMP_DIR, lang: 'en', flags: {}, airports: {} }),
    'utf-8'
  );

  // 4. Expose paths to tests via env
  process.env.E2E_TMP_DIR = TMP_DIR;
  process.env.E2E_USERDATA_DIR = USERDATA_DIR;

  console.log('[E2E setup] UserData dir:', USERDATA_DIR);
}

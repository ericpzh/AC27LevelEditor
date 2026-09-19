import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, '..');            // tests/
const ROOT = path.resolve(TESTS_DIR, '..');                 // repo root
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures', 'game-root');
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

export default async function () {
  // 1. Clean up from previous run
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  if (existsSync(USERDATA_DIR)) rmSync(USERDATA_DIR, { recursive: true });

  // 2. Copy game data → temp
  const gameRoot = process.env.E2E_GAME_ROOT;
  if (gameRoot && existsSync(gameRoot)) {
    console.log(`[E2E setup] Sourcing ${STAGE_BASENAMES.length} prod+demo files from:`, gameRoot);
    const srcAirports = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    const dstAirports = path.join(TMP_DIR, 'GroundATC_Data', 'StreamingAssets', 'Airports');

    // Map each whitelisted basename → its airport by scanning the Levels dirs.
    const basenameToIcao = new Map();
    for (const ae of readdirSync(srcAirports, { withFileTypes: true })) {
      if (!ae.isDirectory()) continue;
      const levelsDir = path.join(srcAirports, ae.name, 'Levels');
      if (!existsSync(levelsDir)) continue;
      for (const le of readdirSync(levelsDir, { withFileTypes: true })) {
        if (le.isFile() && !basenameToIcao.has(le.name)) basenameToIcao.set(le.name, ae.name);
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
      const srcFile = path.join(srcAirports, icao, 'Levels', name);
      const dstDir = path.join(dstAirports, icao, 'Levels');
      mkdirSync(dstDir, { recursive: true });
      cpSync(srcFile, path.join(dstDir, name));
      staged++;
      involvedIcaos.add(icao);

      // For .demo.acl files, also copy the parent .acl they derive from.
      if (name.endsWith('.demo.acl')) {
        const parentName = name.replace('.demo.acl', '.acl');
        const parentSrc = path.join(srcAirports, icao, 'Levels', parentName);
        if (existsSync(parentSrc)) cpSync(parentSrc, path.join(dstDir, parentName));
      }
    }

    // For every involved airport, stage the non-.acl companions (embedded
    // timeline JSON, .aclcfg, flight-schedule CSVs, audio clips, airport
    // config) so the editor loads and validates each level fully.
    for (const icao of involvedIcaos) {
      const srcLevels = path.join(srcAirports, icao, 'Levels');
      const dstLevels = path.join(dstAirports, icao, 'Levels');
      for (const le of readdirSync(srcLevels, { withFileTypes: true })) {
        if (!le.isFile()) continue;
        if (le.name.endsWith('.acl') || le.name.endsWith('.acl.bak')) continue;
        cpSync(path.join(srcLevels, le.name), path.join(dstLevels, le.name));
      }
      const cfgSrc = path.join(srcAirports, icao, 'airport_config.json');
      const cfgDst = path.join(dstAirports, icao, 'airport_config.json');
      if (existsSync(cfgSrc) && !existsSync(cfgDst)) cpSync(cfgSrc, cfgDst);
    }

    // Stage the voice catalog so the editor's renderer-side Voice/Language
    // validation and the save-pipeline voice repair run against the real map
    // (the game throws InvalidOperationException on a voice/language mismatch).
    const voicesSrc = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Voices');
    const voicesDst = path.join(TMP_DIR, 'GroundATC_Data', 'StreamingAssets', 'Voices');
    if (existsSync(voicesSrc)) cpSync(voicesSrc, voicesDst, { recursive: true });

    console.log(`[E2E setup] Staged ${staged} files to ${TMP_DIR}`);
  } else {
    // Fall back to committed fixture (ZSJN_leisure_1.acl); copy it to
    // ZSJN_leisure_2.acl so the browser shows two rows in prod mode
    // (only whitelisted names are listed)
    cpSync(FIXTURES_DIR, TMP_DIR, { recursive: true });
    const zsjnLevels = path.join(TMP_DIR, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN', 'Levels');
    const srcFile = path.join(zsjnLevels, 'ZSJN_leisure_1.acl');
    const dstFile = path.join(zsjnLevels, 'ZSJN_leisure_2.acl');
    if (existsSync(srcFile) && !existsSync(dstFile)) cpSync(srcFile, dstFile);
    console.log('[E2E setup] Fixtures copied to', TMP_DIR);
  }

  // 3. Create userData dir and pre-write lastRoot.json
  mkdirSync(USERDATA_DIR, { recursive: true });
  writeFileSync(
    path.join(USERDATA_DIR, 'lastRoot.json'),
    JSON.stringify({ rootPath: TMP_DIR }),
    'utf-8'
  );

  // 4. Expose paths to tests via env
  process.env.E2E_TMP_DIR = TMP_DIR;
  process.env.E2E_USERDATA_DIR = USERDATA_DIR;

  console.log('[E2E setup] UserData dir:', USERDATA_DIR);
};

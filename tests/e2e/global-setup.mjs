import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.resolve(__dirname, '..');            // tests/
const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures', 'game-root');
const TMP_DIR = path.join(TESTS_DIR, 'tmp-e2e');
const USERDATA_DIR = path.join(TESTS_DIR, 'tmp-e2e-userdata');

// ── 12 prod+demo files to include when sourcing from real game ──
const PROD_DEMO_FILES = [
  'ZSJN/ZSJN-Morning_120min.acl', 'ZSJN/ZSJN_07-10.acl',
  'ZSJN/ZSJN-Evening_120min.acl', 'ZSJN/ZSJN_19-21.acl',
  'ZSJN/ZSJN-Morning_120min.demo.acl', 'ZSJN/ZSJN_07-10.demo.acl',
  'KJFK/KJFK_07-09.acl', 'KJFK/KJFK_09-11.acl',
  'KJFK/KJFK_17-20.acl', 'KJFK/KJFK_20-22.acl',
  'KJFK/KJFK_09-11.demo.acl', 'KJFK/KJFK_20-22.demo.acl',
];

export default async function () {
  // 1. Clean up from previous run
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  if (existsSync(USERDATA_DIR)) rmSync(USERDATA_DIR, { recursive: true });

  // 2. Copy game data → temp
  const gameRoot = process.env.E2E_GAME_ROOT;
  if (gameRoot && existsSync(gameRoot)) {
    // Source from real game installation — copy the 12 specific files
    console.log('[E2E setup] Sourcing 12 prod+demo files from:', gameRoot);
    const srcAirports = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    const dstAirports = path.join(TMP_DIR, 'GroundATC_Data', 'StreamingAssets', 'Airports');

    for (const relPath of PROD_DEMO_FILES) {
      const [icao, name] = relPath.split('/');
      const srcFile = path.join(srcAirports, icao, 'Levels', name);
      const dstDir = path.join(dstAirports, icao, 'Levels');
      if (!existsSync(srcFile)) {
        console.log(`  SKIP (not found): ${relPath}`);
        continue;
      }
      mkdirSync(dstDir, { recursive: true });
      cpSync(srcFile, path.join(dstDir, name));

      // Copy associated timeline JSONs and config
      const srcLevelDir = path.join(srcAirports, icao, 'Levels');
      const baseName = name.replace(/\.acl$/, '');
      const jsonPatterns = [
        'weather_timeline.json', 'wind_timeline.json',
        `runway_timeline_${baseName}.json`,
      ];
      for (const pat of jsonPatterns) {
        const jsonSrc = path.join(srcLevelDir, pat);
        if (existsSync(jsonSrc)) cpSync(jsonSrc, path.join(dstDir, pat));
      }

      // Copy airport_config.json if not already copied
      const cfgSrc = path.join(srcAirports, icao, 'airport_config.json');
      const cfgDst = path.join(dstAirports, icao, 'airport_config.json');
      if (existsSync(cfgSrc) && !existsSync(cfgDst)) cpSync(cfgSrc, cfgDst);

      // For .demo.acl files, also copy the parent .acl
      if (name.endsWith('.demo.acl')) {
        const parentName = name.replace('.demo.acl', '.acl');
        const parentSrc = path.join(srcLevelDir, parentName);
        if (existsSync(parentSrc)) cpSync(parentSrc, path.join(dstDir, parentName));
      }
    }
    // Copy audio clips + CSV files for each airport (needed for validation)
    const airportsDone = new Set();
    for (const relPath of PROD_DEMO_FILES) {
      const [icao] = relPath.split('/');
      if (airportsDone.has(icao)) continue;
      airportsDone.add(icao);
      const srcLevels = path.join(srcAirports, icao, 'Levels');
      const dstLevels = path.join(dstAirports, icao, 'Levels');
      // Audio clips (language detection + callsign validation)
      for (const clip of ['audio_clips_en.json', 'audio_clips_zh.json']) {
        const s = path.join(srcLevels, clip);
        if (existsSync(s)) cpSync(s, path.join(dstLevels, clip));
      }
      // CSV flight schedules (config reference)
      const levelEnts = readdirSync(srcLevels, { withFileTypes: true });
      for (const le of levelEnts) {
        if (le.isFile() && le.name.endsWith('.csv')) {
          cpSync(path.join(srcLevels, le.name), path.join(dstLevels, le.name));
        }
      }
    }
    console.log(`[E2E setup] Copied files to ${TMP_DIR}`);
  } else {
    // Fall back to committed fixture (1-2 ZSJN files)
    cpSync(FIXTURES_DIR, TMP_DIR, { recursive: true });
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

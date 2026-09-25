// @vitest-environment node

/**
 * Tests for electron/reset-levels.js — the "Restore All Levels" filesystem reset.
 *
 * Deletes every Levels entry AND the airport scenery file the Ground Painter
 * syncs (Config.geoDataFile `.osm`) so Steam Verify re-downloads pristine
 * copies. Pure-FS module (no electron), so these are real temp-dir tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { resetAllLevels, collectGeoDataFiles, DEFAULT_GEO_DATA_FILE } = require('../../electron/reset-levels');
const gp = require('../../src/utils/gamePaths');

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeAirports() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-reset-'));
  tmpDirs.push(root);
  const airports = path.join(root, 'Airports');
  fs.mkdirSync(airports, { recursive: true });
  return airports;
}

/** Create <airports>/<ICAO>/Levels with the given files + airport-dir scenery. */
function writeAirport(airports, icao, { levels = {}, airportFiles = {} } = {}) {
  const airportDir = path.join(airports, icao);
  const levelsDir = path.join(airportDir, 'Levels');
  fs.mkdirSync(levelsDir, { recursive: true });
  for (const [name, content] of Object.entries(levels)) {
    fs.writeFileSync(path.join(levelsDir, name), content);
  }
  for (const [name, content] of Object.entries(airportFiles)) {
    fs.writeFileSync(path.join(airportDir, name), content);
  }
  return { airportDir, levelsDir };
}

const aclcfg = (geoDataFile) => JSON.stringify({ prototypeName: 'X', geoDataFile });

describe('reset-levels (Restore All)', () => {
  it('deletes every Levels entry and the default geo_data.osm', () => {
    const airports = makeAirports();
    const { airportDir, levelsDir } = writeAirport(airports, 'ZGSZ', {
      levels: {
        'ZGSZ_leisure_1.acl': 'acl',
        'ZGSZ_leisure_1.acl.bak': 'bak',
        'ZGSZ_leisure_1.aclcfg': aclcfg('geo_data'),
        'ZGSZ_leisure_1.timeline.json': '{}',
      },
      airportFiles: {
        'geo_data.osm': '<osm/>',
        'geo_data.osm.bak': '<osm-bak/>',
      },
    });
    fs.mkdirSync(path.join(levelsDir, 'subdir'));
    fs.writeFileSync(path.join(levelsDir, 'subdir', 'x.txt'), 'x');

    const r = resetAllLevels(airports, { log: () => {}, error: () => {} });

    expect(r.airports).toBe(1);
    // 4 levels files + 1 subdir + geo_data.osm + geo_data.osm.bak
    expect(r.deletedCount).toBe(7);
    expect(fs.readdirSync(levelsDir)).toEqual([]);
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(false);
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm.bak'))).toBe(false);
  });

  it('uses a custom Config.geoDataFile from .aclcfg and leaves other .osm alone', () => {
    const airports = makeAirports();
    const { airportDir, levelsDir } = writeAirport(airports, 'ZSJN', {
      levels: {
        'ZSJN_taixwayclosed.acl': 'acl',
        'ZSJN_taixwayclosed.aclcfg': aclcfg('geo_data_taxiwayclosed'),
      },
      airportFiles: {
        'geo_data_taxiwayclosed.osm': '<osm/>',
        'geo_data.osm': '<unused/>',
        'taxi_nav_data.osm': '<keep/>',
        'visual_data.osm': '<keep/>',
        'geo_data_backup.osm': '<keep/>',
      },
    });

    const r = resetAllLevels(airports, { log: () => {}, error: () => {} });

    expect(r.deletedCount).toBe(3); // acl + aclcfg + geo_data_taxiwayclosed.osm
    expect(fs.readdirSync(levelsDir)).toEqual([]);
    expect(fs.existsSync(path.join(airportDir, 'geo_data_taxiwayclosed.osm'))).toBe(false);
    // Not the level's geoDataFile -> untouched.
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(true);
    expect(fs.existsSync(path.join(airportDir, 'taxi_nav_data.osm'))).toBe(true);
    expect(fs.existsSync(path.join(airportDir, 'visual_data.osm'))).toBe(true);
    expect(fs.existsSync(path.join(airportDir, 'geo_data_backup.osm'))).toBe(true);
  });

  it('falls back to geo_data when the airport has no .aclcfg sidecars', () => {
    const airports = makeAirports();
    const { airportDir } = writeAirport(airports, 'KJFK', {
      levels: { 'KJFK_leisure_1.acl': 'acl' },
      airportFiles: { 'geo_data.osm': '<osm/>', 'taxi_nav_data.osm': '<keep/>' },
    });

    resetAllLevels(airports, { log: () => {}, error: () => {} });

    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(false);
    expect(fs.existsSync(path.join(airportDir, 'taxi_nav_data.osm'))).toBe(true);
  });

  it('skips airports without a Levels dir and processes the rest', () => {
    const airports = makeAirports();
    fs.mkdirSync(path.join(airports, 'NOSCENERY')); // no Levels/
    const { airportDir } = writeAirport(airports, 'KDCA', {
      levels: { 'KDCA_leisure_1.acl': 'acl', 'KDCA_leisure_1.aclcfg': aclcfg('geo_data') },
      airportFiles: { 'geo_data.osm': '<osm/>' },
    });

    const r = resetAllLevels(airports, { log: () => {}, error: () => {} });

    expect(r.airports).toBe(1);
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(false);
    expect(fs.existsSync(path.join(airports, 'NOSCENERY'))).toBe(true);
  });

  it('throws AIRPORTS_DIR_NOT_FOUND for a missing airports dir', () => {
    let err;
    try {
      resetAllLevels(path.join(os.tmpdir(), 'ac27-does-not-exist-' + Date.now()), { log: () => {}, error: () => {} });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.code).toBe('AIRPORTS_DIR_NOT_FOUND');
  });
});

describe('collectGeoDataFiles', () => {
  it('tolerates malformed .aclcfg and still falls back to the default', () => {
    const airports = makeAirports();
    const { levelsDir } = writeAirport(airports, 'ZGSZ', {
      levels: { 'ZGSZ_x.aclcfg': '{ not json' },
    });
    const entries = fs.readdirSync(levelsDir, { withFileTypes: true });
    const set = collectGeoDataFiles(levelsDir, entries);
    expect([...set]).toEqual([DEFAULT_GEO_DATA_FILE]);
  });
});

describe('macOS layout (gamePaths → reset-levels)', () => {
  it('finds Levels + geoDataFile inside a .app bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-reset-mac-'));
    tmpDirs.push(root);
    gp.clearCache();
    const data = path.join(root, 'GroundATC.app', 'Contents', 'Resources', 'Data');
    const levels = path.join(data, 'StreamingAssets', 'Airports', 'ZGSZ', 'Levels');
    fs.mkdirSync(levels, { recursive: true });
    const airportDir = path.dirname(levels);
    fs.writeFileSync(path.join(levels, 'ZGSZ_leisure_1.acl'), 'acl');
    fs.writeFileSync(path.join(levels, 'ZGSZ_leisure_1.aclcfg'), aclcfg('geo_data'));
    fs.writeFileSync(path.join(airportDir, 'geo_data.osm'), '<osm/>');

    const airportsDir = gp.airportsDir(root);
    expect(airportsDir).toBe(path.join(data, 'StreamingAssets', 'Airports'));

    const r = resetAllLevels(airportsDir, { log: () => {}, error: () => {} });

    expect(r.deletedCount).toBe(3); // .acl + .aclcfg + geo_data.osm
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(false);
    gp.clearCache();
  });

  it('locates a differently-cased levels dir (case-sensitive volume)', () => {
    const airports = makeAirports();
    const { airportDir } = writeAirport(airports, 'ZGSZ', {
      levels: { 'ZGSZ_x.acl': 'acl', 'ZGSZ_x.aclcfg': aclcfg('geo_data') },
    });
    fs.renameSync(path.join(airportDir, 'Levels'), path.join(airportDir, 'levels'));
    fs.writeFileSync(path.join(airportDir, 'geo_data.osm'), '<osm/>');

    const r = resetAllLevels(airports, { log: () => {}, error: () => {} });

    expect(r.airports).toBe(1);
    expect(fs.existsSync(path.join(airportDir, 'geo_data.osm'))).toBe(false);
  });
});

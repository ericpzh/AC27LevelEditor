/**
 * Unit test: _parseStandPositions
 *
 * Parses the ZSJN fixture .acl and verifies stand position extraction.
 * Imports directly from scenery.js (pure CJS) to avoid ESM/CJS interop issues.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { _parseStandPositions } = require('../../src/acl/scenery');

const FIXTURE_PATH = path.join(
  __dirname,
  '..', 'fixtures', 'game-root', 'GroundATC_Data', 'StreamingAssets',
  'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.acl'
);

const text = fs.readFileSync(FIXTURE_PATH, 'utf-8');
const stands = _parseStandPositions(text);

describe('_parseStandPositions', () => {
  it('should parse stands from ZSJN fixture (53 stands)', () => {
    expect(stands).toBeDefined();
    expect(typeof stands).toBe('object');
    expect(Object.keys(stands)).toHaveLength(53);
  });

  it('should have stand "300" with valid finite coordinates', () => {
    expect(stands['300']).toBeDefined();
    expect(Number.isFinite(stands['300'].x)).toBe(true);
    expect(Number.isFinite(stands['300'].y)).toBe(true);
  });

  it('should have stand "1" with valid finite coordinates', () => {
    expect(stands['1']).toBeDefined();
    expect(Number.isFinite(stands['1'].x)).toBe(true);
    expect(Number.isFinite(stands['1'].y)).toBe(true);
  });

  it('should have stand "22" with valid finite coordinates', () => {
    expect(stands['22']).toBeDefined();
    expect(Number.isFinite(stands['22'].x)).toBe(true);
    expect(Number.isFinite(stands['22'].y)).toBe(true);
  });

  it('all stands should have finite numeric coordinates', () => {
    for (const [id, pos] of Object.entries(stands)) {
      expect(Number.isFinite(pos.x), `stand "${id}" x=${pos.x} should be finite`).toBe(true);
      expect(Number.isFinite(pos.y), `stand "${id}" y=${pos.y} should be finite`).toBe(true);
    }
  });

  it('stand positions should be within reasonable coordinate bounds', () => {
    for (const [id, pos] of Object.entries(stands)) {
      expect(Math.abs(pos.x), `stand "${id}" x=${pos.x} too large`).toBeLessThan(20);
      expect(Math.abs(pos.y), `stand "${id}" y=${pos.y} too large`).toBeLessThan(20);
    }
  });

  it('should return empty object for non-ACL text', () => {
    expect(_parseStandPositions('not a valid acl')).toEqual({});
    expect(_parseStandPositions('')).toEqual({});
    expect(_parseStandPositions('{"SceneryData": {}}')).toEqual({});
  });
});

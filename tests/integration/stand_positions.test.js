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
const { readAclText } = require('../../src/acl/gatcarc');

const FIXTURE_PATH = path.join(
  __dirname,
  '..', 'fixtures', 'game-root', 'GroundATC_Data', 'StreamingAssets',
  'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.v4.acl'
);

const text = readAclText(FIXTURE_PATH);
const stands = _parseStandPositions(text);

describe('_parseStandPositions', () => {
  it('should parse stands from ZSJN v4 fixture (57 stands)', () => {
    expect(stands).toBeDefined();
    expect(typeof stands).toBe('object');
    expect(Object.keys(stands)).toHaveLength(57);
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
    expect(_parseStandPositions('not a valid acl', false)).toEqual({});
    expect(_parseStandPositions('', false)).toEqual({});
    expect(_parseStandPositions('{"SceneryData": {}}', false)).toEqual({});
  });
});

// ─── v4 PKStaticEntities path ────────────────────────────────────

const V4_FIXTURE_PATH = path.join(
  __dirname,
  '..', 'fixtures', 'game-root', 'GroundATC_Data', 'StreamingAssets',
  'Airports', 'ZSJN', 'Levels', 'ZSJN-Morning_120min.v4.acl'
);

// Skipped gracefully when the v4 fixture is absent (offline snapshot).
const v4Text = fs.existsSync(V4_FIXTURE_PATH) ? readAclText(V4_FIXTURE_PATH) : null;
const v4Stands = v4Text ? _parseStandPositions(v4Text) : null; // auto-detect → v4 path

describe('_parseStandPositions v4', () => {
  it('should parse stands from the ZSJN v4 fixture (auto-detected schema)', () => {
    if (!v4Text) return; // fixture absent — skip
    expect(v4Stands).toBeDefined();
    expect(typeof v4Stands).toBe('object');
    expect(Object.keys(v4Stands).length).toBeGreaterThan(0);
  });

  it('each v4 stand should have finite x/y and a numeric heading', () => {
    if (!v4Stands) return; // fixture absent — skip
    for (const [id, pos] of Object.entries(v4Stands)) {
      expect(Number.isFinite(pos.x), `stand "${id}" x=${pos.x} should be finite`).toBe(true);
      expect(Number.isFinite(pos.y), `stand "${id}" y=${pos.y} should be finite`).toBe(true);
      expect(typeof pos.heading, `stand "${id}" heading should be numeric`).toBe('number');
    }
  });

  it('v4 stands should expose tail/nose positions for midpoint-derived entries', () => {
    if (!v4Stands) return; // fixture absent — skip
    for (const [id, pos] of Object.entries(v4Stands)) {
      expect(Number.isFinite(pos.tailX), `stand "${id}" tailX should be finite`).toBe(true);
      expect(Number.isFinite(pos.tailZ), `stand "${id}" tailZ should be finite`).toBe(true);
      expect(Number.isFinite(pos.noseX), `stand "${id}" noseX should be finite`).toBe(true);
      expect(Number.isFinite(pos.noseZ), `stand "${id}" noseZ should be finite`).toBe(true);
    }
  });

  it('v4 stand coordinates should be within reasonable bounds', () => {
    if (!v4Stands) return; // fixture absent — skip
    for (const [id, pos] of Object.entries(v4Stands)) {
      expect(Math.abs(pos.x), `stand "${id}" x=${pos.x} too large`).toBeLessThan(20);
      expect(Math.abs(pos.y), `stand "${id}" y=${pos.y} too large`).toBeLessThan(20);
    }
  });

  it('should return empty object for empty/invalid v4 input', () => {
    expect(_parseStandPositions('', true)).toEqual({});
    expect(_parseStandPositions('not a valid acl', true)).toEqual({});
  });
});

/**
 * v2 checkpoint-frame reconciliation persistence (real game level).
 *
 * Regression for the fuzz-produced broken `*_leisure_1.acl`: a flight delete
 * leaves the header's StaticItems without the registration, but the checkpoint
 * frame still carries the runtime `flight-plan:REG` entry whose
 * `StaticItem: $fstrref:"flight-plan:REG"` no longer resolves. The save
 * pipeline removes those orphaned runtime entities — but `encodeV2Archive`
 * used to re-copy the original frame bytes verbatim, discarding the edit. The
 * game then aborts GameStateRegistry.RestoreWorld on load.
 *
 * This drives the REAL save pipeline against a copy of a real v2 level,
 * deletes one flight, and asserts the saved file's frame no longer contains a
 * runtime plan whose static item is missing (gamecompat code
 * `resolution-missing-leg`).
 *
 * Game-root gated; skips cleanly when the level is absent or is not a v2
 * (GATCARC4 storage version 2) archive.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const { readAclText, getStorageVersion } = require('../../src/acl/gatcarc');
const { buildApproachCache } = require('../../src/acl/approach');
const { analyze, runChecks } = require('./gamecompat-utils.cjs');

const LEVEL = 'ZSJN_leisure_1.acl';
const ICAO = 'ZSJN';
const SENTINEL = '$$$ GATCARC4 CHECKPOINT FRAME $$$';

const hasLevel = gameLevelExists(ICAO, LEVEL);
const srcPath = hasLevel ? levelPath(ICAO, LEVEL) : null;
const isV2 = hasLevel && getStorageVersion(fs.readFileSync(srcPath)) === 2;

// The bug is v2-specific; skip cleanly on a missing level or a v1 archive.
const describeWithLevel = isV2 ? describe : describe.skip;

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpLevelCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-v2frame-real-'));
  tmpDirs.push(root);
  const levelDir = path.join(root, 'Airports', ICAO, 'Levels');
  fs.mkdirSync(levelDir, { recursive: true });
  const dest = path.join(levelDir, LEVEL);
  fs.copyFileSync(srcPath, dest);
  return { root, dest, levelDir };
}

describeWithLevel(`v2 frame reconciliation — ${ICAO}/${LEVEL}`, () => {
  it('deleting a flight drops its stale runtime flight-plan entity from the frame', (ctx) => {
    const { dest, levelDir } = tmpLevelCopy();
    const approachCache = buildApproachCache(levelDir);

    const loaded = parser.loadFlights(dest);
    // The fixture is a REAL, editor-managed level: a previous session may have
    // deleted scenery, which legitimately purges the flights that referenced it.
    // The scenario needs at least two plans (delete one, keep the rest) — skip
    // (rather than fail) when the live file has drifted below that.
    if (loaded.flights.length < 2) {
      ctx.skip(`live ${LEVEL} has ${loaded.flights.length} flight(s); needs >= 2`);
    }
    const removed = loaded.flights[0];
    const remaining = loaded.flights.filter((f) => f !== removed);

    const frameBefore = readAclText(dest).split(SENTINEL)[1] ?? '';
    expect(frameBefore).toContain('flight-plan:');

    parser.generateFullAcl(dest, remaining, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);

    const textAfter = readAclText(dest);
    const frameAfter = textAfter.split(SENTINEL)[1] ?? '';

    // The frame was actually re-encoded (not copied verbatim).
    expect(frameAfter).not.toBe(frameBefore);

    // Every runtime plan in the frame must still resolve to a static item.
    const a = analyze(textAfter);
    const issues = runChecks(a).issues.filter((i) => i.code === 'resolution-missing-leg');
    expect(issues).toEqual([]);

    // And the deleted registration's runtime plan is gone entirely.
    const removedReg = removed._Registration || removed.Registration;
    if (removedReg) expect(frameAfter).not.toContain(`"$k": "flight-plan:${removedReg}"`);
  });
});

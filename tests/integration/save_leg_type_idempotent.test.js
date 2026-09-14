/**
 * Save leg-type idempotency (Ground Painter / flight save path).
 *
 * A save whose store contains no arrival legs emits no FlightPlanArrivalLeg, so
 * Unity's self-registering StaticData.$blobdoc type table drops the declaration.
 * The next save that reintroduces an arrival must re-declare the type (allocate a
 * fresh blobdoc-scope id and emit the expanded "N|Name" form) instead of aborting:
 *   [V4-BUILD] _rebuildStaticDataSections: blobdoc type "FlightPlanArrivalLeg"
 *   not in bdTypeMap.
 *
 * Uses the real KJFK_peakarrival level (game-root gated; skips cleanly otherwise).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const require = createRequire(import.meta.url);
const { loadFlights, _rebuildStaticDataSections } = require('../../src/acl/parser');
const { readAclText } = require('../../src/acl/gatcarc');
const { createTokenizer } = require('../../src/acl/tokenizer');

const describeWithLevel = gameLevelExists('KJFK', 'KJFK_peakarrival.acl') ? describe : describe.skip;

function tempLevel(icao, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-legtype-'));
  const dest = path.join(dir, 'Airports', icao, 'Levels', name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(levelPath(icao, name), dest);
  return { dir, dest };
}

// Expanded "N|Name" declarations present in the PK blobdoc scope.
function blobdocTypeDecls(aclPath, needle) {
  const text = readAclText(aclPath);
  const t = createTokenizer(text);
  const sd = t.findSection('StaticData');
  const sdT = createTokenizer(t.substring(sd.valueStart, sd.valueEnd));
  const bd = sdT.findSection('$blobdoc');
  const bdText = sdT.substring(bd.valueStart, bd.valueEnd);
  const re = /"\$type":\s*"(\d+)\|([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(bdText)) !== null) if (m[2].includes(needle)) out.push(parseInt(m[1], 10));
  return out;
}

describeWithLevel('flight-plan leg type idempotency', () => {
  it('re-declares FlightPlanArrivalLeg after a prior all-departure save stripped it', () => {
    const { dir, dest } = tempLevel('KJFK', 'KJFK_peakarrival.acl');
    try {
      // 1. Save with every flight as a departure → the blobdoc drops the
      //    (now-unused) FlightPlanArrivalLeg declaration.
      const parsed = loadFlights(dest);
      expect(parsed.flights.length).toBeGreaterThan(0);
      const allDep = parsed.flights.map((f) => ({
        ...f,
        isDeparture: true,
        LandingTime: '',
        InBlockTime: '',
        OffBlockTime: f.OffBlockTime || f.LandingTime,
        TakeoffTime: f.TakeoffTime || f.InBlockTime,
      }));
      _rebuildStaticDataSections(dest, allDep, undefined, null, parsed.startTime || null, null, null);
      expect(blobdocTypeDecls(dest, 'FlightPlanArrivalLeg')).toEqual([]);

      // 2. Reopen (no arrivals) and add one, then save again. Previously this
      //    threw `blobdoc type "FlightPlanArrivalLeg" not in bdTypeMap`.
      const reopened = loadFlights(dest);
      const withArrival = [
        ...reopened.flights,
        { ...reopened.flights[0], CallSign: 'ZZZ999', isDeparture: false, LandingTime: '22:30:00', InBlockTime: '22:40:00', OffBlockTime: '', TakeoffTime: '', Airway: 'ZZZ' },
      ];
      expect(() =>
        _rebuildStaticDataSections(dest, withArrival, undefined, null, reopened.startTime || null, null, null)
      ).not.toThrow();

      // The type is re-declared (expanded form self-registers) and the file reloads.
      expect(blobdocTypeDecls(dest, 'FlightPlanArrivalLeg').length).toBeGreaterThan(0);
      expect(loadFlights(dest).flights.length).toBe(withArrival.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Ground Painter — stale `$type` registration after deleting a first-of-type object.
 *
 * Regression test for the save crash:
 *
 *   Error invoking remote method 'save-ground-painter-data':
 *     Failed to encode .acl ... to GATCARC4: Odin JSON parse error at line N:
 *       $type references unknown type id 31
 *
 * Odin JSON introduces a type id at its FIRST text occurrence (`"$type":
 * "<id>|<Name>"`) and emits a bare `"$type": <id>` for later occurrences. When the
 * Ground Painter deletes the object that carried the inline registration, the
 * surviving objects' bare references become unresolvable ("unknown type id").
 *
 * Fix: `renumberAclIds(text, originalText)` recovers the id→name mapping from the
 * ORIGINAL (pre-edit) text and re-introduces the inline registration at the first
 * surviving reference. The save path passes the pre-edit text (writeAcl → options
 * .originalText). Each Odin document / $blobdoc is an independent type namespace.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { _staticEntitiesRanges, _splitArrayEntries, _arrayValue } = require('../../src/acl/scenery_write');
const { renumberAclIds } = require('../../src/acl/id_renumber');
const { encodeArchive } = require('../../src/acl/gatcarc');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

// Delete the FIRST NonPK (Area) entry — the one carrying the inline type
// registration — so its survivors still reference a now-unregistered type id.
function deleteFirstArea(t) {
  const r = _staticEntitiesRanges(t);
  const areas = _splitArrayEntries(t.substring(r.npkRc.start, r.npkRc.end));
  const regIdx = areas.findIndex((e) => /"\$type"\s*:\s*"\d+\|ContextCross\.Models\.Area/.test(e));
  expect(regIdx).toBe(0); // fixture's first NonPK entry is the type registration
  const remaining = areas.slice(0, regIdx).concat(areas.slice(regIdx + 1));
  let out = t;
  out = out.slice(0, r.npkRc.start) + _arrayValue(remaining) + out.slice(r.npkRc.end);
  out = out.slice(0, r.npkLen.valueStart) + String(remaining.length) + out.slice(r.npkLen.valueEnd);
  return out;
}

describe('Ground Painter — stale $type registration', () => {
  it('re-introduces a deleted type registration at the first surviving reference', () => {
    const patched = deleteFirstArea(text);

    // Without the original text the orphaned type id is unresolvable → encode fails.
    expect(() => encodeArchive(renumberAclIds(patched))).toThrow(/unknown type id/);

    // The save path passes the original (pre-edit) text; the renumberer recovers
    // id→name and re-introduces the inline registration so encode succeeds.
    let norm;
    expect(() => { norm = renumberAclIds(patched, text); }).not.toThrow();
    expect(() => encodeArchive(norm)).not.toThrow();
    // The registration is re-introduced inline at the first surviving Area reference.
    expect(norm).toMatch(/"\$type": "\d+\|ContextCross\.Models\.Area/);
  });

  it('leaves a healthy document byte-identical (no spurious registrations)', () => {
    let norm;
    expect(() => { norm = renumberAclIds(text, text); }).not.toThrow();
    expect(() => encodeArchive(norm)).not.toThrow();
    expect(norm).toMatch(/"\$type": "\d+\|ContextCross\.Models\.Area/);
  });
});

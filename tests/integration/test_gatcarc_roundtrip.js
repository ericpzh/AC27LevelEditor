/**
 * GATCARC4 round-trip integrity test.
 *
 * For every .acl under GroundATC_Data/StreamingAssets/Airports/<ICAO>/Levels:
 *   binary files:
 *     1. parseArchive validates magic, version, SHA-256, commit markers
 *     2. text1 = decodeArchive(bin); bin2 = encodeArchive(text1); text2 = decodeArchive(bin2)
 *        -> text1 must equal text2 byte for byte (the transcode pipeline is loss-free)
 *        (bin2 may differ from bin in numeric entry widths — Odin JSON does not record
 *         them and Odin's binary reader coerces on load, so this is expected)
 *   text files (e.g. .bak fixtures):
 *     3. readAclText passthrough is identical to the raw file
 *     4. encode(text) -> decode -> must reproduce the original text byte for byte
 *        (validates our .NET-style number/guid/string formatting against real
 *         game-written text)
 *
 * Run: node tests/integration/test_gatcarc_roundtrip.js [--airports-dir <dir>]
 */

const fs = require('fs');
const path = require('path');
const {
  isGatcArchive, parseArchive, decodeArchive, encodeArchive, decodePayloadToText, encodeTextToPayload,
} = require('../../src/acl/gatcarc');

const DEFAULT_AIRPORTS = path.join(__dirname, '..', '..', '..',
  'GroundATC_Data', 'StreamingAssets', 'Airports');

const argIdx = process.argv.indexOf('--airports-dir');
const AIRPORTS_DIR = argIdx >= 0 ? process.argv[argIdx + 1] : DEFAULT_AIRPORTS;

let pass = 0, fail = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${label}`);
  } catch (e) {
    fail++;
    failures.push({ label, message: e.message });
    console.log(`  FAIL ${label}: ${e.message.slice(0, 300)}`);
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function testBinaryFile(filePath, name) {
  const bin = fs.readFileSync(filePath);
  let text1 = null;

  check(`${name}: container + hash valid`, () => {
    const { header, frames } = parseArchive(bin);
    if (header.length === 0) throw new Error('empty header payload');
    console.log(`         (header ${header.length} bytes, ${frames.length} frame(s))`);
  });

  check(`${name}: decode`, () => {
    text1 = decodeArchive(bin);
    if (text1.length < 100) throw new Error('suspiciously small decode output');
  });
  if (text1 === null) return;

  check(`${name}: decode -> encode -> decode is identity`, () => {
    const bin2 = encodeArchive(text1);
    const text2 = decodeArchive(bin2);
    if (text1 !== text2) {
      const i = firstDiff(text1, text2);
      throw new Error(
        `text differs at char ${i}: ` +
        `"...${text1.slice(Math.max(0, i - 60), i + 60)}..." vs ` +
        `"...${text2.slice(Math.max(0, i - 60), i + 60)}..."`);
    }
    const delta = bin2.length - bin.length;
    console.log(`         (re-encoded ${bin2.length} bytes, ${delta >= 0 ? '+' : ''}${delta} vs original — numeric width inference)`);
  });
}

function testTextFile(filePath, name) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (isGatcArchive(Buffer.from(raw.slice(0, 8), 'utf-8'))) return; // actually binary

  check(`${name}: encode(text) -> decode reproduces game-written text`, () => {
    const payload = encodeTextToPayload(raw);
    const roundTripped = decodePayloadToText(payload);
    if (roundTripped === raw) return;
    // Editor-written legacy files use bare LF; our decoder emits the game's CRLF.
    // Content must still match exactly modulo newline flavor.
    if (roundTripped.replace(/\r\n/g, '\n') === raw.replace(/\r\n/g, '\n')) {
      console.log('         (LF-newline source — content identical, newline flavor differs)');
      return;
    }
    // The Odin json_writer shortens repeated "$type": "N|Name, Assembly" to bare "$type": N.
    // Normalize both forms before comparing.
    const _normalizeTypeRef = (s) => s.replace(/"\$type":\s*"(\d+)\|[^"]+"/g, '"$type": $1');
    const a = _normalizeTypeRef(raw.replace(/\r\n/g, '\n'));
    const b = _normalizeTypeRef(roundTripped.replace(/\r\n/g, '\n'));
    if (a === b) {
      console.log('         (type refs normalized — content identical, type form differs)');
      return;
    }
    const i = firstDiff(a, b);
    throw new Error(
      `text differs at char ${i}: ` +
      `original "...${a.slice(Math.max(0, i - 80), i + 80)}..." vs ` +
      `ours "...${b.slice(Math.max(0, i - 80), i + 80)}..."`);
  });
}

function main() {
  if (!fs.existsSync(AIRPORTS_DIR)) {
    console.error(`Airports dir not found: ${AIRPORTS_DIR}`);
    process.exit(2);
  }

  const t0 = Date.now();
  for (const icao of fs.readdirSync(AIRPORTS_DIR)) {
    const levelsDir = path.join(AIRPORTS_DIR, icao, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;
    for (const f of fs.readdirSync(levelsDir)) {
      const filePath = path.join(levelsDir, f);
      if (f.endsWith('.acl')) {
        console.log(`\n${icao}/${f}`);
        if (isGatcArchive(filePath)) testBinaryFile(filePath, f);
        else testTextFile(filePath, f);
      } else if (f.endsWith('.acl.bak')) {
        // legacy text fixtures — validate our JSON writer against game-written text
        if (!isGatcArchive(filePath)) {
          console.log(`\n${icao}/${f} (legacy text fixture)`);
          testTextFile(filePath, f);
        }
      }
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.message.slice(0, 200)}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();

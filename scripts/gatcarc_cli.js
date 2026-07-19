#!/usr/bin/env node
/**
 * GATCARC4 .acl command-line tool — decode/encode/inspect the binary .acl archives
 * introduced by the 2026-07 game update.
 *
 * Usage:
 *   node scripts/gatcarc_cli.js info   <file.acl>            container summary
 *   node scripts/gatcarc_cli.js decode <file.acl> [out.txt]  binary -> Odin JSON text
 *   node scripts/gatcarc_cli.js encode <file.txt> [out.acl]  Odin JSON text -> binary
 *   node scripts/gatcarc_cli.js verify <file.acl>            validate container + round-trip
 *
 * decode/encode default output path: input path with .decoded.txt / .acl appended.
 */

const fs = require('fs');
const path = require('path');
const {
  isGatcArchive, parseArchive, decodeArchive, encodeArchive, FRAME_SENTINEL,
} = require('../src/acl/gatcarc');

function usage() {
  console.log('Usage: node scripts/gatcarc_cli.js <info|decode|encode|verify> <file> [out]');
  process.exit(2);
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
}

function main() {
  const [cmd, file, out] = process.argv.slice(2);
  if (!cmd || !file) usage();
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(2); }

  switch (cmd) {
    case 'info': {
      const buf = fs.readFileSync(file);
      if (!isGatcArchive(buf)) {
        console.log(`${file}: legacy text .acl (${fmtBytes(buf.length)})`);
        return;
      }
      const { header, frames } = parseArchive(buf);
      console.log(`${file}: GATCARC4 archive (${fmtBytes(buf.length)})`);
      console.log(`  header segment: ${fmtBytes(header.length)} payload, SHA-256 OK`);
      frames.forEach((f, i) => console.log(`  frame ${i + 1}: ${fmtBytes(f.length)} payload, SHA-256 OK`));
      return;
    }

    case 'decode': {
      const buf = fs.readFileSync(file);
      if (!isGatcArchive(buf)) {
        console.error(`${file} is already text (no GATCARC4 magic)`);
        process.exit(1);
      }
      const text = decodeArchive(buf);
      const outPath = out || file + '.decoded.txt';
      fs.writeFileSync(outPath, text, 'utf-8');
      const frameCount = text.split(FRAME_SENTINEL).length - 1;
      console.log(`Decoded ${fmtBytes(buf.length)} -> ${outPath} (${fmtBytes(Buffer.byteLength(text))}, ${frameCount} frame doc(s))`);
      return;
    }

    case 'encode': {
      const text = fs.readFileSync(file, 'utf-8');
      const buf = encodeArchive(text);
      const outPath = out || file.replace(/(\.decoded)?\.txt$/, '') + (file.endsWith('.acl') ? '.bin.acl' : '.acl');
      fs.writeFileSync(outPath, buf);
      console.log(`Encoded ${fmtBytes(Buffer.byteLength(text))} -> ${outPath} (${fmtBytes(buf.length)})`);
      return;
    }

    case 'verify': {
      const buf = fs.readFileSync(file);
      if (!isGatcArchive(buf)) {
        console.log(`${file}: legacy text .acl — nothing to verify at container level`);
        return;
      }
      const { header, frames } = parseArchive(buf); // throws on any container problem
      const text1 = decodeArchive(buf);
      const text2 = decodeArchive(encodeArchive(text1));
      if (text1 !== text2) { console.error('FAIL: decode -> encode -> decode is not an identity'); process.exit(1); }
      console.log(`OK: container valid (header ${fmtBytes(header.length)}, ${frames.length} frame(s)), hashes match, round-trip identity holds`);
      return;
    }

    default:
      usage();
  }
}

main();

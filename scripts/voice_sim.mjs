#!/usr/bin/env node
/**
 * Voice-command simulator — drive the EXACT voice pipeline (the same
 * parseVoiceTranscript the in-app PTT hook uses) with a typed command
 * string, and optionally send the resulting patch frames to the running
 * game — no microphone needed.
 *
 * Usage:
 *   node scripts/voice_sim.mjs "CSC6918: climb and maintain 9000, reduce speed to 180 knots"
 *   node scripts/voice_sim.mjs "CSC6918: Fly heading 120" --live
 *   node scripts/voice_sim.mjs "川航六九幺八爬升至九千"
 *
 * Flags:
 *   --live            send the parsed frames to the game at 127.0.0.1:20267
 *                     (requires the game + BepInEx plugin running; dry-run
 *                     is the default)
 *   --aircraft FILE   JSON array of aircraft ({callSign, controlSeat, …})
 *                     instead of the synthetic list derived from the
 *                     transcript — use a controlSeat != 5 entry to exercise
 *                     the approach-channel gate
 *   --alternates "a|b" alternate phrase hypotheses to try after the primary
 *                     (mirrors the vosk worker's alternates — the first
 *                     candidate that yields commands wins)
 *   --waypoints FILE  JSON array of {name, x, z} — the 'fly direct to X'
 *                     target set (same shape as collect-values._airwayNodes);
 *                     without it, direct phrases notice "no waypoint data"
 *   --lang en|zh|auto language override (default: auto-detect)
 *
 * Dry-run prints: detected language, resolved callsign, the command-window
 * line format, each sendPatchCommand payload as JSON, and any unsupported
 * notices. With --live each command goes out as a 72-byte 0x00E7 frame
 * (8 B header + pipe-delimited ASCII payload NUL-padded to 64 B) on a
 * send-only socket — it never binds port 20266, so it coexists with a
 * running editor.
 *
 * Exit codes: 0 = ok (or selection-only), 1 = no aircraft matched,
 * 2 = usage error.
 *
 * Requires Node ≥ 22.7 (ESM-syntax detection for the .js parser modules);
 * fallback: node --experimental-detect-module scripts/voice_sim.mjs
 */

import { parseVoiceCandidates, buildSyntheticAircraftList } from '../src/components/MapWindows/voiceTranscriptParser.js';
import { detectLanguage } from '../src/components/MapWindows/voiceCallsignParser.js';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import dgram from 'dgram';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildPatchFrame } = require('../electron/patchFrame.js');

const HOST = '127.0.0.1';
const PORT = 20267;

// ─── Args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { transcript: null, live: false, aircraft: null, alternates: [], waypoints: null, lang: 'auto' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--aircraft') args.aircraft = argv[++i];
    else if (a === '--alternates') args.alternates = (argv[++i] || '').split('|').filter(Boolean);
    else if (a === '--waypoints') args.waypoints = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
    else rest.push(a);
  }
  args.transcript = rest.join(' ');
  return args;
}

function usage() {
  console.log(`usage: node scripts/voice_sim.mjs "<transcript>" [--live] [--aircraft file.json] [--alternates "a|b"] [--waypoints file.json] [--lang en|zh|auto]
  transcript — full command string, e.g. "CSC6918: climb and maintain 9000, reduce speed to 180 knots"
  --live       — send the parsed frames to the game at ${HOST}:${PORT} (dry-run is the default)
  --aircraft   — JSON array of aircraft to resolve against instead of the synthetic list
  --alternates — alternate phrase hypotheses (pipe-separated) tried after the primary
  --waypoints  — JSON array of {name, x, z} — the 'fly direct to X' target set
  --lang       — en | zh | auto (default: auto-detect from the transcript)`);
}

function loadJsonList(filePath, what) {
  const text = readFileSync(path.resolve(filePath), 'utf8').replace(/^﻿/, '');   // tolerate a UTF-8 BOM
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error(`--${what} file must be a JSON array`);
  return list;
}

// ─── Live send ────────────────────────────────────────────────────────

/** Send one patch command as a 72-byte frame, fire-and-forget. */
function sendLive(payload) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const frame = buildPatchFrame(payload);
    socket.send(frame, 0, frame.length, PORT, HOST, (err) => {
      socket.close();
      err ? reject(err) : resolve();
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.transcript) {
    usage();
    process.exit(2);
  }
  if (!['auto', 'en', 'zh'].includes(args.lang)) {
    console.error(`invalid --lang "${args.lang}" (en | zh | auto)`);
    process.exit(2);
  }

  const lang = args.lang === 'auto' ? detectLanguage(args.transcript) : args.lang;
  const aircraftList = args.aircraft
    ? loadJsonList(args.aircraft, 'aircraft')
    : buildSyntheticAircraftList(args.transcript, lang);
  const waypoints = args.waypoints ? loadJsonList(args.waypoints, 'waypoints') : [];

  console.log(`lang: ${lang}`);
  if (args.aircraft) console.log(`aircraft: ${args.aircraft} (${aircraftList.length} entries)`);
  else console.log(`aircraft: synthetic from transcript (${aircraftList.length} candidates)`);
  if (args.waypoints) console.log(`waypoints: ${args.waypoints} (${waypoints.length} entries)`);

  const { result, candidateIndex } = parseVoiceCandidates(
    [args.transcript, ...args.alternates],
    aircraftList,
    waypoints
  );

  console.log(`callsign: ${result.callsign ?? '(none)'}`);
  if (result.callsign) console.log(`line: ${result.renderedLine}`);
  if (args.alternates.length) {
    console.log(`matched from: ${candidateIndex === 0 ? 'primary' : `alternate #${candidateIndex}`}`);
  }
  for (const n of result.notices) console.log(`notice: ${n}`);

  if (!result.ok) {
    console.log('(no aircraft matched — nothing sent)');
    process.exit(1);
  }

  if (!result.commands.length) {
    console.log('(selection only — no commands to send)');
    process.exit(0);
  }

  const seat = result.aircraft?.controlSeat;
  if (seat !== undefined && seat !== 5) {
    console.log(`gate: ${result.callsign} is on controlSeat ${seat} — approach (5) required; commands NOT sent`);
    process.exit(0);
  }

  for (const c of result.commands) {
    console.log(`payload: ${JSON.stringify(c.payload)}`);
  }

  if (args.live) {
    for (const c of result.commands) {
      await sendLive(c.payload);
      console.log(`sent: ${c.payload.type} → ${c.payload.callSign} (${HOST}:${PORT})`);
    }
  } else {
    console.log('(dry-run — add --live to send these frames to the game)');
  }
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});

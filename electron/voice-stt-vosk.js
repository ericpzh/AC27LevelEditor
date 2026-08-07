/**
 * voice-stt-vosk.js — offline vosk speech recognition worker (replaces
 * electron/voice-stt.ps1). Spawned by electron/voiceSttWorker.js via
 * `process.execPath` with ELECTRON_RUN_AS_NODE=1 (electron.exe as plain Node),
 * so it must be self-contained CJS with no require('electron').
 *
 * Protocol: JSON lines over stdin/stdout, UTF-8, one object per line.
 *   in : {"cmd":"start","extraWords":[...]} — extraWords = the current
 *        airport's waypoint names, merged into BOTH recognizers' grammar
 *        (mixed "直飞 BELTT" utterances decode on the zh side too)
 *      | {"cmd":"stop"} | {"cmd":"exit"}
 *   out: {"type":"ready","engine":"vosk","model":"en+zh","sampleRate":16000,
 *         "culture":"en-US,zh-CN","languages":["en-US","zh-CN"],"models":[...]}
 *        {"type":"started"} | {"type":"stopped"}
 *        {"type":"result","text":...,"confidence":...,"language":"en"|"zh"}
 *        {"type":"detected"}                       — first non-empty partial
 *        {"type":"rejected","reason":"busy"}       — start while recognizing
 *        {"type":"rejected","reason":"low-confidence"} — heard audio, empty phrase
 *        {"type":"error","code":...,"message":...}
 *
 * Session semantics (mirror the ps1): 'start' creates FRESH recognizers per
 * language; mic capture is sox.exe reading the Windows default recording
 * device (`-t waveaudio default`), resampled to 16 kHz mono S16LE raw PCM.
 * 'stop' sets a flag — the phrase in flight ALWAYS finalizes (vosk utterance
 * boundary, or a 1.5 s silence grace after the stop lands) and its result is
 * delivered before 'stopped'. A 'start' while finalizing cancels the pending
 * stop (press again = session continues); a 'start' while actively recognizing
 * is rejected as busy. 'exit' tears down and exits 0 (also on stdin EOF).
 *
 * Dual-language decode: each session runs one Recognizer per model (en-US
 * large + zh-CN small) on the same PCM; the emitted result is the one with the
 * higher average word confidence — no user language toggle needed.
 *
 * CLI modes (no stdin loop):
 *   --wav <file>   decode a 16 kHz mono 16-bit WAV, emit per-phrase results
 *   --test         self-check (model + grammar + sox resolve), emit test event
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { VoskModel, VoskRecognizer } = require('./voskFfi.js');

const SAMPLE_RATE = 16000;
// The voice build ships these exact models (see build.js VOICE_RESOURCES):
// en uses the LARGE vosk-model-en-us-0.22 for accuracy (the small en-us-0.15
// was ditched 2026-08-06 — too inaccurate); zh stays on the small cn-0.22.
const EN_MODEL = 'vosk-model-en-us-0.22';
const ZH_MODEL = 'vosk-model-small-cn-0.22';

/** Silence grace after 'stop' (ms). Longer than the audio burst that follows
 *  a PTT release; the Node side's STOP_DRAIN_MS (1500) fires first, so total
 *  stop latency ≈ 3 s — inside the drain test's 5 s window. Reset by any
 *  incoming audio so a still-talking release is never clipped. */
const FINALIZE_GRACE_MS = 1500;

let state = 'boot';          // boot | ready | recognizing | finalizing
let enModel = null;
let zhModel = null;
let grammar = null;          // { words: [], wordsZh: [] }
let session = null;          // active session handle (see startSession)
let soxPath = null;

// ── Emit ───────────────────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitError(code, message) {
  emit({ type: 'error', code, message });
}

// ── Path resolution (env-first, packaged-aware) ────────────────────────

/** VOICE_RESOURCES is set by voiceSttWorker.js: resourcesPath (packaged) or
 *  the repo root (dev). */
function resourcesDir() {
  return process.env.VOICE_RESOURCES || path.join(__dirname, '..');
}

function resolveModelDir(envVar, name) {
  if (process.env[envVar]) {
    // Override must be a real model dir too — else NO_MODEL, not a raw throw.
    const p = process.env[envVar];
    return fs.existsSync(path.join(p, 'conf', 'model.conf')) ? p : null;
  }
  const p = path.join(resourcesDir(), 'models', name);
  return fs.existsSync(path.join(p, 'conf', 'model.conf')) ? p : null;
}

function resolveSoxPath() {
  if (process.env.VOSK_SOX_PATH) return process.env.VOSK_SOX_PATH;
  const candidates = [
    path.join(resourcesDir(), 'sox', 'sox.exe'),        // packaged: resources/sox
    path.join(resourcesDir(), 'bin', 'sox', 'sox.exe'), // dev: repo/bin/sox
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function loadGrammar() {
  const p = path.join(__dirname, 'voice-grammar.json');
  if (!fs.existsSync(p)) throw new Error(`grammar file not found: ${p}`);
  const g = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(g.words) || !Array.isArray(g.wordsZh)) {
    throw new Error(`malformed grammar file: ${p}`);
  }
  return g;
}

// ── Boot ───────────────────────────────────────────────────────────────

function boot() {
  try {
    grammar = loadGrammar();
    soxPath = resolveSoxPath();

    const enModelName = EN_MODEL;
    const zhModelName = ZH_MODEL;
    const fetchHint = 'run `node scripts/fetch-vosk-model.mjs`';

    const enDir = resolveModelDir('VOSK_MODEL_DIR', enModelName);
    if (!enDir) throw Object.assign(new Error(`en model missing — ${fetchHint}`), { code: 'NO_MODEL' });
    const zhDir = resolveModelDir('VOSK_ZH_MODEL_DIR', zhModelName);
    if (!zhDir) throw Object.assign(new Error(`zh model missing — ${fetchHint}`), { code: 'NO_MODEL' });

    enModel = new VoskModel(enDir);
    zhModel = new VoskModel(zhDir);

    emit({
      type: 'ready', engine: 'vosk', model: 'en+zh', sampleRate: SAMPLE_RATE,
      culture: 'en-US,zh-CN', languages: ['en-US', 'zh-CN'],
      models: [path.basename(enDir), path.basename(zhDir)],
      grammarWords: { en: grammar.words.length, zh: grammar.wordsZh.length },
    });
    state = 'ready';
  } catch (err) {
    emitError(err.code || 'MODEL_LOAD_FAILED', err.message);
    process.exit(1);
  }
}

// ── Session (per 'start') ──────────────────────────────────────────────

function startSession(extraWords) {
  if (!soxPath) {
    emitError('SOX_NOT_FOUND', `sox.exe not found (VOSK_SOX_PATH → resources/sox → bin/sox)`);
    state = 'ready';
    return;
  }
  // Per-session dynamic vocabulary: the current airport's waypoint names
  // (validated lowercase [a-z]{3,5} — the ACL cache already guarantees
  // /^[A-Z]{3,5}$/). Merged into BOTH recognizers so mixed "直飞 BELTT"
  // utterances decode on the zh side too.
  const extra = [...new Set((extraWords || [])
    .map((w) => String(w).toLowerCase())
    .filter((w) => /^[a-z]{3,5}$/.test(w)))];
  let recEn, recZh, sox;
  try {
    recEn = new VoskRecognizer(enModel, SAMPLE_RATE, [...grammar.words, ...extra]);
    recZh = new VoskRecognizer(zhModel, SAMPLE_RATE, [...grammar.wordsZh, ...extra]);
  } catch (err) {
    emitError('ENGINE', `recognizer create failed: ${err.message}`);
    state = 'ready';
    return;
  }

  let stopRequested = false;
  let detected = false;
  let finalizeTimer = null;
  let soxDying = false;
  let enAccum = null;   // per-recognizer phrase results — finalResult() RESETS a
  let zhAccum = null;   // recognizer, so a boundary on one must not force the
                        // other mid-phrase; accumulate and pick at finalize.

  const armFinalizeTimer = () => {
    if (finalizeTimer) clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(finalizeSession, FINALIZE_GRACE_MS);
  };

  const onAudio = (buf) => {
    if (!session || session.recEn !== recEn) return;   // stale session
    const doneEn = recEn.acceptWaveform(buf);
    const doneZh = recZh.acceptWaveform(buf);
    if (doneEn) enAccum = recEn.finalResult();   // phrase ended in EN only
    if (doneZh) zhAccum = recZh.finalResult();   // phrase ended in ZH only
    if (doneEn || doneZh) return;                // never force the other side
    const pEn = recEn.partialResult().partial;
    const pZh = recZh.partialResult().partial;
    if ((pEn || pZh) && !detected) {
      detected = true;
      emit({ type: 'detected' });
    }
    // Keep-alive ONLY while speech is flowing — sox streams continuous
    // (silent) PCM, so resetting on any audio would postpone the finalize
    // grace forever. Silence after 'stop' → 1500 ms → finalize (mirrors the
    // ps1's EndSilenceTimeout).
    if (stopRequested && (pEn || pZh)) armFinalizeTimer();
  };

  const finalizeSession = () => {
    if (!session || session.recEn !== recEn) return;
    if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; }
    session = null;
    stopRequested = false;

    const rEn = enAccum || recEn.finalResult();
    const rZh = zhAccum || recZh.finalResult();
    const best = pickBest(rEn, rZh);

    try { sox.kill(); } catch (_) { /* already gone */ }
    soxDying = true;
    recEn.free(); recZh.free();

    if (best && best.text.trim()) {
      emit({ type: 'result', text: best.text.trim(), confidence: best.conf, language: best.lang });
    } else if (detected) {
      emit({ type: 'rejected', reason: 'low-confidence' });
    }
    state = 'ready';
    emit({ type: 'stopped' });
  };

  const teardown = () => {
    if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; }
    try { sox.kill(); } catch (_) { /* gone */ }
    recEn.free(); recZh.free();
  };

  session = { recEn, recZh, finalizeSession, teardown, isFinalizing: () => stopRequested,
              continueSession: () => { stopRequested = false; if (finalizeTimer) { clearTimeout(finalizeTimer); finalizeTimer = null; } },
              requestStop: () => { stopRequested = true; armFinalizeTimer(); } };

  try {
    sox = spawn(soxPath, ['--no-show-progress', '-t', 'waveaudio', 'default',
      '-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-e', 'signed-integer', '-b', '16', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    emitError('NO_AUDIO_DEVICE', `sox spawn failed: ${err.message}`);
    recEn.free(); recZh.free();
    session = null;
    state = 'ready';
    return;
  }
  sox.stdout.on('data', onAudio);
  sox.stderr.on('data', () => { /* progress meter — ignore */ });
  sox.on('error', () => { if (!soxDying) emitError('NO_AUDIO_DEVICE', 'sox failed to start'); });
  sox.on('exit', (code) => {
    if (session && session.recEn === recEn && !soxDying) {
      // sox died mid-session (device removed, privacy block…) — finalize what we have.
      emitError('NO_AUDIO_DEVICE', `sox exited unexpectedly (code ${code})`);
      session.finalizeSession();
    }
  });

  state = 'recognizing';
  emit({ type: 'started' });
}

/**
 * Pick the better of the en/zh final results: higher mean word confidence.
 * ZH results are emitted space-free (the vosk cn model decodes character by
 * character and the ZH parser matches contiguous char patterns), and need
 * ≥ 3 chars — a short high-confidence char burst on English speech must not
 * win. @returns {{text:string, conf:number, lang:'en'|'zh'}|null}
 */
function pickBest(rEn, rZh) {
  const score = (r, lang) => {
    const text = (r && r.text || '').trim();
    if (!text) return null;
    // vosk 0.3.39 with set_words emits the word list under `result`
    // (entries: {word, start, end, conf}) — not `words`.
    const words = Array.isArray(r.result) && r.result.length
      ? r.result
      : (Array.isArray(r.words) && r.words.length ? r.words : null);
    const conf = words
      ? words.reduce((a, w) => a + (typeof w.conf === 'number' ? w.conf : 0), 0) / words.length
      : 0.9;
    if (lang === 'zh') {
      const joined = text.replace(/\s+/g, '');
      if (joined.length < 3) return null;          // junk-guard on EN speech
      return { text: joined, conf, lang };
    }
    return { text, conf, lang };
  };
  const sEn = score(rEn, 'en');
  const sZh = score(rZh, 'zh');
  if (!sEn) return sZh;
  if (!sZh) return sEn;
  return sEn.conf >= sZh.conf ? sEn : sZh;
}

// ── Command loop ───────────────────────────────────────────────────────

function onCommand(cmd) {
  switch (cmd.cmd) {
    case 'start':
      if (state === 'recognizing') {
        if (session.isFinalizing()) {
          session.continueSession();      // re-press during finalize = resume
          state = 'recognizing';
          emit({ type: 'started' });
        } else {
          emit({ type: 'rejected', reason: 'busy' });
        }
        return;
      }
      startSession(cmd.extraWords);
      return;
    case 'stop':
      if (state === 'recognizing' && session && !session.isFinalizing()) {
        session.requestStop();
      }
      return;
    case 'exit':
      if (session) session.teardown();
      process.exit(0);
      return;
    default:
      emitError('ENGINE', `unknown command: ${JSON.stringify(cmd)}`);
  }
}

// ── --wav CLI mode (offline decode, no mic, no stdin loop) ─────────────

function parseWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46464952 || buf.readUInt32LE(8) !== 0x45564157) { // RIFF/WAVE
    throw Object.assign(new Error(`not a RIFF/WAVE file: ${file}`), { code: 'WAV_FORMAT' });
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw Object.assign(new Error(`malformed WAV: ${file}`), { code: 'WAV_FORMAT' });
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
    throw Object.assign(new Error(`expected PCM 16kHz mono 16-bit (got ${fmt.rate}Hz ${fmt.channels}ch ${fmt.bits}bit)`), { code: 'WAV_FORMAT' });
  }
  return data;
}

function runWavMode(file, extraWords) {
  if (!fs.existsSync(file)) {
    emitError('WAV_NOT_FOUND', `wave file not found: ${file}`);
    process.exit(1);
  }
  let pcm;
  try {
    pcm = parseWav(file);
  } catch (err) {
    emitError(err.code || 'WAV_FORMAT', err.message);
    process.exit(1);
  }
  const extra = [...new Set((extraWords || [])
    .map((w) => String(w).toLowerCase())
    .filter((w) => /^[a-z]{3,5}$/.test(w)))];
  const recEn = new VoskRecognizer(enModel, SAMPLE_RATE, [...grammar.words, ...extra]);
  const recZh = new VoskRecognizer(zhModel, SAMPLE_RATE, [...grammar.wordsZh, ...extra]);
  // Feed per chunk; collect each recognizer's phrases at ITS OWN boundaries
  // (acceptWaveform true → finalResult() — the recognizer resets internally,
  // so uncollected mid-file phrases would be lost). Never force the other
  // side mid-phrase. Join per-language (text + word confidences), then pick
  // the confidence winner.
  const CHUNK = 16000 * 2;   // 1 s of PCM
  const enPhrases = [];
  const zhPhrases = [];
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const c = pcm.subarray(i, i + CHUNK);
    if (recEn.acceptWaveform(c)) enPhrases.push(recEn.finalResult());
    if (recZh.acceptWaveform(c)) zhPhrases.push(recZh.finalResult());
  }
  const collect = (phrases, tail) => ({
    text: [...phrases.map((p) => (p && p.text || '').trim()).filter(Boolean),
           (tail && tail.text || '').trim()].filter(Boolean).join(' '),
    result: [...phrases.flatMap((p) => (p && p.result) || []),
             ...((tail && tail.result) || [])],
  });
  const rEn = collect(enPhrases, recEn.finalResult());
  const rZh = collect(zhPhrases, recZh.finalResult());
  const best = pickBest(rEn, rZh);
  if (best) emit({ type: 'result', text: best.text, confidence: best.conf, language: best.lang });
  recEn.free(); recZh.free();
  emit({ type: 'stopped' });
  process.exit(0);
}

// ── Entry ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const wavIdx = argv.indexOf('--wav');
if (wavIdx >= 0) {
  // --wav still boots models + grammar first (ready before results).
  boot();
  const extraIdx = argv.indexOf('--extra');
  const extra = extraIdx >= 0 ? argv[extraIdx + 1].split(',').filter(Boolean) : [];
  runWavMode(argv[wavIdx + 1], extra);
  return; // unreachable (runWavMode exits)
}

if (argv.includes('--test')) {
  boot();
  emit({ type: 'test', ok: true, engine: 'vosk', sox: soxPath,
         languages: ['en-US', 'zh-CN'], grammarWords: { en: grammar.words.length, zh: grammar.wordsZh.length } });
  process.exit(0);
}

boot();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let cmd;
  try { cmd = JSON.parse(line); } catch (_) { emitError('ENGINE', `malformed command: ${line}`); return; }
  onCommand(cmd);
});
rl.on('close', () => {   // stdin EOF (parent died/disposed)
  if (session) session.teardown();
  process.exit(0);
});

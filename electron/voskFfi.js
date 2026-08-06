/**
 * voskFfi.js — minimal koffi binding to libvosk.dll (vosk 0.3.39 C API).
 *
 * Why not the `vosk` npm package: its wrapper depends on ffi-napi/ref-napi,
 * whose prebuilt binaries are N-API 10 — they load on Node 24 but NOT under
 * Electron's bundled Node 20.18 (N-API 9), and the node-gyp-build install
 * script aborts on teardown. koffi ships N-API 8 prebuilds that work on both.
 *
 * Signatures mirror vosk-api 0.3.39 nodejs/index.js (ffi-napi declarations):
 *   vosk_set_log_level(int)
 *   vosk_model_new(const char*) -> VoskModel*
 *   vosk_model_free(VoskModel*)
 *   vosk_recognizer_new(VoskModel*, float) -> VoskRecognizer*
 *   vosk_recognizer_new_grm(VoskModel*, float, const char* grammarJson) -> VoskRecognizer*
 *   vosk_recognizer_free(VoskRecognizer*)
 *   vosk_recognizer_set_max_alternatives(VoskRecognizer*, int)
 *   vosk_recognizer_set_words(VoskRecognizer*, bool)
 *   vosk_recognizer_set_partial_words(VoskRecognizer*, bool)
 *   vosk_recognizer_accept_waveform(VoskRecognizer*, const char* data, int len) -> bool
 *   vosk_recognizer_result(VoskRecognizer*) -> const char* (JSON)
 *   vosk_recognizer_partial_result(VoskRecognizer*) -> const char* (JSON)
 *   vosk_recognizer_final_result(VoskRecognizer*) -> const char* (JSON)
 *   vosk_recognizer_reset(VoskRecognizer*)
 *
 * Grammar is passed per-recognizer as a JSON string via new_grm (0.3.39 has no
 * vosk_model_set_grammar). Owned result strings are copied by koffi into JS
 * strings and parsed here; vosk pointers stay opaque.
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

let lib = null;
let libDir = null;

/** Resolve the vosk DLL dir: env override → packaged resources/vosk → repo bin/vosk. */
function resolveLibDir() {
  if (process.env.VOSK_LIB_DIR) return process.env.VOSK_LIB_DIR;
  // Voice worker child ships alongside resources/ (packaged) or repo/electron (dev).
  const candidates = [
    path.join(__dirname, 'vosk'),                       // resources/vosk or electron/vosk
    path.join(__dirname, '..', 'bin', 'vosk'),          // repo/bin/vosk (dev)
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'libvosk.dll'))) return c;
  }
  return null;
}

function load() {
  if (lib) return lib;
  libDir = resolveLibDir();
  if (!libDir) {
    throw new Error('libvosk.dll not found (looked in VOSK_LIB_DIR, resources/vosk, bin/vosk)');
  }
  // MinGW runtime DLLs (libstdc++-6.dll etc.) resolve from the DLL's own dir —
  // the loader uses the process PATH, so prepend it before loading.
  process.env.PATH = libDir + path.delimiter + (process.env.PATH || '');

  const voskModel = koffi.opaque('VoskModel');
  const voskRecognizer = koffi.opaque('VoskRecognizer');
  lib = koffi.load(path.join(libDir, 'libvosk.dll'));

  lib.vosk_set_log_level = lib.func('void vosk_set_log_level(int level)');
  lib.vosk_model_new = lib.func('VoskModel *vosk_model_new(const char *model_path)');
  lib.vosk_model_free = lib.func('void vosk_model_free(VoskModel *model)');
  lib.vosk_recognizer_new = lib.func('VoskRecognizer *vosk_recognizer_new(VoskModel *model, float sample_rate)');
  lib.vosk_recognizer_new_grm = lib.func('VoskRecognizer *vosk_recognizer_new_grm(VoskModel *model, float sample_rate, const char *grammar)');
  lib.vosk_recognizer_free = lib.func('void vosk_recognizer_free(VoskRecognizer *recognizer)');
  lib.vosk_recognizer_set_max_alternatives = lib.func('void vosk_recognizer_set_max_alternatives(VoskRecognizer *recognizer, int max_alternatives)');
  lib.vosk_recognizer_set_words = lib.func('void vosk_recognizer_set_words(VoskRecognizer *recognizer, bool words)');
  lib.vosk_recognizer_set_partial_words = lib.func('void vosk_recognizer_set_partial_words(VoskRecognizer *recognizer, bool words)');
  lib.vosk_recognizer_accept_waveform = lib.func('bool vosk_recognizer_accept_waveform(VoskRecognizer *recognizer, const char *data, int len)');
  lib.vosk_recognizer_result = lib.func('const char *vosk_recognizer_result(VoskRecognizer *recognizer)');
  lib.vosk_recognizer_partial_result = lib.func('const char *vosk_recognizer_partial_result(VoskRecognizer *recognizer)');
  lib.vosk_recognizer_final_result = lib.func('const char *vosk_recognizer_final_result(VoskRecognizer *recognizer)');
  lib.vosk_recognizer_reset = lib.func('void vosk_recognizer_reset(VoskRecognizer *recognizer)');
  return lib;
}

class VoskModel {
  constructor(modelDir) {
    const l = load();
    this.handle = l.vosk_model_new(modelDir);
    // koffi returns null for NULL, else a BigInt address for opaque pointers.
    if (!this.handle) {
      throw new Error(`vosk_model_new failed for ${modelDir}`);
    }
  }
  free() {
    if (this.handle) {
      load().vosk_model_free(this.handle);
      this.handle = null;
    }
  }
}

/**
 * @param {VoskModel} model
 * @param {number} sampleRate
 * @param {string[]|null} grammar — words array; passed as JSON to new_grm.
 */
class VoskRecognizer {
  constructor(model, sampleRate, grammar) {
    const l = load();
    this.handle = grammar && grammar.length
      ? l.vosk_recognizer_new_grm(model.handle, sampleRate, JSON.stringify(grammar))
      : l.vosk_recognizer_new(model.handle, sampleRate);
    if (!this.handle) {
      throw new Error('vosk_recognizer_new failed');
    }
    l.vosk_recognizer_set_words(this.handle, true);
  }
  /** @param {Buffer} pcmBuf — Int16LE PCM. Returns true when a phrase ended. */
  acceptWaveform(pcmBuf) {
    return load().vosk_recognizer_accept_waveform(this.handle, pcmBuf, pcmBuf.length);
  }
  result() { return parseJson(load().vosk_recognizer_result(this.handle)); }
  partialResult() { return parseJson(load().vosk_recognizer_partial_result(this.handle)); }
  finalResult() { return parseJson(load().vosk_recognizer_final_result(this.handle)); }
  free() {
    if (this.handle) {
      load().vosk_recognizer_free(this.handle);
      this.handle = null;
    }
  }
}

function parseJson(s) {
  try { return JSON.parse(s); } catch (_) { return { text: '' }; }
}

module.exports = { load, resolveLibDir, VoskModel, VoskRecognizer };

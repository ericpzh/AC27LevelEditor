// check-vosk-vocab.mjs — report which grammar words the vosk models actually
// contain. Vosk SILENTLY SKIPS out-of-vocab grammar words at recognizer
// creation, logging `WARNING … Ignoring word missing in vocabulary: 'X'` on
// stderr — words that never reach the decoder lose nothing structurally (the
// post-processing parsers tolerate their absence) but this report is the
// empirical triage list for the grammar.
//
// Usage:
//   node scripts/check-vosk-vocab.mjs            # report both models
//   node scripts/check-vosk-vocab.mjs --fail     # exit 1 when ANY word is OOV
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammar = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'voice-grammar.json'), 'utf8'));

const MODELS = [
  { lang: 'en', dir: 'models/vosk-model-small-en-us-0.15', words: grammar.words },
  { lang: 'zh', dir: 'models/vosk-model-small-cn-0.22', words: grammar.wordsZh },
];

// Child inline script: load ONE model + a grammar recognizer; the DLL logs
// OOV warnings to the child's own stderr, which the parent parses. One child
// per model — a single process would mix both models' warnings on one stderr.
// Args: <modelDir> <grammarKey>   — zh feeds the CHAR-EXPANDED list, exactly
// like the worker does (the cn model's vocab is character-based).
const child = `
const { VoskModel, VoskRecognizer } = require(${JSON.stringify(path.join(ROOT, 'electron', 'voskFfi.js'))});
const grammar = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'electron', 'voice-grammar.json'))}, 'utf8'));
const dir = process.argv[1];
const key = process.argv[2];
const words = key === 'wordsZh'
  ? [...new Set(grammar.wordsZh.flatMap((w) => [...w]))].sort()
  : grammar.words;
const model = new VoskModel(dir);
const rec = new VoskRecognizer(model, 16000, words);
rec.free(); model.free();
console.log('CHILD-DONE');
`;

function runChild(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', child, ...args], { cwd: ROOT });
    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.on('close', (code) => resolve({ stderr, stdout, code }));
  });
}

const missing = { en: [], zh: [] };
for (const m of MODELS) {
  const dir = path.join(ROOT, m.dir);
  if (!existsSync(path.join(dir, 'conf', 'model.conf'))) {
    console.log(`SKIP ${m.lang} — model missing (run node scripts/fetch-vosk-model.mjs)`);
    continue;
  }
  const { stderr, stdout, code } = await runChild([path.join(ROOT, m.dir), m.lang === 'en' ? 'words' : 'wordsZh']);
  if (code !== 0 || !stdout.includes('CHILD-DONE')) {
    console.error(`[${m.lang}] vocab child failed (exit ${code}) — stderr tail:`);
    console.error(stderr.trim().split('\n').slice(-3).join('\n'));
    process.exit(1);
  }
  const re = /Ignoring word missing in vocabulary: '([^']+)'/g;
  let mm;
  while ((mm = re.exec(stderr))) missing[m.lang].push(mm[1]);
  console.log(`[${m.lang}] ${m.words.length} grammar words, ${missing[m.lang].length} missing from model vocab`);
  if (missing[m.lang].length) {
    console.log(`  missing: ${missing[m.lang].join(', ')}`);
  }
}

const anyMissing = missing.en.length > 0 || missing.zh.length > 0;
if (process.argv.includes('--fail') && anyMissing) {
  console.error('FAIL: grammar words missing from model vocab');
  process.exit(1);
}
console.log(anyMissing ? 'OK — missing words are tolerated (post-processing tolerant)' : 'OK — full grammar coverage');

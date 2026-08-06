/**
 * voiceGrammarConsistency.test.js — pins electron/voice-grammar.json (the
 * Vosk setGrammar word lists) to the LIVE parser tables.
 *
 * The grammar is the accuracy core of the voice backend: it must never drift
 * from what the post-processing parsers accept. Any edit to EN_PATTERNS,
 * ZH_PATTERNS, EN_NUMBER_KEYS, airline words, … without regenerating the JSON
 * fails this test.
 *
 * Regenerate: node scripts/gen-vosk-grammar.mjs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { collectGrammarWords, grammarJson } from '../../../scripts/gen-vosk-grammar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const committed = JSON.parse(
  readFileSync(path.join(ROOT, 'electron', 'voice-grammar.json'), 'utf8')
);

describe('voice-grammar.json consistency', () => {
  it('matches the live parser tables (en + zh)', () => {
    expect(committed).toEqual(grammarJson());
  });

  it('is deterministic (sorted, no timestamps)', () => {
    const { words, wordsZh } = collectGrammarWords();
    expect(words).toEqual([...words].sort());
    expect(wordsZh).toEqual([...wordsZh].sort());
    expect(Object.keys(committed)).toEqual(['version', 'words', 'wordsZh']);
  });

  it('covers the core command vocabulary', () => {
    for (const w of ['climb', 'descend', 'maintain', 'heading', 'altitude',
      'speed', 'clear', 'cleared', 'approach', 'runway', 'knots', 'feet',
      'one', 'two', 'three', 'zero', 'hundred', 'thousand', 'heavy',
      'tower', 'contact']) {
      expect(committed.words).toContain(w);
    }
    for (const w of ['爬升保持', '下降保持', '可以进近', '航向', '高度', '速度',
      '幺', '两', '洞', '节', '英尺']) {
      expect(committed.wordsZh).toContain(w);
    }
  });
});

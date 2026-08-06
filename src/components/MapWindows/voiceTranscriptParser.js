/**
 * Voice transcript → patch-command chain parser — the shared core of the
 * voice pipeline (useVoiceCommands in-app, scripts/voice_sim.mjs for the
 * audio-free CLI sim).
 *
 * Pipeline: detectLanguage → parseCallsign (aircraft match → selection) →
 * greedy pattern match over the remaining text → sendPatchCommand payloads.
 * Output payloads are byte-identical to what the FlightPatchCommandBar
 * composer's buildPending produces (shared builders in src/utils/patchCommands.js).
 *
 * Pure + DOM-free with explicit .js specifiers so Node can load it directly.
 *
 * Translation rules (human phrase → command):
 *   heading:  fly heading N / heading N / turn to heading N /
 *             turn left|right heading N / left|right heading N        → update_heading (absolute)
 *   altitude: climb|descend and maintain N / climb|descend to N /
 *             fly altitude N / altitude N / level (off) (at) N /
 *             maintain N / flight level N                             → altitude
 *   speed:    reduce (speed) to N / increase speed to N / slow (down) to N /
 *             fly speed N / speed N / maintain N knots                → update_speed
 *   cfa:      clear(ed) (for) (the) [ils|rnav|visual|loc|vor|ndb] approach|appr
 *             → clear_for_appr (supersedes chain); a trailing
 *             "runway N (left|right|center)" designator is consumed and
 *             ignored — the aircraft's assigned runway stays authoritative
 *   bare callsign: selection only (no command)
 *
 * Disambiguation for bare "maintain N": unit word wins (knots→speed,
 * feet→altitude); flight level→altitude ×100; else N ≥ 1000 → altitude,
 * N < 1000 → speed. Altitudes spoken in meters (米 / meters / m) are
 * converted to feet before the payload is built (the wire contract is feet).
 *
 * Anything unmatched becomes a notice ("unsupported: …") — never dropped.
 */

import { detectLanguage, parseCallsign, callsignCandidates, EN_FILLER_WORDS } from './voiceCallsignParser.js';
import { parseSpokenNumberValue, lookupUnitWord, EN_UNIT_WORDS } from './voiceNumberParser.js';
import { isFuzzyEligible, maxDistForWord, fuzzyMatch, resolveCuratedPhrase } from './voiceFuzzy.js';
import {
  buildHeadingPayload, buildAltitudePayload, buildSpeedPayload,
  buildClearApprPayload, pad3, FT_PER_METER,
} from '../../utils/patchCommands.js';

// ─── Pattern tables (longest prefix first) ─────────────────────────────
// (exported for scripts/gen_voice_fuzzy_acceptance.mjs — the fuzzy
// acceptance table is generated from the REAL tables, never duplicated)

export const EN_PATTERNS = [
  { type: 'heading', words: ['turn', 'left', 'heading'] },
  { type: 'heading', words: ['turn', 'right', 'heading'] },
  { type: 'heading', words: ['turn', 'to', 'heading'] },
  { type: 'altitude', words: ['climb', 'and', 'maintain'] },
  { type: 'altitude', words: ['descend', 'and', 'maintain'] },
  { type: 'altitude', words: ['level', 'off', 'at'] },
  { type: 'speed', words: ['reduce', 'speed', 'to'] },
  { type: 'speed', words: ['increase', 'speed', 'to'] },
  { type: 'speed', words: ['slow', 'down', 'to'] },
  { type: 'heading', words: ['fly', 'heading'] },
  { type: 'heading', words: ['left', 'heading'] },
  { type: 'heading', words: ['right', 'heading'] },
  { type: 'altitude', words: ['fly', 'altitude'] },
  { type: 'speed', words: ['fly', 'speed'] },
  { type: 'fl', words: ['flight', 'level'] },
  { type: 'altitude', words: ['climb', 'to'] },
  { type: 'altitude', words: ['descend', 'to'] },
  { type: 'speed', words: ['reduce', 'to'] },
  { type: 'speed', words: ['slow', 'to'] },
  { type: 'altitude', words: ['level', 'at'] },
  { type: 'altitude', words: ['level', 'off'] },
  { type: 'heading', words: ['heading'] },
  { type: 'altitude', words: ['altitude'] },
  { type: 'maintain', words: ['maintain'] },
  { type: 'speed', words: ['speed'] },
  { type: 'fl', words: ['fl'] },
];

const ZH_PATTERNS = [
  { type: 'altitude', chars: '爬升保持' },
  { type: 'altitude', chars: '下降保持' },
  { type: 'heading', chars: '左转航向' },
  { type: 'heading', chars: '右转航向' },
  { type: 'heading', chars: '转向航向' },
  { type: 'cfa', chars: '可以进近' },
  { type: 'cfa', chars: '允许进近' },
  { type: 'heading', chars: '飞航向' },
  { type: 'altitude', chars: '飞高度' },
  { type: 'fl', chars: '高度层' },
  { type: 'speed', chars: '减速至' },
  { type: 'speed', chars: '加速至' },
  { type: 'speed', chars: '飞速度' },
  { type: 'altitude', chars: '爬升至' },
  { type: 'altitude', chars: '下降至' },
  { type: 'heading', chars: '航向' },
  { type: 'altitude', chars: '高度' },
  { type: 'altitude', chars: '平飞' },
  { type: 'maintain', chars: '保持' },
  { type: 'speed', chars: '速度' },
  { type: 'cfa', chars: '进近' },
];

// Sort longest-first so the most specific prefix wins
EN_PATTERNS.sort((a, b) => b.words.length - a.words.length);
ZH_PATTERNS.sort((a, b) => b.chars.length - a.chars.length);

/** Fuzzy-eligible EN pattern words (exact-only: 'fl', 'at' — too short).
 *  Exported for scripts/gen_voice_fuzzy_acceptance.mjs. */
export const EN_PATTERN_KEYS = [...new Set(EN_PATTERNS.flatMap((p) => p.words))]
  .filter((w) => isFuzzyEligible(w));

// Filler words ("uh", "um", …) chain like connectors so "…and uh reduce
// speed to 180" parses; they carry no meaning.
const EN_CONNECTORS = new Set(['and', 'then', 'also', 'please', ...EN_FILLER_WORDS]);
const ZH_CONNECTORS = ['然后', '还有', '请'];

// Flexible EN clear-for-approach grammar (replaces the fixed table entries):
//   clear|cleared [for] [the] [ils|rnav|visual|loc|vor|ndb] approach|appr
const EN_CFA_HEADS = new Set(['clear', 'cleared']);
export const EN_APPROACH_TYPES = new Set(['ils', 'rnav', 'visual', 'loc', 'vor', 'ndb']);

/** Fuzzy-eligible approach types (all ≥ 3 chars). Exported for the generator. */
export const EN_APPROACH_TYPE_KEYS = [...EN_APPROACH_TYPES];

// Runway suffix after a cfa phrase — full words (speech) or letters (typed "13L").
const EN_RUNWAY_SUFFIX = new Set(['left', 'right', 'center', 'l', 'r', 'c']);

// ─── Prefix matching ──────────────────────────────────────────────────

function matchEnPrefix(rest, pattern) {
  const tokens = rest.split(/\s+/);
  if (tokens.length < pattern.words.length) return null;
  // Deviation budget: at most ONE deviation per pattern match — either one
  // connector-skip or one fuzzy/curated word, never both, never twice.
  let k = 0;
  let deviated = false;
  for (let j = 0; j < pattern.words.length; j++) {
    const pw = pattern.words[j];
    const tok = tokens[k] ? tokens[k].toLowerCase() : null;
    if (tok === pw) { k++; continue; }
    if (deviated) return null;   // second deviation anywhere → no match

    // Curated 2-token window ("eff el" → fl)
    const joined2 = tok && tokens[k + 1] ? tok + ' ' + tokens[k + 1].toLowerCase() : null;
    if (joined2 && resolveCuratedPhrase(joined2) === pw) { deviated = true; k += 2; continue; }

    // Connector-skip: one stray connector token swallowed when the NEXT
    // token is the exact pattern word ("climb and THEN maintain 9000",
    // "turn left UH heading 360" — fillers chain via EN_CONNECTORS).
    if (j > 0 && tok && EN_CONNECTORS.has(tok) && tokens[k + 1] && tokens[k + 1].toLowerCase() === pw) {
      deviated = true; k += 2; continue;
    }

    // Single-token fuzzy (per-candidate D-L caps; 'reading' → heading)
    const m = tok ? fuzzyMatch(tok, EN_PATTERN_KEYS) : null;
    if (m && m.candidate === pw) { deviated = true; k++; continue; }
    return null;
  }
  return { type: pattern.type, text: pattern.words.join(' '), rest: tokens.slice(k).join(' ') };
}

function matchZhPrefix(rest, pattern) {
  if (!rest.startsWith(pattern.chars)) return null;
  return { type: pattern.type, text: pattern.chars, rest: rest.slice(pattern.chars.length) };
}

/** Strip leading connectors + punctuation so "and reduce speed…" parses. */
function stripConnector(rest, zh) {
  if (zh) {
    let s = rest;
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of ZH_CONNECTORS) {
        if (s.startsWith(c)) { s = s.slice(c.length); changed = true; }
      }
      const m = s.match(/^[，。；;,\s]+/);
      if (m) { s = s.slice(m[0].length); changed = true; }
    }
    return s;
  }
  const tokens = rest.split(/\s+/);
  let k = 0;
  while (k < tokens.length && (EN_CONNECTORS.has(tokens[k].toLowerCase()) || !/[a-z0-9一-鿿]/i.test(tokens[k]))) k++;
  return tokens.slice(k).join(' ');
}

// ─── Clear-for-approach: flexible EN grammar + consume-only runway ─────

/** EN "clear(ed) (for) (the) [type] approach|appr" — the approach tail is
 *  REQUIRED, so "clear the runway" / "cleared to land" / "cleared for the
 *  ILS" (no tail) deliberately fail → the normal unsupported path notices. */
function matchCfaEn(rest) {
  const tokens = rest.split(/\s+/);
  if (!tokens.length || !EN_CFA_HEADS.has(tokens[0].toLowerCase())) return null;
  let i = 1;
  if (tokens[i] && tokens[i].toLowerCase() === 'for') i += 1;
  if (tokens[i] && tokens[i].toLowerCase() === 'the') i += 1;
  // Approach type: exact → curated 2-3 token spelled window ("r nav",
  // "eye el ess") → single-token D-L ≤ 1 ("rnavv" → rnav, "nav" → rnav).
  if (tokens[i]) {
    const w1 = tokens[i].toLowerCase();
    if (EN_APPROACH_TYPES.has(w1)) {
      i += 1;
    } else {
      const w3 = tokens[i + 1] && tokens[i + 2] ? w1 + ' ' + tokens[i + 1].toLowerCase() + ' ' + tokens[i + 2].toLowerCase() : null;
      const w2 = tokens[i + 1] ? w1 + ' ' + tokens[i + 1].toLowerCase() : null;
      if (w3 && resolveCuratedPhrase(w3)) i += 3;
      else if (w2 && resolveCuratedPhrase(w2)) i += 2;
      else if (fuzzyMatch(w1, EN_APPROACH_TYPE_KEYS, 1)) i += 1;
    }
  }
  const tail = tokens[i] && tokens[i].toLowerCase();
  if (tail !== 'approach' && tail !== 'appr') return null;
  i += 1;
  return { type: 'cfa', text: tokens.slice(0, i).join(' '), rest: tokens.slice(i).join(' ') };
}

/** Consume-and-ignore a runway designator after a clear-for-approach phrase
 *  ("runway 13 left", "rwy one three", "runway 13L"). The designator is
 *  parsed and range-checked (1–36) but NEVER becomes a command or notice —
 *  the aircraft's assigned runway stays authoritative (user decision
 *  2026-08-05). Returns { rest } on a full match, or null (nothing consumed;
 *  the caller falls through → "runway banana" becomes an unsupported notice). */
function matchRunwayValue(rest, zh) {
  if (zh) return null;
  const tokens = stripConnector(rest, false).split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens[0]) return null;
  const head = tokens[0].toLowerCase();
  if (head !== 'runway' && head !== 'rwy') return null;
  let i = 1;
  let value = 0;
  const attached = (tokens[i] || '').match(/^(\d{1,2})([lrc])$/i);   // typed "13L" — parseSpokenNumberValue can't see this token
  if (attached) {
    value = parseInt(attached[1], 10);
    i += 1;
  } else {
    const num = parseSpokenNumberValue(tokens.slice(i), 'en');
    if (!num) return null;
    value = num.value;
    i += num.consumed;
  }
  if (value < 1 || value > 36) return null;
  if (EN_RUNWAY_SUFFIX.has((tokens[i] || '').toLowerCase())) i += 1;
  return { rest: tokens.slice(i).join(' ') };
}

// ─── Value parsing (number + optional FL/unit after a prefix) ──────────

function parseCommandValueEn(remainder, forceFl) {
  const tokens = remainder.trim().split(/\s+/);
  if (!tokens.length || !tokens[0]) return null;
  let i = 0;
  let fl = !!forceFl;   // pattern type 'fl' already consumed the FL words
  if (!fl && tokens[0].toLowerCase() === 'flight' && (tokens[1] || '').toLowerCase() === 'level') { fl = true; i = 2; }
  else if (!fl && tokens[0].toLowerCase() === 'fl') { fl = true; i = 1; }
  else if (!fl) {
    // Curated spelled FL ("eff el 90") — the D-L distance can't catch letters
    const joined = tokens[1] ? tokens[0].toLowerCase() + ' ' + tokens[1].toLowerCase() : null;
    if (joined && resolveCuratedPhrase(joined) === 'fl') { fl = true; i = 2; }
  }
  const num = parseSpokenNumberValue(tokens.slice(i), 'en');
  if (!num) return null;
  let unit = null;
  const after = tokens.slice(i + num.consumed);
  const unitKey = after[0] ? lookupUnitWord(after[0].toLowerCase()) : undefined;
  if (unitKey !== undefined) { unit = EN_UNIT_WORDS[unitKey]; i += num.consumed + 1; }
  else i += num.consumed;
  return { value: num.value, fl, unit, text: tokens.slice(0, i).join(' '), rest: tokens.slice(i).join(' ') };
}

function parseCommandValueZh(remainder, forceFl) {
  const str = remainder.trim();
  if (!str) return null;
  let i = 0;
  let fl = !!forceFl;   // pattern type 'fl' already consumed the 高度层 chars
  if (!fl && str.startsWith('高度层')) { fl = true; i = 3; }
  const num = parseSpokenNumberValue(str.slice(i), 'zh');
  if (!num) return null;
  let unit = null;
  if (str.startsWith('英尺', i + num.consumed)) { unit = 'altitude'; i += num.consumed + 2; }
  else if (str.startsWith('米', i + num.consumed)) { unit = 'altitude-m'; i += num.consumed + 1; }
  else if (str[i + num.consumed] === '节') { unit = 'speed'; i += num.consumed + 1; }
  else i += num.consumed;
  return { value: num.value, fl, unit, text: str.slice(0, i), rest: str.slice(i) };
}

// ─── Type resolution, range checks, command building ───────────────────

/** The pattern's type → final payload type (resolves the maintain ambiguity). */
function resolveType(patternType, pv) {
  switch (patternType) {
    case 'heading': return 'update_heading';
    case 'altitude':
    case 'fl': return 'altitude';
    case 'speed': return 'update_speed';
    case 'maintain':
      if (pv.unit === 'speed') return 'update_speed';
      if (pv.unit === 'altitude' || pv.unit === 'altitude-m' || pv.fl) return 'altitude';
      return pv.value >= 1000 ? 'altitude' : 'update_speed';
    case 'cfa': return 'clear_for_appr';
    default: return null;
  }
}

/** Range check (out of range → the phrase is reported unsupported). */
function rangeCheck(type, value, fl) {
  if (type === 'update_heading') return value >= 1 && value <= 360;
  if (type === 'altitude') {
    if (fl && value > 250) return false;   // flight levels only up to 250
    const ft = fl ? value * 100 : value;
    return ft >= 500 && ft <= 60000;
  }
  if (type === 'update_speed') return value >= 90 && value <= 300;
  return true;
}

function buildCommand(type, callSign, value, fl) {
  if (type === 'update_heading') {
    return { type, label: 'Fly Heading ' + pad3(value), payload: buildHeadingPayload(callSign, value) };
  }
  if (type === 'altitude') {
    const ft = fl ? value * 100 : value;
    return { type, label: 'Fly Altitude ' + ft, payload: buildAltitudePayload(callSign, ft) };
  }
  if (type === 'update_speed') {
    return { type, label: 'Fly Speed ' + value, payload: buildSpeedPayload(callSign, value) };
  }
  if (type === 'clear_for_appr') {
    return { type, label: 'Clear for Approach', payload: buildClearApprPayload(callSign) };
  }
  return null;
}

// ─── Segment matching (greedy longest-prefix, leftover → notices) ──────

function matchSegment(segs, lang, callSign, commands, notices) {
  const zh = lang === 'zh';
  let i = 0;
  let rest = segs[0] || '';
  let unsupportedBuf = '';
  const flush = () => {
    if (unsupportedBuf) {
      notices.push('unsupported: "' + unsupportedBuf.trim() + '"');
      unsupportedBuf = '';
    }
  };

  while (rest || i < segs.length - 1) {
    if (!rest) {
      // Advance to the next segment — flush first so the unsupported buffer
      // never spans segments (same grouping as the old per-segment calls).
      flush();
      i += 1;
      rest = segs[i];
      continue;
    }
    rest = stripConnector(rest, zh);
    if (!rest) continue;

    let hit = null;
    if (!zh) {
      // Flexible clear-for-approach grammar, tried before the table at every
      // loop position so "…then clear for approach" still hits.
      const first = rest.split(/\s+/)[0].toLowerCase();
      if (first === 'clear' || first === 'cleared') hit = matchCfaEn(rest);
    }
    if (!hit) {
      const patterns = zh ? ZH_PATTERNS : EN_PATTERNS;
      for (const p of patterns) {
        const m = zh ? matchZhPrefix(rest, p) : matchEnPrefix(rest, p);
        if (m) { hit = m; break; }
      }
    }

    if (!hit) {
      // Nothing matched — consume one token as an unsupported chunk
      if (zh) {
        unsupportedBuf += rest[0];
        rest = rest.slice(1);
      } else {
        const sp = rest.search(/\s/);
        const word = sp === -1 ? rest : rest.slice(0, sp);
        unsupportedBuf += (unsupportedBuf ? ' ' : '') + word;
        rest = sp === -1 ? '' : rest.slice(sp + 1);
      }
      continue;
    }

    // Clear for Approach takes no value — an optional trailing runway
    // designator ("runway 13 left", comma-separated or not) is consumed
    // and ignored, never noticed.
    if (hit.type === 'cfa') {
      flush();
      commands.push(buildCommand('clear_for_appr', callSign));
      rest = hit.rest;
      if (rest) {
        const rw = matchRunwayValue(rest, zh);
        if (rw) { rest = rw.rest; continue; }
      } else if (i + 1 < segs.length) {
        const rw = matchRunwayValue(segs[i + 1], zh);
        if (rw) { i += 1; rest = rw.rest; continue; }
      }
      continue;
    }

    const pv = zh ? parseCommandValueZh(hit.rest, hit.type === 'fl') : parseCommandValueEn(hit.rest, hit.type === 'fl');
    if (!pv) {
      // Prefix matched but no value ("heading" alone) — report unsupported
      unsupportedBuf += hit.text + ' ';
      rest = hit.rest;
      continue;
    }

    const type = resolveType(hit.type, pv);
    // Spoken meters ("米" / "meters" / "m") → feet before the range gate and
    // payload build (wire contract is feet). FL phrases are always feet, so an
    // explicit meter unit under FL is ignored (nonsense phrase — FL+米 isn't real).
    const value = pv.unit === 'altitude-m' && !pv.fl ? Math.round(pv.value * FT_PER_METER) : pv.value;
    if (!rangeCheck(type, value, pv.fl)) {
      notices.push('unsupported: "' + (hit.text + ' ' + pv.text).trim() + '" (out of range)');
      rest = pv.rest;
      continue;
    }

    flush();
    const cmd = buildCommand(type, callSign, value, pv.fl);
    if (cmd) commands.push(cmd);
    rest = pv.rest;
  }

  flush();
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Parse a voice/typed transcript into a callsign (selection) + a command
 * chain of sendPatchCommand payloads.
 *
 * @param {string} transcript — raw transcript ("CSC6918: climb and maintain 9000, reduce speed to 180 knots")
 * @param {Object[]} aircraftList — live UDP aircraft (each has .callSign) for callsign resolution
 * @returns {{
 *   ok: boolean, callsign: string|null, aircraft: object|null, lang: 'en'|'zh',
 *   remainingText: string, commands: Array<{type, label, payload}>, notices: string[],
 *   renderedLine: string, reason?: string,
 * }} — commands empty = selection only; renderedLine mirrors the command
 *   window's line format ("CSC6918: Fly Altitude 9000, Fly Speed 180");
 *   reason (non-empty on ok:false) names the stage that stopped the parse.
 */
export function parseVoiceTranscript(transcript, aircraftList) {
  const text = String(transcript || '').trim();
  if (!text) {
    return { ok: false, callsign: null, aircraft: null, lang: 'en', remainingText: '', commands: [], notices: [], renderedLine: '', reason: 'empty transcript' };
  }

  const lang = detectLanguage(text);
  const list = aircraftList && aircraftList.length ? aircraftList : null;
  const diag = [];
  const parsed = list ? parseCallsign(text, lang, list, diag) : null;

  if (!parsed) {
    return {
      ok: false, callsign: null, aircraft: null, lang,
      remainingText: text, commands: [], notices: [],
      renderedLine: '',
      reason: !list ? 'no aircraft data' : (diag.length ? diag.join('; ') : 'callsign parse failed'),
    };
  }

  const commands = [];
  const notices = [];
  if (parsed.remainingText && parsed.remainingText.trim()) {
    const segments = parsed.remainingText.split(/[,，;；.。]+/).map(s => s.trim()).filter(Boolean);
    if (segments.length) matchSegment(segments, lang, parsed.callsign, commands, notices);
  }

  // Clear for Approach supersedes a composed chain (mirrors the composer);
  // then dedupe by type, last wins (the composer allows one command of each type per line).
  let final = commands;
  if (final.some(c => c.type === 'clear_for_appr')) final = final.filter(c => c.type === 'clear_for_appr');
  const byType = new Map();
  for (const c of final) byType.set(c.type, c);
  final = [...byType.values()];

  return {
    ok: true,
    callsign: parsed.callsign,
    aircraft: parsed.aircraft,
    lang,
    remainingText: parsed.remainingText,
    commands: final,
    notices,
    renderedLine: renderLine(parsed.callsign, final),
  };
}

/**
 * Try candidate transcripts in order against the full voice pipeline —
 * the primary System.Speech result first, then the engine's alternate
 * hypotheses ($r.Alternates, already confidence-ordered). First candidate
 * whose parse yields commands wins; a selection-only candidate (ok, 0
 * commands) never wins over a failing primary — a misheard bare callsign
 * in an alternate must not trigger a selection. No winner → the primary's
 * parse result is returned unchanged (notices/reason preserved).
 * Purely additive: with a single text it returns exactly
 * parseVoiceTranscript's result plus matchedText/candidateIndex.
 *
 * @param {string[]} texts — primary transcript first, then alternates
 * @param {Object[]} aircraftList
 * @returns {{ result: object, matchedText: string, candidateIndex: number }}
 */
export function parseVoiceCandidates(texts, aircraftList) {
  const candidates = [];
  const seen = new Set();
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;   // case-insensitive dedupe, primary stays first
    seen.add(key);
    candidates.push(s);
  }
  if (!candidates.length) {
    return { result: parseVoiceTranscript('', aircraftList), matchedText: '', candidateIndex: 0 };
  }
  let primary = null;
  for (let i = 0; i < candidates.length; i++) {
    const result = parseVoiceTranscript(candidates[i], aircraftList);
    if (i === 0) primary = result;
    if (result.ok && result.commands.length > 0) {
      return { result, matchedText: candidates[i], candidateIndex: i };
    }
  }
  return { result: primary, matchedText: candidates[0], candidateIndex: 0 };
}

function renderLine(callsign, commands) {
  if (!commands.length) return callsign + ':';
  return callsign + ': ' + commands.map(c => c.label).join(', ');
}

/**
 * Synthetic aircraft list for the CLI sim: every plausible callsign the
 * transcript itself mentions (spoken words or literal digits, e.g. "CSC6918"
 * or "CSC six nine one eight"), each with controlSeat 5 (approach) so
 * parsed commands pass the seat gate. Feed it to parseVoiceTranscript as
 * aircraftList when no live telemetry is available.
 */
export function buildSyntheticAircraftList(transcript, lang) {
  return callsignCandidates(transcript, lang).map(cs => ({
    callSign: cs,
    controlSeat: 5,
    position: { x: 0, y: 0, z: 0 },
    noseDirection: { x: 0, y: 0, z: 1 },
    airSpeedKnot: 200,
  }));
}

/**
 * Voice command matching: fuzzy-match spoken text against ATC command labels.
 *
 * Two-stage matching:
 *   1. Exact alias lookup (hand-curated spoken → command mappings)
 *   2. Token Jaccard similarity (EN) or character bigram Dice (ZH)
 *
 * Also handles sub-menu commands (runway/taxiway selection) by extracting
 * the sub-item name from the spoken text.
 */

import {
  CMD_CLEARED_TO_LAND, CMD_GO_AROUND, CMD_CONTINUE_APPROACH,
  CMD_CLEAR_FOR_TAKEOFF, CMD_LINE_UP_WAIT, CMD_HOLD_SHORT,
  CMD_PUSH_BACK, CMD_CONTACT_GROUND, CMD_CONTACT_TOWER,
  CMD_HOLD_SHORT_TAXI, CMD_HOLD_POSITION,
  CMD_TAXI_VIA, CMD_CONTACT_DEP,
  CMD_CHANGE_RWY, CMD_DISPATCH_TOW, CMD_SELECT_EXIT,
  CMD_STAND_BY, CMD_CROSS_RWY,
} from '../../utils/constants';

// ─── Command aliases ───────────────────────────────────────────────────

/**
 * Spoken phrase → canonical command label (English).
 * Keys are lowercase, values are the i18n labelKey for lookup.
 *
 * Includes common variations and shorthand that ATC controllers use.
 */
const EN_ALIASES = {
  // Clearances
  'cleared to land': 'cmd_cleared_to_land',
  'clear to land': 'cmd_cleared_to_land',
  'landing clearance': 'cmd_cleared_to_land',
  'cleared for takeoff': 'cmd_clear_for_takeoff',
  'clear for takeoff': 'cmd_clear_for_takeoff',
  'takeoff clearance': 'cmd_clear_for_takeoff',
  'take off': 'cmd_clear_for_takeoff',

  // Go around
  'go around': 'cmd_go_around',
  'going around': 'cmd_go_around',
  'abort': 'cmd_go_around',
  'abort approach': 'cmd_go_around',

  // Continue approach
  'continue approach': 'cmd_continue_appr',
  'continue': 'cmd_continue_appr',

  // Line up
  'line up and wait': 'cmd_line_up_wait',
  'line up': 'cmd_line_up_wait',
  'position and hold': 'cmd_line_up_wait',

  // Hold short
  'hold short': 'cmd_hold_short_rwy',
  'hold short of runway': 'cmd_hold_short_rwy',
  'hold short of the runway': 'cmd_hold_short_rwy',

  // Push back
  'push back': 'cmd_push_back_approved',
  'pushback': 'cmd_push_back_approved',
  'push back approved': 'cmd_push_back_approved',

  // Contact
  'contact ground': 'cmd_contact_gnd',
  'contact tower': 'cmd_contact_twr',
  'contact departure': 'cmd_contact_dep',
  'switch to ground': 'cmd_contact_gnd',
  'switch to tower': 'cmd_contact_twr',

  // Hold position
  'hold position': 'cmd_hold_position',
  'hold your position': 'cmd_hold_position',

  // Taxi
  'taxi via': 'cmd_taxi_via',
  'taxi': 'cmd_taxi_via',

  // Hold short taxi
  'hold short of taxiway': 'cmd_hold_short_taxi',

  // Dispatch tow
  'dispatch tow': 'cmd_dispatch_tow',
  'dispatch tow via': 'cmd_dispatch_tow',

  // Change runway
  'change runway': 'cmd_change_rwy',
  'change runway to': 'cmd_change_rwy',

  // Select exit
  'select exit': 'cmd_select_exit',
  'select exit at': 'cmd_select_exit',

  // Stand by
  'stand by': 'cmd_stand_by',
  'standby': 'cmd_stand_by',

  // Cross runway
  'cross runway': 'cmd_cross_rwy',
  'cross the runway': 'cmd_cross_rwy',
};

/**
 * Chinese spoken phrases → canonical command label.
 */
const ZH_ALIASES = {
  '可以落地': 'cmd_cleared_to_land',
  '允许落地': 'cmd_cleared_to_land',
  '落地': 'cmd_cleared_to_land',
  '可以起飞': 'cmd_clear_for_takeoff',
  '起飞': 'cmd_clear_for_takeoff',
  '复飞': 'cmd_go_around',
  '继续进近': 'cmd_continue_appr',
  '进跑道等待': 'cmd_line_up_wait',
  '跑道外等待': 'cmd_hold_short_rwy',
  '推开': 'cmd_push_back_approved',
  '推开批准': 'cmd_push_back_approved',
  '联系地面': 'cmd_contact_gnd',
  '联系塔台': 'cmd_contact_twr',
  '联系离港': 'cmd_contact_dep',
  '原地等待': 'cmd_hold_position',
  '滑行经由': 'cmd_taxi_via',
  '滑行': 'cmd_taxi_via',
  '滑行道外等待': 'cmd_hold_short_taxi',
  '拖车经由': 'cmd_dispatch_tow',
  '更换跑道': 'cmd_change_rwy',
  '更换跑道至': 'cmd_change_rwy',
  '选择退出道': 'cmd_select_exit',
  '等待': 'cmd_stand_by',
  '穿越跑道': 'cmd_cross_rwy',
};

// ─── Token Jaccard similarity ──────────────────────────────────────────

const EN_STOP_WORDS = new Set([
  'the', 'to', 'of', 'and', 'a', 'an', 'please', 'for', 'at',
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[_\-\p{P}]/gu, ' ') // replace underscores, hyphens, and punctuation with spaces
    .split(/\s+/)
    .filter(w => w.length > 0 && !EN_STOP_WORDS.has(w));
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Partial word overlap: checks if >=3 char substrings of words in A
 * appear in words from B (and vice versa). Handles stem variants
 * like "landing" ≈ "land", "cleared" ≈ "clear".
 */
function partialOverlap(tokensA, tokensB) {
  let matches = 0;
  for (const a of tokensA) {
    if (a.length < 3) continue;
    for (const b of tokensB) {
      if (b.length < 3) continue;
      // Check if one is a substring of the other (stem matching)
      if (a.includes(b) || b.includes(a)) {
        matches++;
        break;
      }
    }
  }
  // Normalize by the max token count
  const maxLen = Math.max(tokensA.length, tokensB.length);
  return maxLen > 0 ? matches / maxLen : 0;
}

// ─── Character bigram Dice coefficient (for Chinese) ──────────────────

function bigrams(text) {
  const result = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    result.add(text.slice(i, i + 2));
  }
  return result;
}

function diceCoefficient(textA, textB) {
  const bgA = bigrams(textA);
  const bgB = bigrams(textB);
  if (bgA.size === 0 && bgB.size === 0) return 1;
  const intersection = new Set([...bgA].filter(x => bgB.has(x)));
  return (2 * intersection.size) / (bgA.size + bgB.size);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Find the best matching command for spoken text.
 *
 * @param {string} remainingText — text after callsign extraction
 * @param {Object[]} commandNodes — from getCommandsForAircraft(aircraft)
 *   Each node: { id, labelKey, commandId, label?, getChildren? }
 * @param {'en'|'zh'} lang
 * @returns {{ cmd: Object, score: number, subItem: string|null } | null}
 */
export function findBestCommandMatch(remainingText, commandNodes, lang) {
  if (!remainingText || !commandNodes.length) return null;

  const text = remainingText.trim();
  const aliasMap = lang === 'zh' ? ZH_ALIASES : EN_ALIASES;

  // ── Stage 1: Exact alias lookup ──────────────────────────────────
  for (const [phrase, labelKey] of Object.entries(aliasMap)) {
    if (text === phrase || text.startsWith(phrase)) {
      const cmd = commandNodes.find(c => c.labelKey === labelKey);
      if (cmd) {
        // Check if there's extra text after the alias (sub-item)
        const after = text.slice(phrase.length).trim();
        return {
          cmd,
          score: 1.0,
          subItem: after || null,
        };
      }
    }

    // Also check: does the text END with the phrase?
    // (e.g., text ends with "cleared to land" but had extra leading noise)
    // Less common, but handle: "please cleared to land" → match "cleared to land"
    if (text.endsWith(phrase)) {
      const cmd = commandNodes.find(c => c.labelKey === labelKey);
      if (cmd) {
        return { cmd, score: 0.95, subItem: null };
      }
    }

    // Contains match (lower confidence)
    if (text.includes(phrase)) {
      const cmd = commandNodes.find(c => c.labelKey === labelKey);
      if (cmd) {
        return { cmd, score: 0.85, subItem: null };
      }
    }
  }

  // ── Stage 2: Fuzzy similarity ───────────────────────────────────
  let bestCmd = null;
  let bestScore = 0;

  for (const cmd of commandNodes) {
    // Use label if present, otherwise labelKey (without prefix)
    const label = cmd.label || (cmd.labelKey ? cmd.labelKey.replace('cmd_', '') : cmd.id);
    let score;

    if (lang === 'zh') {
      score = diceCoefficient(text, label);
    } else {
      const textTokens = tokenize(text);
      const labelTokens = tokenize(label);
      const jaccard = jaccardSimilarity(textTokens, labelTokens);
      const partial = partialOverlap(textTokens, labelTokens);

      // Take the best of Jaccard + partial overlap
      score = Math.max(jaccard, partial * 0.85); // partial overlap gets slight penalty

      // Boost: check if any word from the label is in the text
      const labelWords = label.toLowerCase().split(/\s+/);
      const textWords = text.toLowerCase().split(/\s+/);
      const wordOverlap = labelWords.filter(w => textWords.includes(w)).length;
      if (wordOverlap > 0) {
        score = Math.max(score, wordOverlap / Math.max(labelWords.length, textWords.length));
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCmd = cmd;
    }
  }

  return bestCmd ? { cmd: bestCmd, score: bestScore, subItem: null } : null;
}

/**
 * Match threshold — scores below this are treated as "no match".
 * 0.55 is tuned for Jaccard similarity on short ATC phrases.
 */
export const MATCH_THRESHOLD = 0.55;

/**
 * Build a JSGF grammar string for SpeechGrammarList.
 * This constrains the speech recognizer to expect ATC command phrases.
 *
 * @param {Object[]} commandNodes
 * @param {'en'|'zh'} lang
 * @returns {string} JSGF grammar
 */
export function buildSpeechGrammar(commandNodes, lang) {
  const aliasMap = lang === 'zh' ? ZH_ALIASES : EN_ALIASES;
  const phrases = Object.keys(aliasMap);

  // Also include the command labels themselves
  for (const cmd of commandNodes) {
    const label = cmd.label || (cmd.labelKey ? cmd.labelKey.replace('cmd_', '') : cmd.id);
    if (!phrases.includes(label.toLowerCase())) {
      phrases.push(label.toLowerCase());
    }
  }

  // JSGF format: #JSGF V1.0; grammar atc; public <command> = phrase1 | phrase2 | ...;
  const escaped = phrases.map(p => p.replace(/[;|()\[\]<>*+]/g, '\\$&'));
  return `#JSGF V1.0; grammar atc; public <command> = ${escaped.join(' | ')};`;
}

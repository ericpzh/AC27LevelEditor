import { describe, it, expect } from 'vitest';
import {
  findBestCommandMatch,
  MATCH_THRESHOLD,
  buildSpeechGrammar,
} from '../../../src/components/MapWindows/voiceCommandMatcher';

// Sample command nodes matching what getCommandsForAircraft returns
function makeCmd(id, labelKey, commandId) {
  return { id, labelKey, commandId };
}

const TOWER_ARR_COMMANDS = [
  makeCmd('cleared_to_land', 'cmd_cleared_to_land', 23),
  makeCmd('go_around', 'cmd_go_around', 24),
  makeCmd('continue_appr', 'cmd_continue_appr', 25),
  makeCmd('select_exit', 'cmd_select_exit', 45),
  makeCmd('change_rwy', 'cmd_change_rwy', 43),
  makeCmd('cross_rwy', 'cmd_cross_rwy', 47),
  makeCmd('contact_dep', 'cmd_contact_dep', 42),
  makeCmd('contact_gnd', 'cmd_contact_gnd', 33),
  makeCmd('contact_twr', 'cmd_contact_twr', 22),
];

const TOWER_DEP_COMMANDS = [
  makeCmd('clear_for_takeoff', 'cmd_clear_for_takeoff', 26),
  makeCmd('line_up_wait', 'cmd_line_up_wait', 27),
  makeCmd('hold_short_rwy', 'cmd_hold_short_rwy', 28),
  makeCmd('change_rwy', 'cmd_change_rwy', 43),
  makeCmd('taxi_via', 'cmd_taxi_via', 41),
  makeCmd('hold_short_taxi', 'cmd_hold_short_taxi', 39),
  makeCmd('dispatch_tow', 'cmd_dispatch_tow', 44),
  makeCmd('stand_by', 'cmd_stand_by', 46),
];

// ─── English ───────────────────────────────────────────────────────────

describe('findBestCommandMatch (EN)', () => {
  it('matches exact alias "cleared to land"', () => {
    const r = findBestCommandMatch('cleared to land', TOWER_ARR_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('cleared_to_land');
    expect(r.score).toBe(1.0);
  });

  it('matches exact alias "clear for takeoff"', () => {
    const r = findBestCommandMatch('clear for takeoff', TOWER_DEP_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('clear_for_takeoff');
    expect(r.score).toBe(1.0);
  });

  it('matches "go around"', () => {
    const r = findBestCommandMatch('go around', TOWER_ARR_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('go_around');
  });

  it('matches "line up and wait" / "line up"', () => {
    let r = findBestCommandMatch('line up and wait', TOWER_DEP_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('line_up_wait');

    r = findBestCommandMatch('line up', TOWER_DEP_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('line_up_wait');
  });

  it('matches "contact ground"', () => {
    const r = findBestCommandMatch('contact ground', TOWER_ARR_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('contact_gnd');
  });

  it('matches "contact tower"', () => {
    const r = findBestCommandMatch('contact tower', TOWER_ARR_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('contact_twr');
  });

  it('matches "push back"', () => {
    const groundCommands = [
      makeCmd('push_back_approved', 'cmd_push_back_approved', 31),
      makeCmd('contact_gnd', 'cmd_contact_gnd', 33),
    ];
    const r = findBestCommandMatch('push back', groundCommands, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('push_back_approved');
  });

  it('matches alias prefix with sub-item ("taxi via alpha")', () => {
    const r = findBestCommandMatch('taxi via alpha', TOWER_DEP_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('taxi_via');
    expect(r.subItem).toBe('alpha');
  });

  it('falls back to fuzzy match for unrecognized phrases', () => {
    // "allow landing" is not an alias but should fuzzy-match "cleared to land"
    const r = findBestCommandMatch('allow landing', TOWER_ARR_COMMANDS, 'en');
    // With fuzzy matching, "landing" should overlap with "cleared to land" label
    expect(r).not.toBeNull();
    // The score may be moderate but should be above 0
    expect(r.score).toBeGreaterThan(0);
  });

  it('returns null for empty text', () => {
    const r = findBestCommandMatch('', TOWER_ARR_COMMANDS, 'en');
    expect(r).toBeNull();
  });

  it('returns null for empty commands array', () => {
    const r = findBestCommandMatch('cleared to land', [], 'en');
    expect(r).toBeNull();
  });

  it('matches "stand by"', () => {
    const r = findBestCommandMatch('stand by', TOWER_DEP_COMMANDS, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('stand_by');
  });

  it('matches "hold position"', () => {
    const groundCommands = [
      makeCmd('hold_position', 'cmd_hold_position', 40),
    ];
    const r = findBestCommandMatch('hold your position', groundCommands, 'en');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('hold_position');
  });
});

// ─── Chinese ───────────────────────────────────────────────────────────

describe('findBestCommandMatch (ZH)', () => {
  const zhCommands = [
    makeCmd('cleared_to_land', 'cmd_cleared_to_land', 23),
    makeCmd('go_around', 'cmd_go_around', 24),
    makeCmd('clear_for_takeoff', 'cmd_clear_for_takeoff', 26),
    makeCmd('push_back_approved', 'cmd_push_back_approved', 31),
    makeCmd('contact_gnd', 'cmd_contact_gnd', 33),
    makeCmd('contact_twr', 'cmd_contact_twr', 22),
    makeCmd('line_up_wait', 'cmd_line_up_wait', 27),
    makeCmd('hold_position', 'cmd_hold_position', 40),
    makeCmd('stand_by', 'cmd_stand_by', 46),
    makeCmd('cross_rwy', 'cmd_cross_rwy', 47),
  ];

  it('matches "可以落地"', () => {
    const r = findBestCommandMatch('可以落地', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('cleared_to_land');
  });

  it('matches "可以起飞"', () => {
    const r = findBestCommandMatch('可以起飞', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('clear_for_takeoff');
  });

  it('matches "复飞"', () => {
    const r = findBestCommandMatch('复飞', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('go_around');
  });

  it('matches "联系地面"', () => {
    const r = findBestCommandMatch('联系地面', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('contact_gnd');
  });

  it('matches "等待"', () => {
    const r = findBestCommandMatch('等待', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('stand_by');
  });

  it('matches "穿越跑道"', () => {
    const r = findBestCommandMatch('穿越跑道', zhCommands, 'zh');
    expect(r).not.toBeNull();
    expect(r.cmd.id).toBe('cross_rwy');
  });
});

// ─── buildSpeechGrammar ────────────────────────────────────────────────

describe('buildSpeechGrammar', () => {
  it('produces valid JSGF grammar string', () => {
    const grammar = buildSpeechGrammar(TOWER_ARR_COMMANDS, 'en');
    expect(grammar).toContain('#JSGF V1.0');
    expect(grammar).toContain('grammar atc');
    expect(grammar).toContain('public <command>');
    expect(grammar).toContain('cleared to land');
  });

  it('includes both aliases and command labels', () => {
    const grammar = buildSpeechGrammar(TOWER_DEP_COMMANDS, 'en');
    expect(grammar).toContain('clear for takeoff');
    expect(grammar).toContain('line up and wait');
  });
});

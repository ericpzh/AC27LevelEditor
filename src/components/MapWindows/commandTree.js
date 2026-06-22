/**
 * Command tree data model for the flight strips command interface.
 *
 * Seat layout:
 *   1 = RAMP    2 = GROUND    3 = TOWER
 *
 * TOWER commands are split: DEP-only (flightDirection=0), ARR-only (flightDirection=1).
 * Some ground commands apply to both DEP & ARR (no flightDirection filter).
 */

import {
  CMD_CONTACT_TOWER, CMD_CLEARED_TO_LAND, CMD_GO_AROUND, CMD_CONTINUE_APPROACH,
  CMD_CLEAR_FOR_TAKEOFF, CMD_LINE_UP_WAIT, CMD_HOLD_SHORT,
  CMD_PUSH_BACK, CMD_CONTACT_GROUND,
  CMD_HOLD_SHORT_TAXI, CMD_HOLD_POSITION,
  CMD_TAXI_VIA, CMD_CONTACT_DEP,
  CMD_CHANGE_RWY, CMD_DISPATCH_TOW, CMD_SELECT_EXIT,
  CMD_STAND_BY, CMD_CROSS_RWY,
} from '../../utils/constants';

// ─── Module-level taxiway list (set once on mount) ────────────────────

let _taxiways = [];

/** Call once when taxiway data arrives from collectValues IPC. */
export function setTaxiways(paths) {
  const names = new Set();
  for (const p of paths) {
    if (p.name && typeof p.name === 'string') {
      const trimmed = p.name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  _taxiways = Array.from(names).sort((a, b) => {
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

// ─── Dynamic sub-menu generators ──────────────────────────────────────

function generateRunwayCommands(commandId) {
  return (ac) => {
    if (!ac.runway) return [];
    const parts = ac.runway.split('/').map(s => s.trim()).filter(Boolean);
    return parts.map(rwy => ({
      id: 'rwy_' + rwy,
      label: rwy,
      commandId,
    }));
  };
}

function generateTaxiwayCommands(commandId) {
  return (_ac) => {
    if (!_taxiways.length) return [];
    return _taxiways.map(twy => ({
      id: 'twy_' + twy,
      label: twy,
      commandId,
    }));
  };
}

// ─── Flat command registry ────────────────────────────────────────────

const CMD = {
  // RAMP / GROUND
  push_back_approved: { id: 'push_back_approved', labelKey: 'cmd_push_back_approved', commandId: CMD_PUSH_BACK },
  change_rwy:         { id: 'change_rwy',         labelKey: 'cmd_change_rwy',         commandId: CMD_CHANGE_RWY },
  contact_gnd:        { id: 'contact_gnd',        labelKey: 'cmd_contact_gnd',        commandId: CMD_CONTACT_GROUND },
  contact_twr:        { id: 'contact_twr',        labelKey: 'cmd_contact_twr',        commandId: CMD_CONTACT_TOWER },
  contact_dep:        { id: 'contact_dep',        labelKey: 'cmd_contact_dep',        commandId: CMD_CONTACT_DEP },
  hold_position:      { id: 'hold_position',      labelKey: 'cmd_hold_position',      commandId: CMD_HOLD_POSITION },
  taxi_via:           { id: 'taxi_via',           labelKey: 'cmd_taxi_via',           commandId: CMD_TAXI_VIA },
  hold_short_taxi:    { id: 'hold_short_taxi',    labelKey: 'cmd_hold_short_taxi',    commandId: CMD_HOLD_SHORT_TAXI },
  dispatch_tow:       { id: 'dispatch_tow',       labelKey: 'cmd_dispatch_tow',       commandId: CMD_DISPATCH_TOW },
  // TOWER DEP
  clear_for_takeoff:  { id: 'clear_for_takeoff',  labelKey: 'cmd_clear_for_takeoff',  commandId: CMD_CLEAR_FOR_TAKEOFF },
  line_up_wait:       { id: 'line_up_wait',       labelKey: 'cmd_line_up_wait',       commandId: CMD_LINE_UP_WAIT },
  hold_short_rwy:     { id: 'hold_short_rwy',     labelKey: 'cmd_hold_short_rwy',     commandId: CMD_HOLD_SHORT },
  stand_by:           { id: 'stand_by',           labelKey: 'cmd_stand_by',           commandId: CMD_STAND_BY },
  // TOWER ARR
  cleared_to_land:    { id: 'cleared_to_land',    labelKey: 'cmd_cleared_to_land',    commandId: CMD_CLEARED_TO_LAND },
  go_around:          { id: 'go_around',          labelKey: 'cmd_go_around',          commandId: CMD_GO_AROUND },
  continue_appr:      { id: 'continue_appr',      labelKey: 'cmd_continue_appr',      commandId: CMD_CONTINUE_APPROACH },
  select_exit:        { id: 'select_exit',        labelKey: 'cmd_select_exit',        commandId: CMD_SELECT_EXIT },
  // TOWER shared (DEP & ARR ground)
  cross_rwy:          { id: 'cross_rwy',          labelKey: 'cmd_cross_rwy',          commandId: CMD_CROSS_RWY },
};

// ─── Root menu tree ───────────────────────────────────────────────────

const ROOT_COMMANDS = [
  // ═══ RAMP (seat 1) ═══
  { ...CMD.push_back_approved, seats: [1], airborne: false },
  { ...CMD.change_rwy,         seats: [1], airborne: false,
    getChildren: generateRunwayCommands(CMD_CHANGE_RWY) },
  { ...CMD.contact_gnd,        seats: [1], airborne: false },

  // ═══ GROUND (seat 2) ═══
  { ...CMD.push_back_approved, seats: [2], airborne: false },
  { ...CMD.change_rwy,         seats: [2], airborne: false,
    getChildren: generateRunwayCommands(CMD_CHANGE_RWY) },
  { ...CMD.taxi_via,           seats: [2], airborne: false,
    getChildren: generateTaxiwayCommands(CMD_TAXI_VIA) },
  { ...CMD.hold_short_taxi,    seats: [2], airborne: false,
    getChildren: generateTaxiwayCommands(CMD_HOLD_SHORT_TAXI) },
  { ...CMD.dispatch_tow,       seats: [2], airborne: false,
    getChildren: generateTaxiwayCommands(CMD_DISPATCH_TOW) },
  { ...CMD.contact_twr,        seats: [2], airborne: false },
  { ...CMD.stand_by,           seats: [2], airborne: false },
  { ...CMD.hold_position,      seats: [2], airborne: false },

  // ═══ TOWER (seat 3) — DEP only (ground, departure) ═══
  { ...CMD.clear_for_takeoff,  seats: [3], airborne: false, flightDirection: 0 },
  { ...CMD.line_up_wait,       seats: [3], airborne: false, flightDirection: 0 },
  { ...CMD.hold_short_rwy,     seats: [3], airborne: false, flightDirection: 0,
    getChildren: generateRunwayCommands(CMD_HOLD_SHORT) },
  { ...CMD.change_rwy,         seats: [3], airborne: false, flightDirection: 0,
    getChildren: generateRunwayCommands(CMD_CHANGE_RWY) },
  { ...CMD.taxi_via,           seats: [3], airborne: false, flightDirection: 0,
    getChildren: generateTaxiwayCommands(CMD_TAXI_VIA) },
  { ...CMD.hold_short_taxi,    seats: [3], airborne: false, flightDirection: 0,
    getChildren: generateTaxiwayCommands(CMD_HOLD_SHORT_TAXI) },
  { ...CMD.dispatch_tow,       seats: [3], airborne: false, flightDirection: 0,
    getChildren: generateTaxiwayCommands(CMD_DISPATCH_TOW) },
  { ...CMD.stand_by,           seats: [3], airborne: false, flightDirection: 0 },

  // ═══ TOWER (seat 3) — ARR only (airborne + ground, arrival) ═══
  { ...CMD.cleared_to_land,    seats: [3], airborne: true,  flightDirection: 1 },
  { ...CMD.go_around,          seats: [3], airborne: true,  flightDirection: 1 },
  { ...CMD.continue_appr,      seats: [3], airborne: true,  flightDirection: 1 },
  { ...CMD.select_exit,        seats: [3], flightDirection: 1,
    getChildren: generateTaxiwayCommands(CMD_SELECT_EXIT) },
  { ...CMD.change_rwy,         seats: [3], airborne: false, flightDirection: 1,
    getChildren: generateRunwayCommands(CMD_CHANGE_RWY) },

  // ═══ TOWER (seat 3) — shared (DEP & ARR ground, no flightDirection filter) ═══
  { ...CMD.cross_rwy,          seats: [3], airborne: false },
  { ...CMD.contact_dep,        seats: [3], airborne: false },
  { ...CMD.contact_gnd,        seats: [3], airborne: false },
];

// ─── Public API ───────────────────────────────────────────────────────

export function getCommandsForAircraft(ac) {
  if (!ac) return [];
  const isAirborne = ac.position && ac.position.y > 1.0;

  return ROOT_COMMANDS.filter(cmd => {
    if (cmd.seats && !cmd.seats.includes(ac.controlSeat)) return false;
    if (cmd.airborne === true && !isAirborne) return false;
    if (cmd.airborne === false && isAirborne) return false;
    if (cmd.flightDirection !== null && cmd.flightDirection !== undefined &&
        cmd.flightDirection !== ac.flightDirection) return false;
    return true;
  });
}

export function getCommandChildren(ac, parentCmd) {
  if (!parentCmd) return null;
  if (typeof parentCmd.getChildren === 'function') {
    return parentCmd.getChildren(ac);
  }
  return parentCmd.children || null;
}

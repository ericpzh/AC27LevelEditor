/**
 * Patch-command vocabulary shared by the FlightPatchCommandBar composer and
 * the voice-command parser (voiceTranscriptParser). One source of truth for
 * the command constants and the sendPatchCommand payload shapes so the
 * composer, the voice pipeline and the CLI sim never drift.
 *
 * Payload contract (wire): preload.sendPatchCommand(patch) → main.js
 * 'send-patch-command' → electron/patchFrame.js (type|CS|field… ASCII,
 * NUL-padded to 64 B, commandId 0x00E7) → AC27Appoarch plugin.
 */

export const TURN_RATE_DEG_S = 3;   // IFR standard-rate turn — the plugin rotates the nose at this °/s of GAME time
export const ALT_RATE_FPM = 1000;   // climb/descend speed — ft/min of GAME time (the plugin's default too)
export const ALT_MIN_FT = 1000;     // altitude slider floor
export const ALT_MAX_FT = 9000;     // altitude slider ceiling (extends to the rounded current above 9000)
export const SPEED_MIN_KTS = 180;   // fly-speed slider floor
export const SPEED_MAX_KTS = 240;   // fly-speed slider ceiling (the ACL approach-speed default)
export const FT_PER_GU = 100 / 0.3048;   // ≈ 328.084 — 1 GU = 100 m (user-confirmed; 15.24 GU = 5000 ft)
export const FT_PER_METER = 1 / 0.3048;  // ≈ 3.28084 — meters → feet (voice "米"/"meters"/"m" altitudes)

/**
 * Heading payload — the plugin's game-verified convention: heading H →
 * (dx, dy) = (sin H, cos H), +Z = north, +X = east (030 → 0.5, 0.8660;
 * 180 → 0, -1). HEADING-ONLY: no speed on this frame.
 */
export function buildHeadingPayload(callSign, headingDeg) {
  const rad = (headingDeg * Math.PI) / 180;
  return {
    type: 'update_heading', callSign,
    dx: +Math.sin(rad).toFixed(4) || 0,              // +X = east (|| 0 normalizes -0)
    dy: +Math.cos(rad).toFixed(4) || 0,              // +Z = north (|| 0 normalizes -0)
    rate: TURN_RATE_DEG_S,                           // smooth turn, °/s of game time
  };
}

/** Altitude payload — climb/descend-and-maintain, targetFt in feet. */
export function buildAltitudePayload(callSign, targetFt) {
  return {
    type: 'altitude', callSign,
    targetFt,
    rate: ALT_RATE_FPM,   // smooth vertical, ft/min of game time
  };
}

/** Speed payload — fly-speed override, raw knots (no end command). */
export function buildSpeedPayload(callSign, kts) {
  return {
    type: 'update_speed', callSign,
    kts,   // raw knots, int — the plugin re-asserts it every tick (no end command)
  };
}

/** Clear-for-approach payload — supersedes any composed chain. */
export function buildClearApprPayload(callSign) {
  return {
    type: 'clear_for_appr', callSign,
    rate: TURN_RATE_DEG_S,   // smooth handoff turn — the plugin rotates the nose onto the approach course at this °/s of game time
  };
}

/** Command-window label format ('Fly Heading 090', 'Fly Altitude 5000', …). */
export function pad3(n) {
  return String(n).padStart(3, '0');
}

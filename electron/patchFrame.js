/**
 * Shared patch-frame builder — the single implementation of the
 * send-patch-command wire contract (Mechanism B, extended frame 0x00E7).
 *
 * Frame: 8 B header (magic 'GATC' 0x43544147 u32 LE, version u16 = 1,
 * commandId u16 = 0x00E7) + pipe-delimited ASCII payload NUL-padded to
 * exactly 64 bytes = 72 B datagram. The plugin's FixedTick() postfix reads
 * the datagram back from the service's receive buffer, so the payload field
 * must be fixed-length + NUL-terminated.
 *
 * CommonJS so both the main process (require) and the ESM CLI
 * (scripts/voice_sim.mjs via createRequire) load one implementation.
 *
 * patch: { type: 'update_heading'|'update_position'|'clear_for_appr'|'altitude'|'update_speed',
 *          callSign, dx?, dy?, rate?, kts?, appr?, targetFt? }
 */

function buildPatchParts(patch) {
  const parts = [patch.type, patch.callSign];
  if (patch.type === 'update_heading' || patch.type === 'update_position') {
    parts.push(patch.dx, patch.dy);
    if (patch.type === 'update_heading' && patch.rate) parts.push(patch.rate);
  }
  else if (patch.type === 'clear_for_appr') {
    if (patch.kts) parts.push(patch.kts);
    if (patch.appr) parts.push(patch.appr);
    // Keyed (rate=N): the plugin's cfa parser treats any bare numeric
    // field as the approach speed in kts — an unkeyed rate would be
    // misread (rate 3 → 3 kt).
    if (patch.rate) parts.push('rate=' + patch.rate);
  }
  else if (patch.type === 'altitude') {
    // UNKEYED rate: the altitude parser reads a bare numeric 4th field as
    // ft/min (its own case — never keyed like cfa's rate=).
    parts.push(patch.targetFt);
    if (patch.rate) parts.push(patch.rate);
  }
  else if (patch.type === 'update_speed') {
    // Raw knots (int) — positional 3rd field; the plugin re-asserts the
    // commanded speed every tick (no end command — it drops on the tower
    // handoff or when clear_for_appr supersedes it).
    parts.push(patch.kts);
  }
  return parts;
}

/** Pipe-delimited payload field, NUL-padded to exactly 64 bytes. */
function buildPatchPayload(patch) {
  const field = Buffer.alloc(64);                       // NUL-padded payload field
  Buffer.from(buildPatchParts(patch).join('|'), 'ascii').copy(field, 0);
  return field;
}

/** Complete 72-byte datagram (8 B header + payload) for one patch command. */
function buildPatchFrame(patch) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x43544147, 0);   // 'GATC' magic
  header.writeUInt16LE(1, 4);            // version
  header.writeUInt16LE(0x00E7, 6);       // commandId — the plugin's extended frame
  return Buffer.concat([header, buildPatchPayload(patch)]);
}

module.exports = { buildPatchParts, buildPatchPayload, buildPatchFrame };

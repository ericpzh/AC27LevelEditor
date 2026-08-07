import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { CHANNEL_TYPE_APPROACH } from '../../utils/constants/aviation';
import { MAP_ICON_PATH } from '../../utils/constants';
import {
  ALT_MIN_FT, ALT_MAX_FT, SPEED_MIN_KTS, SPEED_MAX_KTS, FT_PER_GU, pad3,
  buildHeadingPayload, buildAltitudePayload, buildSpeedPayload, buildClearApprPayload,
} from '../../utils/patchCommands';

/**
 * Patch-command composer — command-line style display, mouse-only input.
 * Shown at the bottom of the strips window when a strip is selected. The
 * command is built up step-by-step in ONE line, like a shell prompt:
 *
 *   CSN9355: Fly Heading 090
 *   CSN9355: Clear for Approach
 *
 * At every step ALL the next choices pop up as a horizontal option row
 * flush against the line above it — never a typed answer:
 *   Fly Heading | Clear for Approach | Cancel  (nothing yet)
 *   [slider 001–360] | Send | Cancel    (Fly Heading: drag to set, thumb = current heading)
 *   Send | Cancel                       (one option committed)
 * Send appears as soon as at least one option is committed — or right away
 * inside the heading slider panel (it has its own Send). The panels also
 * carry Add: it chains the current command onto the line (the × beside a
 * chained item removes it again) and returns to the options row, so the
 * next command can be composed — Fly Speed then Fly Altitude go out
 * together. A command type already on the chain BLACKS OUT in the options
 * row (not selectable — one command of each type per line). Cancel
 * abandons the whole line (chain + pending). Every choice is a click; the
 * heading value is dragged. Clicking Send dispatches the whole line IN
 * ORDER, one frame per command, to the AC27Approach plugin via the
 * editor's send-patch-command bridge: an `update_heading` frame
 * (heading-only), an `altitude` frame, an `update_speed` frame (fly-speed
 * override), or a `clear_for_appr` frame (approach handoff). Escape
 * mirrors Cancel (abandons the line).
 *
 * Send/Cancel/Escape keep the strip selected: the composer stays mounted
 * (keyed by callsign) and resets its own line, so the next command can be
 * composed for the same aircraft without re-clicking the strip. Selection
 * is released by clicking the window background.
 *
 * HEADING-ONLY override (2026-08-03, decoupled): the heading frame itself
 * carries no speed — the plugin never touches speed ON THIS FRAME. The
 * aircraft keeps flying its own route at the game's own speed; only the
 * nose heading is overridden (it points at the commanded heading while
 * the game's dynamics keeps moving it). Speed is commandable separately
 * via Fly Speed (2026-08-04) — the `update_speed` frame is the one place
 * the plugin touches speed.
 *
 * SMOOTH TURN (2026-08-03): the update_heading frame carries a rate (°/s
 * of GAME time, TURN_RATE_DEG_S below) — the plugin rotates the nose to
 * the commanded heading at that rate instead of snapping in one frame,
 * scaled with the game's speed multiplier (×2 turns twice as fast per
 * wall-second, same game time) and frozen while the game is paused.
 * Omitted/<=0 rate = instant (backward compatible for scripts).
 *
 * CLEAR FOR APPROACH IS SMOOTH TOO (2026-08-03): the clear_for_appr frame
 * carries the same rate (keyed field rate=N). The plugin arms the turn at
 * the handoff — the nose rotates from where it actually points onto the
 * approach course at that rate (same game-time scaling + pause behavior)
 * instead of snapping when the approach transition lands. The frame's
 * optional approach speed (kts) is still supported for scripted use; the
 * UI's speed control is the separate Fly Speed command (2026-08-04) —
 * cfa's scripted kts stays for the approach speed.
 *
 * FLY ALTITUDE (2026-08-04): a single climb/descend-and-maintain command —
 * picking it opens a slider panel exactly like Fly Heading's: a 1000-ft
 * range from ALT_MIN_FT (1000) up to max(ALT_MAX_FT (9000), the aircraft's
 * CURRENT altitude rounded to the nearest 1000), the thumb defaulting to
 * the rounded current (3300 ft → thumb at 3000) so Send always has a
 * value. The pick sends an `altitude|CS|targetFt|rate` frame (targetFt in
 * feet — the plugin's conversion is ft = position.y × 100/0.3048, 1 GU =
 * 100 m, 15.24 GU = 5000 ft). The plugin moves the aircraft's Y smoothly
 * at rate ft/min of GAME time (ALT_RATE_FPM, the plugin's default too —
 * same game-time scaling + pause behavior as the turn); direction is
 * implicit in the picked target (above the current = climb, below =
 * descend). Only Y is overridden — X/Z, heading, speed and route stay the
 * game's (speed is commandable separately — Fly Speed below).
 *
 * FLY SPEED (2026-08-04): a single fly-speed command — picking it opens a
 * slider panel exactly like Fly Heading's: a 180-240 kt range (step 1),
 * the thumb defaulting to the aircraft's live speed (telemetry
 * airSpeedKnot is raw knots — clamped into range) so Send always has a
 * value. The pick sends an `update_speed|CS|kts` frame (raw knots,
 * int). The plugin re-asserts the commanded speed every tick (the ramp
 * rides the game's own acceleration fields); the override persists —
 * there is no end command — and ends only when clear_for_appr supersedes
 * it or the aircraft is handed to the tower frequency. Speed is
 * ORTHOGONAL to heading/altitude in the mod: an update_heading/altitude
 * command does not clear an active speed override and vice versa — which
 * is exactly why the composer lets you CHAIN them: Add appends the current
 * command to the line (the × beside it removes it again) and returns to
 * the options row for the next one; Send then dispatches the whole chain
 * IN ORDER, one frame per command (the plugin applies each to the same
 * per-aircraft override entry, so heading + speed + altitude all stay
 * active at once).
 *
 * Clear for Approach SUPERSEDES a composed chain of heading/altitude/speed:
 * picking it drops everything from the line (never sent) and removes the
 * Fly Heading / Fly Altitude / Fly Speed options — only the clear_for_appr
 * frame goes out (the plugin's cfa dispatch removes the whole override
 * entry, so a chain around it would be dropped anyway).
 *
 * Heading math (plugin's game-verified convention): heading H → (dx, dy) =
 * (sin H, cos H), +Z = north, +X = east (030 → 0.5, 0.8660; 180 → 0, -1).
 * The slider (001–360) defaults to the aircraft's live noseDirection
 * heading, so Send always has a value even if the user never drags it.
 * Its thumb is an airplane icon (the MAP_ICON_PATH artwork, nose pointing
 * east at rotate 0) rotated by heading − 90°: 360 → nose straight up,
 * 090 → right, 180 → down, 270 → left — same convention as the maps.
 */
// Constants (TURN_RATE_DEG_S, ALT_RATE_FPM, ALT_MIN_FT, ALT_MAX_FT,
// SPEED_MIN_KTS, SPEED_MAX_KTS, FT_PER_GU) and payload builders live in
// src/utils/patchCommands.js — shared with the voice pipeline so composer
// and voice parser never drift.

// Plane-icon thumb for the heading slider — a data-URI SVG reusing the
// MAP_ICON_PATH the maps render. Applied as a -webkit-mask-image on the
// thumb (alpha only), tinted accent via the thumb's background — a data-URI
// SVG is a separate image document, so currentColor would resolve to black
// and can't be used to tint it. The component rotates it via --hdg.
const PLANE_THUMB_URI =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="${MAP_ICON_PATH}" fill="currentColor"/></svg>`
  );

export default function FlightPatchCommandBar({ aircraft, witchMode, commandCapable }) {
  const electronAPI = useElectronAPI();

  // Pending composed option: null = not chosen yet; clearAppr = Clear for
  // Approach. The pending heading/altitude/speed becomes a CHAIN entry via
  // Add — the chain below is what Send dispatches, one frame per entry.
  const [sel, setSel] = useState({ heading: null, clearAppr: false, alt: null, speed: null });
  // Chained commands, in send order: { key, label, payload } — key/type for
  // uniqueness, label for the line, payload is the patch object passed to
  // sendPatchCommand. Add appends the pending command; the × beside a
  // chained item removes it; Send dispatches chain + pending;
  // Cancel/Escape abandon everything.
  const [chain, setChain] = useState([]);
  // Command types already on the chain — their options black out (a type
  // can appear once per line; a duplicate would just be the plugin's
  // last-frame-wins anyway).
  const chainedTypes = useMemo(() => new Set(chain.map((c) => c.key)), [chain]);
  // Pending value pick ('heading' | 'altitude' | 'speed') — the type word
  // is already on the line, the slider panel is showing.
  const [valType, setValType] = useState(null);
  // Option-row x-position (measured at the end of the line).
  const [popupLeft, setPopupLeft] = useState(null);
  const cmdRef = useRef(null);
  const popupRef = useRef(null);

  // Drop the pending (not-yet-chained) command — used after Add and by
  // resetCommand. The chain stays.
  const resetPending = useCallback(() => {
    setSel({ heading: null, clearAppr: false, alt: null, speed: null });
    setValType(null);
  }, []);

  // Clear the composed line (chain + pending). Send/Cancel/Escape keep the
  // strip selected, so this component stays mounted (keyed by callsign) —
  // it must reset its own state instead of relying on an unmount.
  const resetCommand = useCallback(() => {
    resetPending();
    setChain([]);
  }, [resetPending]);

  // Current heading of the selected aircraft, inverted from telemetry
  // noseDirection (Unity +Z north, +X east) — the plugin's dx = sin H,
  // dy = cos H convention, so atan2(x, z) recovers H. Rounded to the
  // nearest degree so the slider thumb lands on a whole 001–360 value.
  const currentHeading = useMemo(() => {
    if (!aircraft?.noseDirection) return 360;
    const h = Math.round((Math.atan2(aircraft.noseDirection.x, aircraft.noseDirection.z) * 180) / Math.PI);
    return ((h % 360) + 360) % 360 || 360;
  }, [aircraft]);

  // Current altitude of the selected aircraft in ft + the rounded 1000-ft
  // position for the altitude slider (3300 → 3000) — derived from UDP
  // telemetry position.y (GU → ft). Null when no telemetry.
  const altitudeBase = useMemo(() => {
    if (!aircraft?.position || typeof aircraft.position.y !== 'number') return null;
    const altFt = aircraft.position.y * FT_PER_GU;
    return {
      altFt: Math.round(altFt),
      current: Math.round(Math.round(altFt) / 1000) * 1000,   // rounded to the nearest 1000 — the slider default
    };
  }, [aircraft]);

  // Current speed of the selected aircraft in knots + the clamped position
  // for the speed slider (180-240) — derived from UDP telemetry
  // airSpeedKnot, which is RAW KNOTS (udp-telemetry.md: "Airspeed in
  // knots" — the /10 in witch-mode stats is RPG stat scaling, not a unit
  // conversion). Rounded to the nearest kt so the thumb lands on a whole
  // value; clamped into the slider range so it always sits on it. Null
  // when no telemetry (option hidden, mirroring altitudeBase).
  const speedBase = useMemo(() => {
    if (!aircraft?.airSpeedKnot) return null;
    const kts = Math.round(aircraft.airSpeedKnot);
    return {
      kts,
      current: Math.min(SPEED_MAX_KTS, Math.max(SPEED_MIN_KTS, kts)),   // clamped — the slider default
    };
  }, [aircraft]);

  // The command-capability gate (BepInEx Debug Mode + AC27Approach plugin
  // DLL) is computed once by the strips window on open and passed down —
  // no per-mount/per-aircraft re-checking here.
  /** All choices for the current step — depends on what is composed. */
  const options = useMemo(() => {
    const list = [];
    // Clear for Approach supersedes a chain: once chosen, all the
    // composition options are gone. Fly Heading / Fly Altitude / Fly Speed
    // can be composed one after another — Add chains them, Send dispatches
    // the whole chain (the gate below only tests the PENDING command, so
    // the options return after every Add). A type already on the chain
    // blacks out — it can appear only once per line.
    if (!sel.clearAppr && sel.heading == null && sel.alt == null && sel.speed == null) {
      list.push({ key: 'heading', label: 'Fly Heading', disabled: chainedTypes.has('heading') });
      // Altitude/speed need live telemetry — hidden while unavailable.
      if (altitudeBase) list.push({ key: 'altitude', label: 'Fly Altitude', disabled: chainedTypes.has('altitude') });
      if (speedBase) list.push({ key: 'speed', label: 'Fly Speed', disabled: chainedTypes.has('speed') });
    }
    if (!sel.clearAppr) list.push({ key: 'clearAppr', label: 'Clear for Approach' });
    // Once at least one option is committed — or a chain exists — Send
    // joins the choices (it dispatches the whole line).
    if (chain.length > 0 || sel.heading != null || sel.alt != null || sel.speed != null || sel.clearAppr) list.push({ key: 'send', label: 'Send' });
    list.push({ key: 'cancel', label: 'Cancel' });
    return list;
  }, [sel, chain, chainedTypes, altitudeBase, speedBase]);

  /** The pending command as a chain entry — { label, payload }, payload
      being the sendPatchCommand patch object. Handles the open-slider case
      (valType): the panel's live value defaults to the aircraft's current
      heading/altitude/speed, so Add/Send always have a value even with no
      drag. Null while nothing is pending (the options row is showing). */
  const buildPending = useCallback(() => {
    if (!aircraft) return null;
    const callSign = aircraft.callSign;
    if (valType === 'heading' || sel.heading != null) {
      const h = sel.heading ?? currentHeading;
      return {
        key: 'heading',
        label: 'Fly Heading ' + pad3(h),
        payload: buildHeadingPayload(callSign, h),   // dx/dy from the plugin's (sin H, cos H) convention
      };
    }
    if (valType === 'altitude' || sel.alt != null) {
      const v = sel.alt ?? (altitudeBase ? altitudeBase.current : null);
      if (v == null) return null;
      return {
        key: 'altitude',
        label: 'Fly Altitude ' + v,
        payload: buildAltitudePayload(callSign, v),   // smooth vertical, ft/min of game time
      };
    }
    if (valType === 'speed' || sel.speed != null) {
      const v = sel.speed ?? (speedBase ? speedBase.current : null);
      if (v == null) return null;
      return {
        key: 'speed',
        label: 'Fly Speed ' + v,
        payload: buildSpeedPayload(callSign, v),   // raw knots — re-asserted every tick (no end command)
      };
    }
    if (sel.clearAppr) {
      return {
        key: 'clearAppr',
        label: 'Clear for Approach',
        payload: buildClearApprPayload(callSign),   // smooth handoff turn, °/s of game time
      };
    }
    return null;
  }, [aircraft, valType, sel, currentHeading, altitudeBase, speedBase]);

  /** Chain the pending command onto the line and return to the options
      row, so the next command can be composed. Send dispatches the whole
      chain in order. No-op while nothing is pending. */
  const chainAdd = useCallback(() => {
    const pending = buildPending();
    if (!pending) return;
    setChain((c) => [...c, pending]);
    resetPending();
  }, [buildPending, resetPending]);

  /** Dispatch the whole line IN ORDER — chain first, then the pending —
      one frame per command, awaiting each, then reset (the strip stays
      selected). The plugin applies each frame to the same per-aircraft
      override entry, so chained speed/altitude/heading all stay active at
      once. Clear for Approach is exclusive: picking it wiped the chain, so
      only the cfa frame goes out. */
  const sendPatch = useCallback(async () => {
    if (!aircraft || !electronAPI.sendPatchCommand) return;
    const pending = buildPending();
    const frames = [...chain, ...(pending ? [pending] : [])];
    for (const f of frames) {
      await electronAPI.sendPatchCommand(f.payload);
    }
    resetCommand();
  }, [aircraft, electronAPI, chain, buildPending, resetCommand]);

  /** Accept a choice: Cancel abandons; type word → heading/altitude/speed
      slider panel; Send → dispatch the composed command. */
  const select = useCallback((key) => {
    if (key === 'cancel') { resetCommand(); return; }   // abandon the whole command — keep the strip selected
    if (key === 'send') { sendPatch(); return; }
    if (key === 'heading' || key === 'altitude' || key === 'speed') {
      // Blacked-out options are disabled buttons (no clicks), but guard
      // anyway — a type already on the chain can't be composed again.
      if (chainedTypes.has(key)) return;
      setValType(key);
      return;
    }
    // Clear for Approach supersedes a composed chain (dropped — never
    // sent).
    if (key === 'clearAppr') {
      setChain([]);
      setSel((s) => ({ ...s, clearAppr: true, heading: null, alt: null, speed: null }));
      return;
    }
  }, [sendPatch, resetCommand, chainedTypes]);

  // Escape mirrors Cancel: abandons the composed line (the strip stays
  // selected). The heading/altitude steps are pending-value states with
  // their own Send/Cancel — Escape from them abandons like Cancel.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') resetCommand();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resetCommand]);

  // Anchor the option row at the end of the line; flip to the right edge
  // when it would overflow the window. The row renders from the first pass
  // (at left 0) so its ref is measurable — the layout effect runs before
  // paint and snaps it into place without flicker.
  useLayoutEffect(() => {
    if (!cmdRef.current || !popupRef.current) return;
    const x = cmdRef.current.offsetLeft + cmdRef.current.offsetWidth + 6;
    const w = popupRef.current.offsetWidth;
    const maxX = window.innerWidth - 8;
    setPopupLeft(x + w > maxX ? maxX - w : x);
  }, [options, sel, valType, chain]);

  // Approach-only composer: the Fly Heading / Clear for Approach patches
  // target aircraft on the approach radio channel (controlSeat=5, the strip
  // view's APPR segment classification from UDP). Aircraft on any other
  // channel — including final approach under tower (seat 3) — don't get
  // the popup. Live seat changes (handoff to tower) hide it automatically
  // since the aircraft prop refreshes every 200ms from telemetry. It also
  // stays closed unless command capability is on — BepInEx Debug Mode AND
  // the AC27Approach plugin DLL under BepInEx/plugins (the plugin the patch
  // frames are relayed to only exists then).
  if (!aircraft || witchMode || aircraft.controlSeat !== CHANNEL_TYPE_APPROACH || commandCapable !== true) return null;

  // Live slider values: the pending pick's current value, defaulting to
  // the aircraft's live heading/altitude/speed while its slider is open.
  const hdg = sel.heading ?? currentHeading;
  const alt = sel.alt ?? (altitudeBase ? altitudeBase.current : null);
  const spd = sel.speed ?? (speedBase ? speedBase.current : null);

  // The command text being built: 'Fly Heading 090', 'Fly Altitude 5000',
  // 'Fly Speed 180' or 'Clear for Approach' — the pending command's label.
  // While a slider is open the live value (slider position, defaulting to
  // the aircraft's current heading/altitude/speed) sits on the line. The
  // chained commands (from Add) render BEFORE it, each with a × to remove.
  const pending = buildPending();
  const text = pending ? pending.label : '';

  return (
    <div className="flight-strips-command-wrap">
      {/* All choices for the current step — horizontal option row flush
          above the line; every choice is a click. Fly Heading / Fly
          Altitude / Fly Speed swap the row for a slider panel (thumb at
          the aircraft's current heading/altitude/speed) with Send / Add
          (chains the command onto the line for the next one) / Cancel. */}
      {valType === 'heading' ? (
        <div className="fcc-suggest fcc-heading-row" style={{ left: popupLeft ?? 0 }} ref={popupRef}>
          <input
            className="fcc-heading-slider fcc-plane-thumb"
            type="range"
            min={1}
            max={360}
            value={hdg}
            style={{ '--hdg': `${hdg - 90}deg`, '--thumb-plane': `url("${PLANE_THUMB_URI}")` }}
            onChange={(ev) => setSel((s) => ({ ...s, heading: +ev.target.value }))}
          />
          <span className="fcc-heading-readout">{pad3(hdg)}</span>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={sendPatch}>Send</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={chainAdd}>Add</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item fcc-suggest-cancel" onClick={resetCommand}>Cancel</button>
        </div>
      ) : valType === 'altitude' && altitudeBase ? (
        // 1000-ft slider from ALT_MIN_FT up to max(ALT_MAX_FT, the rounded
        // current) — the rounded current always sits on it (the default
        // thumb); only cruising aircraft above 9000 ft extend the range.
        <div className="fcc-suggest fcc-heading-row" style={{ left: popupLeft ?? 0 }} ref={popupRef}>
          <input
            className="fcc-heading-slider"
            type="range"
            min={ALT_MIN_FT}
            max={Math.max(ALT_MAX_FT, altitudeBase.current)}
            step={1000}
            value={alt}
            onChange={(ev) => setSel((s) => ({ ...s, alt: +ev.target.value }))}
          />
          <span className="fcc-heading-readout">{alt}</span>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={sendPatch}>Send</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={chainAdd}>Add</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item fcc-suggest-cancel" onClick={resetCommand}>Cancel</button>
        </div>
      ) : valType === 'speed' && speedBase ? (
        // 180-240 kt slider (step 1) — the live speed always sits on it
        // (the default thumb); reuses .fcc-heading-slider like the altitude
        // panel. The clamp means an aircraft faster than 240 or slower than
        // 180 still lands on the slider.
        <div className="fcc-suggest fcc-heading-row" style={{ left: popupLeft ?? 0 }} ref={popupRef}>
          <input
            className="fcc-heading-slider"
            type="range"
            min={SPEED_MIN_KTS}
            max={SPEED_MAX_KTS}
            step={1}
            value={spd}
            onChange={(ev) => setSel((s) => ({ ...s, speed: +ev.target.value }))}
          />
          <span className="fcc-heading-readout">{spd}</span>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={sendPatch}>Send</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={chainAdd}>Add</button>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item fcc-suggest-cancel" onClick={resetCommand}>Cancel</button>
        </div>
      ) : options.length > 0 && (
        <div className="fcc-suggest" style={{ left: popupLeft ?? 0 }} ref={popupRef}>
          {options.map((o, i) => (
            <React.Fragment key={o.key}>
              {i > 0 && <span className="fcc-suggest-sep">{'|'}</span>}
              <button
                className={'fcc-suggest-item' + (o.key === 'cancel' ? ' fcc-suggest-cancel' : '')}
                onClick={() => select(o.key)}
                disabled={o.disabled}
              >
                {o.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {/* The command line: CSN9355: Fly Heading 090, Fly Speed 200 … —
          chained commands show with a × to remove, then the pending
          (being dragged) command. */}
      <div className="flight-strips-command-bar cmd-bar-visible">
        <span className="cmd-bar-callsign">{aircraft.callSign}</span>
        <span className="cmd-bar-sep">:</span>
        <span className="fcc-cmd" ref={cmdRef}>
          {chain.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && ', '}
              <span className="fcc-chain-item">
                {c.label}
                <button
                  className="fcc-chain-remove"
                  title="Remove from chain"
                  onClick={() => setChain((cs) => cs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            </React.Fragment>
          ))}
          {chain.length > 0 && text && ', '}
          {text}
        </span>
      </div>
    </div>
  );
}

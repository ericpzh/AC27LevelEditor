import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { CHANNEL_TYPE_APPROACH } from '../../utils/constants/aviation';

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
 * inside the heading slider panel (it has its own Send). Cancel abandons
 * the whole command. Every choice is a click; the heading value is
 * dragged. Clicking Send sends ONE frame to the AC27Appoarch
 * plugin via the editor's send-patch-command bridge: an `update_heading`
 * frame (heading-only) or a `clear_for_appr` frame (approach handoff).
 * Escape mirrors Cancel (abandons the line).
 *
 * Send/Cancel/Escape keep the strip selected: the composer stays mounted
 * (keyed by callsign) and resets its own line, so the next command can be
 * composed for the same aircraft without re-clicking the strip. Selection
 * is released by clicking the window background.
 *
 * HEADING-ONLY override (2026-08-03, decoupled): speed was removed from
 * the composer — the plugin never touches speed. The aircraft keeps
 * flying its own route at the game's own speed; only the nose heading is
 * overridden (it points at the commanded heading while the game's
 * dynamics keeps moving it).
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
 * UI no longer exposes it.
 *
 * Clear for Approach SUPERSEDES a composed heading: picking it drops any
 * heading from the line (it is never sent) and removes the Fly Heading
 * option — only the clear_for_appr frame goes out.
 *
 * Heading math (plugin's game-verified convention): heading H → (dx, dy) =
 * (sin H, cos H), +Z = north, +X = east (030 → 0.5, 0.8660; 180 → 0, -1).
 * The slider (001–360) defaults to the aircraft's live noseDirection
 * heading, so Send always has a value even if the user never drags it.
 */
const TURN_RATE_DEG_S = 3;   // IFR standard-rate turn — the plugin rotates the nose at this °/s of GAME time
const pad3 = (n) => String(n).padStart(3, '0');

export default function FlightPatchCommandBar({ aircraft, witchMode }) {
  const electronAPI = useElectronAPI();

  // Composed options: null = not chosen yet; clearAppr = Clear for Approach.
  const [sel, setSel] = useState({ heading: null, clearAppr: false });
  // Pending value pick ('heading') — the type word is already on the line,
  // the value list is showing.
  const [valType, setValType] = useState(null);
  // Option-row x-position (measured at the end of the line).
  const [popupLeft, setPopupLeft] = useState(null);
  const cmdRef = useRef(null);
  const popupRef = useRef(null);

  // Clear the composed line. Send/Cancel/Escape keep the strip selected, so
  // this component stays mounted (keyed by callsign) — it must reset its own
  // state instead of relying on an unmount.
  const resetCommand = useCallback(() => {
    setSel({ heading: null, clearAppr: false });
    setValType(null);
  }, []);

  // Current heading of the selected aircraft, inverted from telemetry
  // noseDirection (Unity +Z north, +X east) — the plugin's dx = sin H,
  // dy = cos H convention, so atan2(x, z) recovers H. Rounded to the
  // nearest degree so the slider thumb lands on a whole 001–360 value.
  const currentHeading = useMemo(() => {
    if (!aircraft?.noseDirection) return 360;
    const h = Math.round((Math.atan2(aircraft.noseDirection.x, aircraft.noseDirection.z) * 180) / Math.PI);
    return ((h % 360) + 360) % 360 || 360;
  }, [aircraft]);

  // BepInEx Debug Mode gate: patch frames are relayed to the AC27Appoarch
  // plugin over UDP, which only exists while BepInEx is installed — the
  // composer stays closed otherwise. Re-checked on mount, on aircraft
  // change, and on window focus (Debug Mode can be toggled in the browser
  // window while this window stays open). While unknown the composer is
  // hidden, so the check result never flashes.
  const [bepInExActive, setBepInExActive] = useState(null);
  useEffect(() => {
    let alive = true;
    const check = () => {
      if (!electronAPI.checkBepInEx) { setBepInExActive(false); return; }
      electronAPI.checkBepInEx()
        .then((r) => { if (alive) setBepInExActive(!!(r && r.installed)); })
        .catch(() => { if (alive) setBepInExActive(false); });
    };
    check();
    window.addEventListener('focus', check);
    return () => { alive = false; window.removeEventListener('focus', check); };
  }, [electronAPI, aircraft && aircraft.callSign]);

  /** All choices for the current step — depends on what is composed. */
  const options = useMemo(() => {
    const list = [];
    // Clear for Approach supersedes heading: once chosen, the heading
    // option is gone (it would be ignored anyway).
    if (!sel.clearAppr && sel.heading == null) list.push({ key: 'heading', label: 'Fly Heading' });
    if (!sel.clearAppr) list.push({ key: 'clearAppr', label: 'Clear for Approach' });
    // Once at least one option is committed, Send joins the choices.
    if (sel.heading != null || sel.clearAppr) list.push({ key: 'send', label: 'Send' });
    list.push({ key: 'cancel', label: 'Cancel' });
    return list;
  }, [sel]);

  /** Compose + send ONE frame, then reset the line (the strip stays
      selected). Clear for Approach supersedes any heading; heading-only
      update_heading frame (no speed — the plugin never touches it). */
  const sendPatch = useCallback(() => {
    if (!aircraft || !electronAPI.sendPatchCommand) return;
    if (sel.clearAppr) {
      electronAPI.sendPatchCommand({
        type: 'clear_for_appr',
        callSign: aircraft.callSign,
        rate: TURN_RATE_DEG_S,   // smooth handoff turn — the plugin rotates the nose onto the approach course at this °/s of game time
      });
      resetCommand();
      return;
    }
    // Send is available in the slider panel even with no drag — the slider
    // defaults to the aircraft's live heading (currentHeading).
    const h = sel.heading ?? currentHeading;
    const rad = (h * Math.PI) / 180;
    electronAPI.sendPatchCommand({
      type: 'update_heading',
      callSign: aircraft.callSign,
      dx: +Math.sin(rad).toFixed(4),                       // +X = east
      dy: +Math.cos(rad).toFixed(4),                       // +Z = north
      rate: TURN_RATE_DEG_S,                               // smooth turn, °/s of game time
    });
    resetCommand();
  }, [aircraft, currentHeading, electronAPI, sel, resetCommand]);

  /** Accept a choice: Cancel abandons; type word → heading slider panel;
      Send → dispatch the composed command. */
  const select = useCallback((key) => {
    if (key === 'cancel') { resetCommand(); return; }   // abandon the whole command — keep the strip selected
    if (key === 'send') { sendPatch(); return; }
    if (key === 'heading') { setValType(key); return; }
    // Clear for Approach supersedes a composed heading (dropped — never sent).
    if (key === 'clearAppr') { setSel((s) => ({ ...s, clearAppr: true, heading: null })); return; }
  }, [sendPatch, resetCommand]);

  // Escape mirrors Cancel: abandons the composed line (the strip stays
  // selected). The heading step is the only pending-value state now, and
  // it carries its own Send/Cancel — Escape from it abandons like Cancel.
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
  }, [options, sel, valType]);

  // Approach-only composer: the Fly Heading / Clear for Approach patches
  // target aircraft on the approach radio channel (controlSeat=5, the strip
  // view's APPR segment classification from UDP). Aircraft on any other
  // channel — including final approach under tower (seat 3) — don't get
  // the popup. Live seat changes (handoff to tower) hide it automatically
  // since the aircraft prop refreshes every 200ms from telemetry. It also
  // stays closed unless BepInEx Debug Mode is active (the plugin the patch
  // frames are relayed to only exists then).
  if (!aircraft || witchMode || aircraft.controlSeat !== CHANNEL_TYPE_APPROACH || bepInExActive !== true) return null;

  // The command text being built: 'Fly Heading 090' or
  // 'Clear for Approach'. While the slider is open the live value (slider
  // position, defaulting to the aircraft's current heading) sits on the
  // line.
  const hdg = sel.heading ?? currentHeading;
  const parts = [];
  if (valType === 'heading') parts.push('Fly Heading ' + pad3(hdg));
  else if (sel.heading != null && !sel.clearAppr) parts.push('Fly Heading ' + pad3(sel.heading));
  if (sel.clearAppr) parts.push('Clear for Approach');
  const text = parts.join(', ');

  return (
    <div className="flight-strips-command-wrap">
      {/* All choices for the current step — horizontal option row flush
          above the line; every choice is a click. Fly Heading swaps the
          row for a 001–360 slider (thumb at the aircraft's current
          heading) with Send / Cancel. */}
      {valType === 'heading' ? (
        <div className="fcc-suggest fcc-heading-row" style={{ left: popupLeft ?? 0 }} ref={popupRef}>
          <input
            className="fcc-heading-slider"
            type="range"
            min={1}
            max={360}
            value={hdg}
            onChange={(ev) => setSel((s) => ({ ...s, heading: +ev.target.value }))}
          />
          <span className="fcc-heading-readout">{pad3(hdg)}</span>
          <span className="fcc-suggest-sep">{'|'}</span>
          <button className="fcc-suggest-item" onClick={sendPatch}>Send</button>
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
              >
                {o.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {/* The command line: CSN9355: Fly Heading 090 */}
      <div className="flight-strips-command-bar cmd-bar-visible">
        <span className="cmd-bar-callsign">{aircraft.callSign}</span>
        <span className="cmd-bar-sep">:</span>
        <span className="fcc-cmd" ref={cmdRef}>{text}</span>
      </div>
    </div>
  );
}

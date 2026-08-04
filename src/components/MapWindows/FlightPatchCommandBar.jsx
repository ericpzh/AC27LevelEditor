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
 *   030 | 060 | … | 360 | Cancel        (picking the pending value)
 *   Send | Cancel                       (one option committed)
 * Send appears as soon as at least one option is committed. Cancel steps
 * back from a value list, otherwise abandons the whole command. Every
 * choice is a click; clicking Send sends ONE frame to the AC27Appoarch
 * plugin via the editor's send-patch-command bridge: an `update_heading`
 * frame (heading-only) or a `clear_for_appr` frame (approach handoff).
 * Escape mirrors Cancel (pending value pick → previous menu; otherwise
 * abandon the line).
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
 * Clear for Approach SUPERSEDES a composed heading: picking it drops any
 * heading from the line (it is never sent) and removes the Fly Heading
 * option — only the clear_for_appr frame goes out. The plugin retains
 * its optional approach-speed support for scripted use; the UI no longer
 * exposes it.
 *
 * Heading math (plugin's game-verified convention): heading H → (dx, dy) =
 * (sin H, cos H), +Z = north, +X = east (030 → 0.5, 0.8660; 180 → 0, -1).
 * A heading is always chosen before Send (the noseDirection fallback died
 * with the speed option).
 */
const HEADINGS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];
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
    if (valType) {
      return [
        ...HEADINGS.map((v) => ({ key: v, label: pad3(v) })),
        { key: 'cancel', label: 'Cancel' },
      ];
    }
    const list = [];
    // Clear for Approach supersedes heading: once chosen, the heading
    // option is gone (it would be ignored anyway).
    if (!sel.clearAppr && sel.heading == null) list.push({ key: 'heading', label: 'Fly Heading' });
    if (!sel.clearAppr) list.push({ key: 'clearAppr', label: 'Clear for Approach' });
    // Once at least one option is committed, Send joins the choices.
    if (sel.heading != null || sel.clearAppr) list.push({ key: 'send', label: 'Send' });
    list.push({ key: 'cancel', label: 'Cancel' });
    return list;
  }, [valType, sel]);

  /** Compose + send ONE frame, then reset the line (the strip stays
      selected). Clear for Approach supersedes any heading; heading-only
      update_heading frame (no speed — the plugin never touches it). */
  const sendPatch = useCallback(() => {
    if (!aircraft || !electronAPI.sendPatchCommand) return;
    if (sel.clearAppr) {
      electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign: aircraft.callSign });
      resetCommand();
      return;
    }
    // Send only appears once a heading is committed (clearAppr returned
    // above), so a heading is always present here.
    if (sel.heading == null) return;
    const rad = (sel.heading * Math.PI) / 180;
    electronAPI.sendPatchCommand({
      type: 'update_heading',
      callSign: aircraft.callSign,
      dx: +Math.sin(rad).toFixed(4),                       // +X = east
      dy: +Math.cos(rad).toFixed(4),                       // +Z = north
    });
    resetCommand();
  }, [aircraft, electronAPI, sel, resetCommand]);

  /** Accept a choice: Cancel steps back / abandons; type word → value list;
      value → commit to the line; Send → dispatch the composed command. */
  const select = useCallback((key) => {
    if (key === 'cancel') {
      if (valType) setValType(null);   // back to the previous menu
      else resetCommand();             // abandon the whole command — keep the strip selected
      return;
    }
    if (key === 'send') { sendPatch(); return; }
    if (key === 'heading') { setValType(key); return; }
    // Clear for Approach supersedes a composed heading (dropped — never sent).
    if (key === 'clearAppr') { setSel((s) => ({ ...s, clearAppr: true, heading: null })); return; }
    // Numeric value for the pending type.
    setSel((s) => ({ ...s, [valType]: key }));
    setValType(null);
  }, [valType, sendPatch, resetCommand]);

  // Escape mirrors Cancel: pending value pick → previous menu; else reset
  // the line (the strip stays selected).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (valType) setValType(null);
        else resetCommand();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [valType, resetCommand]);

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
  // 'Clear for Approach'. The pending type word sits on the line while
  // its value list shows.
  const parts = [];
  if (sel.heading != null && !sel.clearAppr) parts.push('Fly Heading ' + pad3(sel.heading));
  else if (valType === 'heading') parts.push('Fly Heading');
  if (sel.clearAppr) parts.push('Clear for Approach');
  const text = parts.join(', ');

  return (
    <div className="flight-strips-command-wrap">
      {/* All choices for the current step — horizontal option row flush
          above the line; every choice is a click */}
      {options.length > 0 && (
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

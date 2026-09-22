using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using ContextCross.Aircrafts;
using ContextCross.Dynamics;
using ContextCross.Dynamics.States;
using ContextCross.Services;
using HarmonyLib;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using UnityEngine;

namespace AC27Approach;

public static class Patches
{
    // ── Design A: overwrite pose after the game's tick (report §4.4) ────
    public static void AircraftStepPostfix(Aircraft __instance)
        => OverrideController.OnAircraftStep(__instance);

    // ── Design A v2: view-level direction hijack ────────────────────────
    // Live: the commanded heading did NOT stick — a second patch's
    // before-state showed the game's original heading, meaning the game's own
    // systems re-assert the model direction after our postfix (or the visual
    // reads a channel we don't write). The view's direction sync is the LAST
    // writer of the visible orientation, so feed the override's commanded
    // heading there: whenever Aircraft3D syncs its direction, use OUR heading.
    // (POSITION is NOT hijacked —  the override is
    // heading-only; the game keeps full control of position and speed.)
    public static void Aircraft3DSetDirectionPrefix(Aircraft3D __instance, ref Vector3 direction)
    {
        if (__instance.Source == null) return;
        if (!OverrideController.IsOverridden(__instance.Source)) return;
        // `direction` passes through CommandedDirection so the cfa-turn mode
        // can stash the game's intended heading if the 3D sync happens to
        // carry it (the exact-match filter keeps our own write-back out).
        var d = OverrideController.CommandedDirection(__instance.Source, direction);
        if (d.sqrMagnitude > 1e-6f) direction = d;
    }

    // ── Design A v4: view-level ALTITUDE hijack  ─────────────
    // The 3D view syncs the visible transform from the model's reactive
    // properties via SetWorldPosition — the LAST writer of the visible
    // position (same class + pattern as the SetDirection hijack). Only Y is
    // hijacked: the altitude override commands the aircraft's vertical
    // position; X/Z stay 100% the game's.
    public static void Aircraft3DSetWorldPositionPrefix(Aircraft3D __instance, ref Vector3 position)
    {
        if (__instance.Source == null) return;
        if (!OverrideController.IsOverridden(__instance.Source)) return;
        var y = OverrideController.CommandedAltitudeY(__instance.Source);
        if (y > 0f) position.y = y;
    }

    // ── Design A v3: channel lock — the model's direction write entry ────
    // `_direction` is private to Aircraft, so `set_Direction` (plus Step's
    // internal write, which the Step postfix already overwrites) is the ONLY
    // direction write entry point. While overridden, ANY game direction write
    // (the dynamics' own path-tangent heading inside Step, a later-phase
    // sync) carries the commanded heading instead. Idempotent with our own
    // postfix writes — they read the same commanded value. (Position is NOT
    // locked — game-owned.)
    public static void SetDirectionPrefix(Aircraft __instance, ref Vector3 value)
    {
        if (!OverrideController.IsOverridden(__instance)) return;
        // cfa-turn mode: this prefix sees the game's TRUE
        // path-tangent heading (the only place it is visible — everything
        // else reads the substituted value) — pass it through so
        // CommandedDirection can stash it as the rotation target.
        var d = OverrideController.CommandedDirection(__instance, value);
        if (d.sqrMagnitude > 1e-6f) value = d;
    }

    // ── UDP Mechanism A: `!`-prefixed callsigns are patch frames (§5.4) ─
    // Runtime-verified: `Execute(in UdpCommand)` NREs inside the
    // Harmony trampoline — the `in`-byref binding is broken in this IL2CPP
    // context ("applied" at load, crashes per call). `ExecuteSelectAircraft(string)`
    // is called for every successfully-parsed SelectAircraft command and has a
    // plain string param — always binds, so it is the Mechanism A hook.
    public static bool UdpExecuteSelectAircraftPrefix(string callSign)
    {
        try
        {
            if (string.IsNullOrEmpty(callSign) || callSign[0] != '!') return true;   // normal select → game as usual
            if (callSign.StartsWith("!5:", StringComparison.Ordinal))
            {
                var cs = callSign.Substring(3);
                Plugin.LogMsg($"patch: clear_for_appr → {cs} (Mechanism A)");
                OverrideController.PatchAircraft("clear_for_appr", cs);
            }
            return false;                                                // consumed — the game's selection path never runs
        }
        catch (Exception ex)
        {
            // Never let a plugin failure propagate into the game's UDP tick —
            // an uncaught throw here (e.g. a stale route-service cache across a
            // level restart) would kill the command service's FixedTick.
            Plugin.LogMsg($"patch: clear_for_appr → {(string.IsNullOrEmpty(callSign) ? "<null>" : callSign)} FAILED: {ex.GetType().Name}: {ex.Message} (Mechanism A)");
            return false;                                                // still consumed — the game's selection path never runs
        }
    }

    // ── Command dispatch (plugin-owned socket) ──────────────────────────
    // The AC27 shipping build has no AircraftUdpCommandService, so the plugin
    // binds 127.0.0.1:20267 itself (CommandReceiver) and hands each datagram
    // here. Frame contract: 8 B header (magic u32 / version u16 / commandId u16)
    // + payload; patch frames carry id 0x00E7 with a payload NUL-padded to
    // exactly 64 bytes (72 B total). Layout lives in TelemetryProtocol.
    private static bool _diagHeader, _diagLegacyKts, _diagFocus, _diagFocusSvc;

    private static void LogOnce(ref bool flag, string msg)
    {
        if (!flag) { flag = true; Plugin.LogMsg(msg); }
    }

    /// <summary>Validate one datagram from the command socket and run its patch command.</summary>
    public static void DispatchDatagram(byte[] buf)
    {
        if (buf == null || buf.Length < TelemetryProtocol.CmdHeaderSize) return;

        if (BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(TelemetryProtocol.CMagic, 4)) != TelemetryProtocol.Magic)
        {
            LogOnce(ref _diagHeader, $"udp: bad magic — head {BitConverter.ToString(buf, 0, Math.Min(8, buf.Length))}");
            return;
        }
        if (BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(TelemetryProtocol.CVersion, 2)) != TelemetryProtocol.CmdVersion)
        {
            LogOnce(ref _diagHeader, $"udp: version mismatch — head {BitConverter.ToString(buf, 0, Math.Min(8, buf.Length))}");
            return;
        }
        ushort commandId = BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(TelemetryProtocol.CCommandId, 2));

        // SelectAircraft (id 1) from the editor. `!5:<CS>` is the legacy
        // clear_for_appr frame; any other callsign is the click-to-focus frame
        // (radar/strips selection) — focus the aircraft in-game via the game's
        // own AircraftFocusService, since the native service that used to do it
        // is gone from this build.
        if (commandId == TelemetryProtocol.SelectAircraftCommandId)
        {
            int limit = Math.Min(buf.Length, TelemetryProtocol.CPayload + 64);
            int e = Array.IndexOf(buf, (byte)0, TelemetryProtocol.CPayload, limit - TelemetryProtocol.CPayload);
            if (e < 0) e = limit;
            string cs = Encoding.ASCII.GetString(buf, TelemetryProtocol.CPayload, e - TelemetryProtocol.CPayload);
            if (string.IsNullOrEmpty(cs)) return;                      // selection cleared — nothing to focus
            if (cs.StartsWith("!5:", StringComparison.Ordinal))
            {
                var target = cs.Substring(3);
                try
                {
                    bool ok = OverrideController.PatchAircraft("clear_for_appr", target);
                    Plugin.LogMsg($"patch: clear_for_appr → {target}: {(ok ? "applied" : "NOT FOUND / not on STAR")} (SelectAircraft frame)");
                }
                catch (Exception ex) { Plugin.LogMsg($"patch: clear_for_appr → {target} FAILED: {ex.GetType().Name}: {ex.Message}"); }
            }
            else
            {
                FocusAircraft(cs);
            }
            return;
        }

        if (commandId != TelemetryProtocol.PatchCommandId)
            return;   // the game's own SelectAircraft frames — expected, silent

        if (buf.Length < TelemetryProtocol.CmdHeaderSize + TelemetryProtocol.PatchPayloadFieldSize) return;
        int plen = TelemetryProtocol.PatchPayloadFieldSize;
        int end = Array.IndexOf(buf, (byte)0, TelemetryProtocol.CPayload, plen);
        if (end < 0) end = TelemetryProtocol.CPayload + plen;
        var parts = Encoding.ASCII.GetString(buf, TelemetryProtocol.CPayload, end - TelemetryProtocol.CPayload).Split('|');
        if (parts.Length < 2) return;

        switch (parts[0])
        {
            case "update_heading":
            case "update_position":   // legacy alias — pre-decouple name, kts ignored
                // Canonical: update_heading|CS|dx|dy[|rate] — HEADING-ONLY
                // override (the game keeps full control of position and
                // speed). 5th field = smooth-turn rate in °/GAME-second
                // the nose rotates toward the heading at that
                // rate, scaled by the game's speed multiplier and frozen
                // while paused (see OverrideController.OnAircraftStep);
                // omitted or <= 0 = INSTANT — the pre-smoothing behavior.
                // Legacy update_position|CS|dx|dy[|kts] parses the same way;
                // its kts field stays validated-but-ignored — it is NEVER a
                // rate. A non-numeric legacy field still rejects. (The 5th
                // field is parsed inside the if-body — an `out var` in the
                // `||` guard would be unassigned when parts.Length == 4.)
                if ((parts.Length == 4 || parts.Length == 5)
                    && float.TryParse(parts[2], out var dx) && float.TryParse(parts[3], out var dy)
                    && (parts.Length == 4 || float.TryParse(parts[4], out _)))
                {
                    if (parts[0] == "update_position")
                        LogOnce(ref _diagLegacyKts, "patch: legacy update_position frame treated as update_heading (kts ignored — heading-only)");
                    // Rate only from an update_heading frame. NaN/Infinity
                    // parse fine: NaN > 0f is false → instant (safe);
                    // Infinity converges in one tick (≈ instant).
                    float rate = 0f;
                    if (parts.Length == 5 && parts[0] == "update_heading"
                        && float.TryParse(parts[4], out var fifth) && fifth > 0f)
                        rate = fifth;
                    try
                    {
                        bool ok = OverrideController.PatchAircraft("update_heading", parts[1],
                            new UnityEngine.Vector3(dx, 0f, dy), turnRateDeg: rate);
                        Plugin.LogMsg($"patch: update_heading → {parts[1]} ({dx},{dy}){(rate > 0f ? $" rate {rate:F0}°/s" : "")}: {(ok ? "applied" : "NOT FOUND")} (Mechanism B)");
                    }
                    catch (Exception ex) { Plugin.LogMsg($"patch: update_heading → {parts[1]} FAILED: {ex.GetType().Name}: {ex.Message}"); }
                }
                break;
            case "altitude":
                // altitude|CS|targetFt[|rateFpm] — climb/descend-and-maintain
                // override: forces the aircraft's Y toward
                // targetFt (feet) at rateFpm ft/GAME-minute (smooth — the same
                // GameDt-scaled fixed-tick interpolation as the heading turn,
                // frozen while paused); rateFpm omitted or <= 0 = the plugin
                // default (DefaultAltRateFpm, 1000 ft/min). targetFt <= 0
                // (incl. NaN) is invalid → patchAltitude rejects with a logged
                // REJECTED line. (The optional field is parsed inside the
                // if-body — an `out var` in the `||` guard would be unassigned
                // when parts.Length == 3.)
                if ((parts.Length == 3 || parts.Length == 4)
                    && float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var targetFt)
                    && (parts.Length == 3 || float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out _)))
                {
                    float rateFpm = 0f;
                    if (parts.Length == 4 && float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var r4) && r4 > 0f)
                        rateFpm = r4;
                    try
                    {
                        bool ok = OverrideController.PatchAircraft("altitude", parts[1],
                            altTargetFt: targetFt, altRateFpm: rateFpm);
                        Plugin.LogMsg($"patch: altitude → {parts[1]} {targetFt:F0} ft{(rateFpm > 0f ? $" rate {rateFpm:F0} ft/min" : "")}: {(ok ? "applied" : "NOT FOUND / invalid target")} (Mechanism B)");
                    }
                    catch (Exception ex) { Plugin.LogMsg($"patch: altitude → {parts[1]} FAILED: {ex.GetType().Name}: {ex.Message}"); }
                }
                break;
            case "update_speed":
                // update_speed|CS|kts[|accel=N] — fly-speed override
                // (v12 accel=N): kts = raw knots (int;
                // the editor slider range 180-240). POSITIONAL parse — the
                // 3rd field is ALWAYS kts (unlike cfa's keyed scan, where any
                // bare numeric field is kts); the optional 4th field MUST be
                // the keyed `accel=N` (the ramp rate in kt of GAME time per
                // second; omitted = the plugin default 5 kt/s). A bare
                // numeric 4th field is REJECTED — the kts contract is the 3rd
                // field only. kts <= 0 disarms the override defensively (the
                // UI never sends it — patchSpeed logs the drop). The vars are
                // declared before the `if`: an `out var` in the `||` guard
                // would be unassigned when the length check short-circuits
                // (the altitude case's comment at 298-300 documents the trap).
                {
                    float kts = 0f, accel = 0f;
                    if ((parts.Length == 3 || parts.Length == 4)
                        && float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out kts)
                        && (parts.Length == 3
                            || (parts[3].StartsWith("accel=", StringComparison.Ordinal)
                                && float.TryParse(parts[3].Substring(6), NumberStyles.Float, CultureInfo.InvariantCulture, out accel)
                                && accel > 0f)))
                    {
                        try
                        {
                            bool ok = OverrideController.PatchAircraft("update_speed", parts[1],
                                speedKnots: kts, speedAccelKtsPerSec: accel);
                            Plugin.LogMsg($"patch: update_speed → {parts[1]} {kts:F0} kt{(accel > 0f ? $" accel {accel:F0} kt/s" : "")}: {(ok ? "applied" : "NOT FOUND")} (Mechanism B)");
                        }
                        catch (Exception ex) { Plugin.LogMsg($"patch: update_speed → {parts[1]} FAILED: {ex.GetType().Name}: {ex.Message}"); }
                    }
                }
                break;
            case "clear_for_appr":
                // clear_for_appr|CS[|kts][|appr][|native=0][|rate=N][|accel=N] —
                // kts = approach speed in raw knots (omitted/0 = the ACL
                // default 240 — always written); appr = named procedure
                // (omitted = nearest APP route); native=0 skips
                // CommandContinueApproach — its deferred flow restores the
                // aircraft's runtime data ("Dynamics: restore runtime data:
                // FlyApproaching"), the suspected revert back to the STAR;
                // rate=N is the bounded de-snap's rotation rate — the
                // pre-capture nose rotation toward the IAF at that many
                // °/GAME-second (v6; the frame's rate, or the
                // plugin's 3°/s default; the v5 note "inert — no tangent snap"
                // was superseded by the de-snap); accel=N (v12)
                // is the pre-capture speed-lift ramp rate in kt of GAME time
                // per second (omitted = the plugin default 5 kt/s).
                // Keyed scan (not positional): any field after CS that is
                // `native=0`, `rate=N` or `accel=N` is a flag — rate=3 as a
                // bare field would otherwise be misread as a 3 kt approach
                // speed (a numeric field is always kts; the first other field
                // is the procedure name; accel= must be checked BEFORE the
                // appr-name capture — accel=10 is non-numeric and would
                // otherwise be taken as a procedure name).
                try
                {
                    float speedKts = 0f;
                    string appr = null;
                    bool useNative = true;
                    float cfaRate = 0f;
                    float speedAccel = 0f;
                    for (int i = 2; i < parts.Length; i++)
                    {
                        var p = parts[i];
                        if (string.IsNullOrEmpty(p)) continue;
                        if (p == "native=0") { useNative = false; continue; }
                        if (p.StartsWith("rate=", StringComparison.Ordinal)
                            && float.TryParse(p.Substring(5), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedRate)
                            && parsedRate > 0f)
                        { cfaRate = parsedRate; continue; }
                        if (p.StartsWith("accel=", StringComparison.Ordinal)
                            && float.TryParse(p.Substring(6), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedAccel)
                            && parsedAccel > 0f)
                        { speedAccel = parsedAccel; continue; }
                        if (float.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedKts))
                            speedKts = parsedKts;                // a numeric field is always kts
                        else if (appr == null) appr = p;         // first non-numeric field = procedure name
                    }
                    bool ok2 = OverrideController.PatchAircraft("clear_for_appr", parts[1], default, speedKts, appr, useNative, cfaRate, speedAccelKtsPerSec: speedAccel);
                    Plugin.LogMsg($"patch: clear_for_appr → {parts[1]}{(speedKts > 0f ? " " + speedKts.ToString("0", CultureInfo.InvariantCulture) + " kt" : "")}{(appr != null ? " [" + appr + "]" : "")}{(useNative ? "" : " [native=0]")}{(cfaRate > 0f ? $" rate {cfaRate:F0}°/s" : "")}{(speedAccel > 0f ? $" accel {speedAccel:F0} kt/s" : "")}: {(ok2 ? "applied" : "NOT FOUND / not on STAR")} (Mechanism B)");
                }
                catch (Exception ex) { Plugin.LogMsg($"patch: clear_for_appr → {parts[1]} FAILED: {ex.GetType().Name}: {ex.Message}"); }
                break;
            case "track":
                // track|CS — toggle the 1 s parameter trace for one callsign
                // (diagnostics for the clear_for_appr handoff: the tracer
                // dumps aircraft state + DynamicsParams + path lists every
                // second, so the patch's before/after is visible in the log).
                if (parts.Length == 2)
                {
                    try
                    {
                        bool on = ParamTrace.ToggleTrack(parts[1]);
                        Plugin.LogMsg($"patch: track → {parts[1]}: {(on ? "ON" : "OFF")} (1 s param dump)");
                    }
                    catch (Exception ex) { Plugin.LogMsg($"patch: track → {parts[1]} FAILED: {ex.GetType().Name}: {ex.Message}"); }
                }
                break;
        }
    }

    /// <summary>
    /// Click-to-focus: the editor's SelectAircraft frame names a callsign; focus
    /// that aircraft in-game via the game's own AircraftFocusService (the native
    /// command service that used to do this is gone from this build).
    /// </summary>
    private static void FocusAircraft(string callSign)
    {
        try
        {
            var ac = GameServices.FindAircraft(callSign);
            if (ac == null) { LogOnce(ref _diagFocus, $"focus: {callSign} — no live aircraft with that callsign"); return; }

            var svc = GameServices.Resolve<AircraftFocusService>();
            if (svc == null) { LogOnce(ref _diagFocusSvc, "focus: AircraftFocusService not resolved — is a level loaded?"); return; }

            bool ok = svc.TryFocus(ac);
            Plugin.LogMsg($"focus: {callSign} → {(ok ? "focused" : "not focusable")}");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"focus: {callSign} FAILED: {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ── Level-restart state reset  ───────────────────────────
    // The plugin is process-lifetime: an in-game level restart (game stays
    // up) leaves static state stale. ResetDispatchState clears the restore-log
    // so the level-load burst detector below re-arms on load N+1. Called from
    // OverrideController.ResetForLevelLoad.
    public static void ResetDispatchState()
    {
        _restoreLogged.Clear();
    }

    // ── Diagnostics: Dynamics.RestoreRuntimeData — the revert suspect ─────
    // Live: "Dynamics: restore runtime data: FlyApproaching" is the
    // level-loader's restore path (fires at level load; the stack showed only
    // the postfix itself — the caller is the game's native code, so a stack
    // is useless). Every call logs the owning aircraft (via the per-tick
    // reverse-lookup cache) + the current dynamics state — a post-patch
    // restore (a real revert) is unmistakable against the load-time ones.
    // Untracked aircraft log only their first call (level-load lists would
    // spam on every load); tracked aircraft log every call.
    private static readonly HashSet<string> _restoreLogged = new(StringComparer.Ordinal);

    // v12: level-load burst detection — a level load restores
    // EVERY aircraft, so a burst of FIRST-TIME callsigns within a 1 s window
    // is the load signature (a cfa-deferred restore is a REPEAT call for an
    // already-logged callsign — never counts). Fires one reset per burst;
    // ResetDispatchState clears _restoreLogged so the burst re-detects on
    // load N+1. The backstop to the command-service Start/Dispose triggers.
    private static float _restoreWindowStart = float.MinValue;
    private static int _restoreFirstCalls;
    private static bool _restoreResetPending;

    public static void DynamicsRestoreRuntimeDataPostfix(Dynamics __instance)
    {
        try
        {
            var cs = OverrideController.FindCallsignByDynamics(__instance) ?? "<unknown>";
            bool first = _restoreLogged.Add(cs);
            bool tracked = ParamTrace.IsTracked(cs);

            float now = Time.unscaledTime;
            if (now - _restoreWindowStart > 1.0f)
            {
                _restoreWindowStart = now;
                _restoreFirstCalls = 0;
                _restoreResetPending = false;
            }
            if (first) _restoreFirstCalls++;
            if (!_restoreResetPending && _restoreFirstCalls >= 2)
            {
                _restoreResetPending = true;   // one reset per burst, not one per aircraft
                OverrideController.ResetForLevelLoad("Dynamics.RestoreRuntimeData burst (level load)");
            }

            if (!tracked && !first) return;
            Plugin.LogMsg($"restore: Dynamics.RestoreRuntimeData() called for {cs} (dynState={__instance.CurrentState}){(tracked ? " [tracked]" : first ? " [first call]" : "")}");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"restore: trace FAILED: {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ── Diagnostics: the dynamics state machine's canonical transition ────
    // Dynamics.SetCurrentState(IDynamicState, IDynamicsParams) is THE
    // state-set entry — every transition flows through it (incl. a revert
    // back to FlyApproach), carrying the params object the activated state
    // will Init from. For tracked aircraft, log which state + WHICH params
    // object is actually being activated — ours (ApproachDynamicsParams) or
    // the game's (FlyApproachDynamicsParams).
    public static void DynamicsSetCurrentStatePostfix(Dynamics __instance, IDynamicState currentState,
                                                      IDynamicsParams dynamicsParams)
    {
        try
        {
            var cs = OverrideController.FindCallsignByDynamics(__instance);
            if (cs == null || !ParamTrace.IsTracked(cs)) return;
            Plugin.LogMsg($"dyn-state: {cs} SetCurrentState({StateName(currentState)}, {ParamsName(dynamicsParams)})");
        }
        catch { }   // never throw into the game's state machine
    }

    // ── v10 probe: AVCController.SetTargetSpeed — the game's
    // own speed-target writes (the ~144-kt writer hunt for the update_speed
    // override). Postfix on a plain method (the plugin itself calls it — not
    // an IL2CPP field accessor, so the patch applies cleanly). The owner map
    // + the armed-value filter live in OverrideController: our own re-asserts
    // write exactly the armed TargetKts and are filtered; a hit is BY
    // DEFINITION a game-side write of a different target.
    public static void AvcSetTargetSpeedPostfix(Il2CppObjectBase __instance, float speed)
    {
        // NOTE: the parameter MUST be named `speed` — Harmony binds postfix
        // params by NAME, and the game's method is SetTargetSpeed(float speed)
        // (the real type is ContextCross.AutonomousVehicleControl.Controller —
        // what Dynamics.AVCController is typed as). A `value`-named param
        // fails with "Parameter 'value' not found" (the documented field-
        // accessor signature — this one is a genuine method, so the rename
        // fixes it; the field-accessor case is NOT patchable either way).
        try { OverrideController.OnAvcTargetWrite(__instance, speed); }
        catch { }   // never throw into the game's speed controller
    }

    // ── v11 probe: SpeedController.SetTargetSpeed — the ramp's
    // own target setter; the suspected REAL speed-target writer (the v10 AVC
    // probe caught NO game-side AVCController.SetTargetSpeed calls live, so
    // the game either writes the targetSpeed field directly or targets the
    // ramp instead). Same postfix shape as the AVC probe — the parameter MUST
    // be named `speed` (Harmony name-binding; see the note above).
    public static void ScSetTargetSpeedPostfix(Il2CppObjectBase __instance, float speed)
    {
        try { OverrideController.OnScTargetWrite(__instance, speed); }
        catch { }   // never throw into the game's speed controller
    }

    // NOTE: the DynamicsParams SETTER is deliberately NOT patched — it is an
    // IL2CPP field accessor (unpatchable: "field accessor, it can't be
    // patched" / "Parameter 'value' not found"), and the game's native code
    // writes the field directly without ever calling the managed stub. Re-plant
    // detection lives in OverrideController.OnAircraftStep (per-step pointer
    // diff → `params-replant: …`), which sees native writes too.

    // Interface-proxy resolution for the two interfaces (same gotcha as the
    // params objects): IDynamicState / IDynamicsParams never match `is` — the
    // concrete class is identified by native class pointer.
    private static string StateName(IDynamicState st)
    {
        if (st is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr) return "ApproachState";
                if (ob.ObjectClass == Il2CppClassPointerStore<FlyApproachState>.NativeClassPtr) return "FlyApproachState";
                return $"state 0x{ob.ObjectClass.ToInt64():X}";
            }
            catch { return "state ?"; }
        }
        return st?.GetType().Name ?? "<null>";
    }

    private static string ParamsName(IDynamicsParams p)
    {
        if (p is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachDynamicsParams>.NativeClassPtr) return "ApproachDynamicsParams";
                if (ob.ObjectClass == Il2CppClassPointerStore<FlyApproachDynamicsParams>.NativeClassPtr) return "FlyApproachDynamicsParams";
                return $"params 0x{ob.ObjectClass.ToInt64():X}";
            }
            catch { return "params ?"; }
        }
        return p?.GetType().Name ?? "<null>";
    }
}

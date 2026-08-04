using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using ContextCross.Aircrafts;
using ContextCross.Dynamics;
using ContextCross.Dynamics.States;
using ContextCross.Telemetry;
using HarmonyLib;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using Il2CppSystem.Net.Sockets;
using UnityEngine;

namespace AC27Appoarch;

public static class Patches
{
    // ── Design A: overwrite pose after the game's tick (report §4.4) ────
    public static void AircraftStepPostfix(Aircraft __instance)
        => OverrideController.OnAircraftStep(__instance);

    // ── Design A v2: view-level direction hijack ────────────────────────
    // Live 2026-08-03: the commanded heading did NOT stick — a second patch's
    // before-state showed the game's original heading, meaning the game's own
    // systems re-assert the model direction after our postfix (or the visual
    // reads a channel we don't write). The view's direction sync is the LAST
    // writer of the visible orientation, so feed the override's commanded
    // heading there: whenever Aircraft3D syncs its direction, use OUR heading.
    // (POSITION is NOT hijacked — since 2026-08-03 the override is
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

    // ── Design A v3: channel lock — the model's direction write entry ────
    // `_direction` is private to Aircraft, so `set_Direction` (plus Step's
    // internal write, which the Step postfix already overwrites) is the ONLY
    // direction write entry point. While overridden, ANY game direction write
    // (the dynamics' own path-tangent heading inside Step, a later-phase
    // sync) carries the commanded heading instead. Idempotent with our own
    // postfix writes — they read the same commanded value. (Position is NOT
    // locked — game-owned since 2026-08-03.)
    public static void SetDirectionPrefix(Aircraft __instance, ref Vector3 value)
    {
        if (!OverrideController.IsOverridden(__instance)) return;
        // cfa-turn mode (2026-08-03): this prefix sees the game's TRUE
        // path-tangent heading (the only place it is visible — everything
        // else reads the substituted value) — pass it through so
        // CommandedDirection can stash it as the rotation target.
        var d = OverrideController.CommandedDirection(__instance, value);
        if (d.sqrMagnitude > 1e-6f) value = d;
    }

    // ── UDP Mechanism A: `!`-prefixed callsigns are patch frames (§5.4) ─
    // Runtime-verified (2026-08-03): `Execute(in UdpCommand)` NREs inside the
    // Harmony trampoline — the `in`-byref binding is broken in this IL2CPP
    // context ("applied" at load, crashes per call). `ExecuteSelectAircraft(string)`
    // is called for every successfully-parsed SelectAircraft command and has a
    // plain string param — always binds, so it is the Mechanism A hook.
    public static bool UdpExecuteSelectAircraftPrefix(string callSign)
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

    // ── UDP Mechanism B: extended frames on command id 0x00E7 (§5.4) ────
    // Runtime-verified (2026-08-03): `TryParse(ReadOnlySpan<byte>, out …)`
    // CANNOT be patched — the Harmony DMD declares a ref-struct param and the
    // CLR rejects the trampoline (InvalidProgramException on EVERY frame, even
    // plain selects). `Execute(in UdpCommand)` NREs in its trampoline. Both
    // "obvious" hook points are dead.
    //
    // The working capture: the service drains its socket into the byte[]
    // `_receiveBuffer` inside `FixedTick()` — a postfix on FixedTick (no params
    // — safe) reads the datagram back out of the buffer.
    //
    // INTEROP GOTCHA (2026-08-03, live game): Il2CppInterop stubs do NOT expose
    // private fields as FieldInfo — `Traverse.Field("_receiveBuffer")` returns
    // null and silently yields nothing. The field surfaces as a PUBLIC property
    // with the same name (`_receiveBuffer`) of type `Il2CppStructArray<byte>`,
    // readable directly in C#.
    //
    // Frame contract: 8 B header (magic/version/0x00E7) + payload NUL-padded to
    // exactly 64 bytes (72 B total). Because every datagram the game receives
    // overwrites the header bytes, and only our frames carry id 0x00E7 at [6..8),
    // the id check reliably identifies OUR frame as the last one drained — even
    // if a foreign SelectAircraft frame was received after ours in the same tick
    // (its id=1 overwrites the check bytes → we skip).
    private const ushort PatchCommandId = 0x00E7;
    private const int PayloadFieldSize = 64;

    private static byte[] _lastHandledFrame;   // dedup: the postfix fires every tick and the
                                               // buffer still holds our frame when no new
                                               // datagram arrived — skip re-dispatch. Shared by
                                               // the FixedTick and Socket.Receive paths so only
                                               // the first one to see a frame dispatches it.
    private static bool _diagBuffer, _diagHeader, _diagSuppressed, _diagLegacyKts;

    private static void LogOnce(ref bool flag, string msg)
    {
        if (!flag) { flag = true; Plugin.LogMsg(msg); }
    }

    public static void UdpFixedTickPostfix(AircraftUdpCommandService __instance)
    {
        try
        {
            var buf = ReadReceiveBuffer(__instance);
            if (buf != null) TryDispatchFrame(buf);
        }
        catch { }   // never throw into the game's fixed tick
    }

    private static byte[] ReadReceiveBuffer(AircraftUdpCommandService svc)
    {
        try
        {
            var arr = svc._receiveBuffer;          // public stub property — see gotcha above
            if (arr == null) return null;
            var managed = new byte[arr.Length];
            for (int i = 0; i < managed.Length; i++) managed[i] = arr[i];
            return managed;
        }
        catch (Exception ex)
        {
            LogOnce(ref _diagBuffer, $"udp: _receiveBuffer read failed: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    // ── Alternative capture: the datagram the moment it lands ────────────
    // If the game's own parse clears/reuses `_receiveBuffer` before the FixedTick
    // postfix runs, this path catches the frame at the socket instead. Only the
    // game's UDP command socket produces frames with our magic — every other
    // Socket.Receive in the game is filtered out by TryDispatchFrame's header
    // checks (cheap first-4-bytes compare). Dedup is shared with the FixedTick
    // path, so whichever sees the frame first dispatches it once.
    public static void UdpSocketReceivePostfix(Il2CppStructArray<byte> buffer, int offset, int size,
                                               SocketFlags socketFlags, int __result)
        => HandleReceivedDatagram(buffer, offset, __result);

    public static void UdpSocketReceiveSimplePostfix(Il2CppStructArray<byte> buffer, int __result)
        => HandleReceivedDatagram(buffer, 0, __result);

    private static void HandleReceivedDatagram(Il2CppStructArray<byte> buffer, int offset, int count)
    {
        try
        {
            if (buffer == null || count <= 0 || offset < 0 || offset + count > buffer.Length) return;
            var managed = new byte[count];
            for (int i = 0; i < count; i++) managed[i] = buffer[offset + i];
            TryDispatchFrame(managed);
        }
        catch { }
    }

    private static void TryDispatchFrame(byte[] buf)
    {
        if (buf == null || buf.Length < UdpCommandParser.HeaderSize + PayloadFieldSize) return;
        int fieldLen = UdpCommandParser.HeaderSize + PayloadFieldSize;
        if (_lastHandledFrame != null && _lastHandledFrame.AsSpan().SequenceEqual(buf.AsSpan(0, fieldLen)))
            return;                                              // no new datagram since the last handled frame

        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(UdpCommandParser.MagicOffset, 4));
        if (magic != UdpCommandParser.Magic)
        {
            // A zeroed head after the game's parse means the game cleared the
            // buffer — the Socket.Receive capture is then the working path.
            if (buf[0] == 0 && buf[1] == 0 && buf[2] == 0 && buf[3] == 0)
                LogOnce(ref _diagHeader, $"udp: receive buffer all-zero after game parse (len {buf.Length}) — Socket.Receive capture is the working path");
            return;                                              // foreign datagram — silent
        }
        if (BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(UdpCommandParser.VersionOffset, 2)) != UdpCommandParser.Version)
        {
            LogOnce(ref _diagHeader, $"udp: version mismatch — head {BitConverter.ToString(buf, 0, 8)}");
            return;
        }
        if (BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(UdpCommandParser.CommandIdOffset, 2)) != PatchCommandId)
            return;                                              // the game's own SelectAircraft frames — expected, silent

        _lastHandledFrame = buf[..fieldLen];                     // our frame — mark handled

        int end = Array.IndexOf(buf, (byte)0, UdpCommandParser.PayloadOffset, PayloadFieldSize);
        if (end < 0) end = UdpCommandParser.PayloadOffset + PayloadFieldSize;
        var parts = Encoding.ASCII.GetString(buf, UdpCommandParser.PayloadOffset, end - UdpCommandParser.PayloadOffset).Split('|');
        if (parts.Length < 2) return;

        switch (parts[0])
        {
            case "update_heading":
            case "update_position":   // legacy alias — pre-decouple name, kts ignored
                // Canonical: update_heading|CS|dx|dy[|rate] — HEADING-ONLY
                // override (the game keeps full control of position and
                // speed). 5th field = smooth-turn rate in °/GAME-second
                // (2026-08-03): the nose rotates toward the heading at that
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
            case "clear_for_appr":
                // clear_for_appr|CS[|kts][|appr][|native=0][|rate=N] — kts =
                // approach speed in raw knots (omitted/0 = leave the aircraft's
                // speed untouched); appr = named procedure (omitted = nearest
                // APP route); native=0 skips CommandContinueApproach — its
                // deferred flow restores the aircraft's runtime data
                // ("Dynamics: restore runtime data: FlyApproaching"), the
                // suspected revert back to the STAR; rate=N = smooth-turn
                // °/GAME-second for the handoff turn (2026-08-03 — the nose
                // rotates onto the approach course instead of snapping;
                // omitted = the plugin's ClearForApprTurnRateDeg default).
                // Keyed scan (not positional): any field after CS that is
                // `native=0` or `rate=N` is a flag — rate=3 as a bare field
                // would otherwise be misread as a 3 kt approach speed (a
                // numeric field is always kts; the first other field is the
                // procedure name).
                try
                {
                    float speedKts = 0f;
                    string appr = null;
                    bool useNative = true;
                    float cfaRate = 0f;
                    for (int i = 2; i < parts.Length; i++)
                    {
                        var p = parts[i];
                        if (string.IsNullOrEmpty(p)) continue;
                        if (p == "native=0") { useNative = false; continue; }
                        if (p.StartsWith("rate=", StringComparison.Ordinal)
                            && float.TryParse(p.Substring(5), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedRate)
                            && parsedRate > 0f)
                        { cfaRate = parsedRate; continue; }
                        if (float.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsedKts))
                            speedKts = parsedKts;                // a numeric field is always kts
                        else if (appr == null) appr = p;         // first non-numeric field = procedure name
                    }
                    bool ok2 = OverrideController.PatchAircraft("clear_for_appr", parts[1], default, speedKts, appr, useNative, cfaRate);
                    Plugin.LogMsg($"patch: clear_for_appr → {parts[1]}{(speedKts > 0f ? " " + speedKts.ToString("0", CultureInfo.InvariantCulture) + " kt" : "")}{(appr != null ? " [" + appr + "]" : "")}{(useNative ? "" : " [native=0]")}{(cfaRate > 0f ? $" rate {cfaRate:F0}°/s" : "")}: {(ok2 ? "applied" : "NOT FOUND / not on STAR")} (Mechanism B)");
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

    // ── UDP log suppression: the game's own parse rejects id 0x00E7 and warns
    // "UnknownCommand" once per frame (the FixedTick postfix cannot stop the
    // game's parse — it only reads the buffer afterwards). Skip that warning;
    // other bad-datagram reasons (bad magic, bad version, …) still surface.
    public static bool UdpLogBadDatagramOncePrefix(string reason)
    {
        if (!string.IsNullOrEmpty(reason) && reason.IndexOf("UnknownCommand", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            LogOnce(ref _diagSuppressed, $"udp: game UnknownCommand warning suppressed (reason: \"{reason}\")");
            return false;
        }
        return true;
    }

    // ── Diagnostics: Dynamics.RestoreRuntimeData — the revert suspect ─────
    // Live 2026-08-03: "Dynamics: restore runtime data: FlyApproaching" is the
    // level-loader's restore path (fires at level load; the stack showed only
    // the postfix itself — the caller is the game's native code, so a stack
    // is useless). Every call logs the owning aircraft (via the per-tick
    // reverse-lookup cache) + the current dynamics state — a post-patch
    // restore (a real revert) is unmistakable against the load-time ones.
    // Untracked aircraft log only their first call (level-load lists would
    // spam on every load); tracked aircraft log every call.
    private static readonly HashSet<string> _restoreLogged = new(StringComparer.Ordinal);

    public static void DynamicsRestoreRuntimeDataPostfix(Dynamics __instance)
    {
        try
        {
            var cs = OverrideController.FindCallsignByDynamics(__instance) ?? "<unknown>";
            bool first = _restoreLogged.Add(cs);
            bool tracked = ParamTrace.IsTracked(cs);
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

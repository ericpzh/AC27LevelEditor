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

namespace AC27Approach;

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

    // ── Design A v4: view-level ALTITUDE hijack (2026-08-04) ─────────────
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

    private static byte[] _lastHandledFrame;   // dedup: the FixedTick postfix fires every tick
                                               // and the buffer still holds our frame when no
                                               // new datagram arrived — skip re-dispatch. Only
                                               // the FixedTick path consults it (the Socket.
                                               // Receive path dispatches every real datagram,
                                               // byte identity notwithstanding); updated at
                                               // dispatch so only the first path to see a frame
                                               // dispatches it. Cleared at level load
                                               // (ResetDispatchState) so a re-sent identical
                                               // frame after an in-game level restart dispatches.
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
    // Socket.Receive in the game is filtered out by the header checks in
    // DispatchDatagram (cheap first-4-bytes compare). A Receive return is a NEW
    // datagram by definition, so this path dispatches WITHOUT the content dedup
    // (a byte-identical re-send is still a real command — e.g. re-applying an
    // override after a level restart); _lastHandledFrame is updated at dispatch
    // so the FixedTick path skips the same frame afterwards.
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
            DispatchDatagram(managed);   // a Receive return is a NEW datagram — no content dedup
        }
        catch { }
    }

    // FixedTick-only entry: the game drains the socket inside FixedTick, so
    // the buffer may still hold the previous frame when no new datagram
    // arrived — the content dedup skips that stale re-read. The Socket.Receive
    // path (HandleReceivedDatagram) bypasses this entirely.
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
        DispatchDatagram(buf);
    }

    // Shared dispatch tail: header validation + payload parse + command
    // switch. Called by the Socket.Receive path (unconditionally — a new
    // datagram) and the FixedTick path (after its content dedup). Updates
    // _lastHandledFrame at dispatch, so whichever path claims a frame first
    // is the only one to dispatch it.
    private static void DispatchDatagram(byte[] buf)
    {
        int fieldLen = UdpCommandParser.HeaderSize + PayloadFieldSize;
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
            case "altitude":
                // altitude|CS|targetFt[|rateFpm] — climb/descend-and-maintain
                // override (2026-08-04): forces the aircraft's Y toward
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
                // (2026-08-04; v12 2026-08-05 accel=N): kts = raw knots (int;
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
                // °/GAME-second (v6, 2026-08-04; the frame's rate, or the
                // plugin's 3°/s default; the v5 note "inert — no tangent snap"
                // was superseded by the de-snap); accel=N (v12, 2026-08-05)
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

    // ── Level-restart state reset (2026-08-05) ───────────────────────────
    // The plugin is process-lifetime: an in-game level restart (game stays
    // up) leaves static state stale. ResetDispatchState clears the frame
    // dedup (a re-sent identical frame would otherwise be swallowed forever
    // — the "overrides stopped after a level restart" bug) and the
    // restore-log (so the level-load burst detector below re-arms on load
    // N+1). Called from OverrideController.ResetForLevelLoad.
    public static void ResetDispatchState()
    {
        _lastHandledFrame = null;
        _restoreLogged.Clear();
    }

    // ── Level restart detection (2026-08-05) ────────────────────────────
    // The game's AircraftUdpCommandService is a per-level VContainer service
    // (IStartable/IFixedTickable/IDisposable — same DI family as GameTime
    // and AirwayRouteService): Start() fires when the command channel
    // (re)binds, Dispose() when it tears down — the exact moments per-level
    // plugin state becomes invalid. If the service turns out to be
    // session-scoped, these fire only at game start (harmless no-op resets);
    // the restore-burst detector in DynamicsRestoreRuntimeDataPostfix is the
    // every-load backstop. Both are wrapped so a reset can never throw into
    // the game.
    public static void UdpCommandServiceStartPostfix(AircraftUdpCommandService __instance)
    {
        try { OverrideController.ResetForLevelLoad("AircraftUdpCommandService.Start — command channel (re)bound"); }
        catch (Exception ex) { Plugin.LogMsg($"level reset: Start FAILED: {ex.GetType().Name}: {ex.Message}"); }
    }

    public static void UdpCommandServiceDisposePrefix(AircraftUdpCommandService __instance)
    {
        try { OverrideController.ResetForLevelLoad("AircraftUdpCommandService.Dispose — command channel torn down"); }
        catch (Exception ex) { Plugin.LogMsg($"level reset: Dispose FAILED: {ex.GetType().Name}: {ex.Message}"); }
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

    // v12 (2026-08-05): level-load burst detection — a level load restores
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

    // ── v10 probe (2026-08-05): AVCController.SetTargetSpeed — the game's
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

    // ── v11 probe (2026-08-05): SpeedController.SetTargetSpeed — the ramp's
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

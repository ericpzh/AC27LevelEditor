using System;
using System.Reflection;
using BepInEx;
using BepInEx.Unity.IL2CPP;
using ContextCross.Aircrafts;
using ContextCross.Dynamics;
using ContextCross.Telemetry;
using HarmonyLib;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using Il2CppSystem.Net.Sockets;

namespace AC27Appoarch;

/// <summary>
/// AC27Appoarch — direct aircraft control via the game's native UDP command
/// channel (report §5.4). Input: UDP only.
/// </summary>
[BepInPlugin("com.ac27.appoarch", "AC27Appoarch", "1.0.0")]
public class Plugin : BasePlugin
{
    public static Plugin Instance;

    public override void Load()
    {
        Instance = this;

        var harmony = new Harmony("com.ac27.appoarch");

        // Design A: overwrite pose after the game's tick (report §4.4)
        TryPatch(harmony, "Aircraft.Step (postfix)",
            AccessTools.Method(typeof(Aircraft), "Step"),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.AircraftStepPostfix))));

        // Design A v2: hijack the view's direction sync — the last writer of
        // the visible orientation (the model field alone didn't hold the
        // commanded heading in the live test). POSITION is NOT hijacked:
        // since 2026-08-03 the override is heading-only — the game keeps
        // full control of position and speed.
        TryPatch(harmony, "View hijack (Aircraft3D.SetDirection)",
            AccessTools.Method(typeof(Aircraft3D), "SetDirection"),
            prefix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.Aircraft3DSetDirectionPrefix))));

        // Design A v3: channel lock — the model's direction write entry point.
        // `_direction` is private to Aircraft, so set_Direction (plus Step's
        // internal write, which the Step postfix already overwrites) is the
        // only direction write path; while overridden, ANY game direction
        // write (the dynamics' own path-tangent heading inside Step, a
        // later-phase sync) carries the commanded heading instead. Position
        // is NOT locked — game-owned since 2026-08-03 (heading-only override).
        TryPatch(harmony, "Channel lock (Aircraft.set_Direction)",
            AccessTools.PropertySetter(typeof(Aircraft), "Direction"),
            prefix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.SetDirectionPrefix))));

        // UDP Mechanism A (report §5.4): `!`-prefixed callsigns are patch frames.
        // Runtime-verified hook (2026-08-03): `ExecuteSelectAircraft(string)` —
        // plain string param, always binds. (`Execute(in UdpCommand)` NREs at
        // runtime in this IL2CPP context despite applying cleanly at load.)
        TryPatch(harmony, "UDP Mechanism A (AircraftUdpCommandService.ExecuteSelectAircraft)",
            AccessTools.Method(typeof(AircraftUdpCommandService), "ExecuteSelectAircraft"),
            prefix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.UdpExecuteSelectAircraftPrefix))));

        // UDP Mechanism B (report §5.4): extended frames on command id 0x00E7.
        // Runtime-verified hook (2026-08-03): FixedTick() postfix reads the
        // datagram back from the service's `_receiveBuffer` — via the stub's
        // public `get__receiveBuffer()` accessor (the field is NOT exposed as
        // FieldInfo; Traverse.Field resolves null and silently no-ops). A
        // Socket.Receive postfix is applied as an alternative capture (in case
        // the game's parse clears the buffer) — shared dedup makes the two
        // paths mutually exclusive. (`TryParse` takes a ReadOnlySpan<byte> —
        // ref-struct — the Harmony DMD is invalid IL and throws
        // InvalidProgramException on every frame; it CANNOT be patched.)
        TryPatch(harmony, "UDP Mechanism B (AircraftUdpCommandService.FixedTick postfix)",
            AccessTools.Method(typeof(AircraftUdpCommandService), "FixedTick"),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.UdpFixedTickPostfix))));

        TryPatch(harmony, "UDP Mechanism B (Socket.Receive capture, 4-arg)",
            AccessTools.Method(typeof(Socket), "Receive",
                new[] { typeof(Il2CppStructArray<byte>), typeof(int), typeof(int), typeof(SocketFlags) }),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.UdpSocketReceivePostfix))));

        TryPatch(harmony, "UDP Mechanism B (Socket.Receive capture, 1-arg)",
            AccessTools.Method(typeof(Socket), "Receive", new[] { typeof(Il2CppStructArray<byte>) }),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.UdpSocketReceiveSimplePostfix))));

        // The game's own parse rejects id 0x00E7 with a one-line UnknownCommand
        // warning (the postfix cannot stop the parse, only read the buffer after
        // it) — suppress that specific reason; other bad-datagram reasons keep
        // logging so real protocol mismatches stay visible.
        TryPatch(harmony, "UDP log suppression (AircraftUdpCommandService.LogBadDatagramOnce)",
            AccessTools.Method(typeof(AircraftUdpCommandService), "LogBadDatagramOnce"),
            prefix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.UdpLogBadDatagramOncePrefix))));

        // Diagnostics: Dynamics.RestoreRuntimeData — "Dynamics: restore runtime
        // data: FlyApproaching" fires right after the clear_for_appr patch
        // (2026-08-03 live log) and is the suspected revert mechanism back to
        // the STAR. One-shot trace of the caller (managed stack + callsign).
        TryPatch(harmony, "Dynamics.RestoreRuntimeData (trace)",
            AccessTools.Method(typeof(Dynamics), "RestoreRuntimeData"),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.DynamicsRestoreRuntimeDataPostfix))));

        // Diagnostics: Dynamics.SetCurrentState — the state machine's
        // canonical transition entry (every transition carries the params the
        // activated state will Init from). Logs for tracked aircraft which
        // state + WHICH params object is activated — a revert back to
        // FlyApproach with the STAR params is immediately visible.
        TryPatch(harmony, "Dynamics.SetCurrentState (trace)",
            AccessTools.Method(typeof(Dynamics), "SetCurrentState"),
            postfix: new HarmonyMethod(typeof(Patches).GetMethod(nameof(Patches.DynamicsSetCurrentStatePostfix))));

        // NOTE: AircraftDynamicsData.DynamicsParams is NOT patched — its
        // setter is an IL2CPP field accessor (the interop stub's private-field-
        // as-property pattern): the IL2CPP detour backend refuses it ("field
        // accessor, it can't be patched") and the managed fallback fails
        // ("Parameter 'value' not found"). And even if it patched, the game's
        // native C++ writes the field directly — never through the managed
        // stub — so the hook would only catch managed callers (us). The
        // re-plant is detected instead by OverrideController's per-step
        // pointer-diff (`params-replant: …`), which sees native writes too.

        // Per-second parameter tracer — `track|CS` toggles a 1 s dump of a
        // tracked aircraft's full params (state machines + DynamicsParams +
        // path lists), so a clear_for_appr patch's before/after is visible
        // in the log. BasePlugin has no Update loop — the tick runs on a
        // MonoBehaviour the plugin registers.
        try
        {
            AddComponent<TracerBehaviour>();
            Log.LogInfo("[AC27Appoarch] Param tracer (1 s): applied");
        }
        catch (Exception ex)
        {
            Log.LogWarning($"[AC27Appoarch] Param tracer (1 s): FAILED ({ex.GetType().Name}: {ex.Message})");
        }

        Log.LogInfo("AC27Appoarch loaded");
    }

    /// <summary>Log to the BepInEx console/log from anywhere in the plugin.</summary>
    public static void LogMsg(string msg) => Instance?.Log.LogInfo($"[AC27Appoarch] {msg}");

    private bool TryPatch(Harmony harmony, string label, MethodBase target,
                          HarmonyMethod prefix = null, HarmonyMethod postfix = null)
    {
        if (target == null)
        {
            Log.LogWarning($"[AC27Appoarch] {label}: target method not found — NOT applied");
            return false;
        }
        try
        {
            harmony.Patch(target, prefix: prefix, postfix: postfix);
            Log.LogInfo($"[AC27Appoarch] {label}: applied");
            return true;
        }
        catch (Exception ex)
        {
            Log.LogWarning($"[AC27Appoarch] {label}: FAILED ({ex.GetType().Name}: {ex.Message})");
            return false;
        }
    }
}

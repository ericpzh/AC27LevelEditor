using System;
using System.Collections.Generic;
using System.Linq;
using ContextCross;
using ContextCross.Aircrafts;
using ContextCross.Aircrafts.Enums;
using ContextCross.Dynamics;
using ContextCross.Dynamics.Enums;
using ContextCross.Dynamics.States;
using ContextCross.Enums;
using ContextCross.Models;
using ContextCross.Services;
using HarmonyLib;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using R3;
using UnityEngine;
using VContainer;
using VContainer.Unity;

namespace AC27Appoarch;

/// <summary>
/// Unified patch API (report §4.3 + §6.4): `update_heading` (heading-only
/// nose override — the game keeps full control of position and speed,
/// Design A) and `clear_for_appr` (state-30 → state-5 approach handoff
/// with fully populated approach geometry).
/// </summary>
public static class OverrideController
{
    private class Entry
    {
        public Vector3 Direction;      // normalized; zero = no heading command
        public int StepCount;          // diagnostics: sample the first ~0.5 s of override
        public Aircraft3D View;        // cached visible view (diagnostics)
    }

    private static readonly Dictionary<Aircraft, Entry> _overrides = new();

    // ── diagnostics state (2026-08-03) ──────────────────────────────────
    // Reverse lookups: the game has no public link back from Dynamics /
    // AircraftDynamicsData to the aircraft — the restore/state/params traces
    // need the callsign. A per-tick cache (refreshed in OnAircraftStep for
    // every aircraft) beats the FindObjectsOfType scan, which misses during
    // level load (the "restore: ... called for <unknown>" case).
    private static readonly Dictionary<Dynamics, string> _dynToCs = new();
    private static readonly Dictionary<AircraftDynamicsData, string> _dataToCs = new();

    // Approach watch: per-step diag for the first ~1.7 s after a
    // clear_for_appr patch — the critical window where the aircraft either
    // turns onto the ILS or keeps flying the STAR. Value = steps remaining.
    private const int ApproachWatchBudget = 100;
    private static readonly Dictionary<Aircraft, int> _approachWatch = new();

    // Replant detection: the data channel's DynamicsParams pointer WE planted
    // (per aircraft). The setter is an IL2CPP field accessor — unpatchable by
    // both Harmony backends — and the game's native C++ writes the field
    // directly, bypassing the managed stub entirely. The only way to see a
    // re-plant is to diff the pointer every step while the aircraft is
    // tracked (the post-patch window) — catches native direct writes too.
    private static readonly Dictionary<Aircraft, IntPtr> _plantedParams = new();

    /// <summary>Unified patch API: "update_heading" | "update_position" (legacy) | "clear_for_appr".</summary>
    public static bool PatchAircraft(string commandType, string callsign,
                                     Vector3 direction = default, float speedKnots = 0f,
                                     string apprName = null, bool useNative = true)
    {
        switch (commandType)
        {
            case "update_heading":  return patchHeading(callsign, direction);
            case "update_position": return patchHeading(callsign, direction);   // legacy alias (kts ignored)
            case "clear_for_appr":  return clearForApproach(callsign, speedKnots, apprName, useNative);
            default:                return false;
        }
    }

    // ── update_heading: heading-only override (report §4.3) ──────────────

    /// <summary>Force the aircraft's nose to `direction`. Position and speed
    /// stay 100% the game's — the dynamics keeps flying the aircraft's own
    /// route at its own speed; only the heading (property / reactive /
    /// rotation channels + visible nose) is overridden.</summary>
    public static bool patchHeading(string callsign, Vector3 direction)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // Before-state: what the game had running before the override.
        // Heading uses the game's own convention (UI shows atan2(dir.x, dir.z) in °).
        float bHdg = HeadingDeg(ac.Direction);
        float bSpd = ac.AirSpeedKnot != null ? Convert.ToSingle(ac.AirSpeedKnot.Value) : 0f;

        var e = new Entry {
            Direction = direction.sqrMagnitude > 1e-6f ? direction.normalized : Vector3.zero,
        };
        _overrides[ac] = e;

        // After-state: what the override commands. Speed and position are not
        // touched — the game keeps them; the aircraft flies its own route at
        // its own speed, pointing at the commanded heading.
        float aHdg = HeadingDeg(e.Direction);
        Plugin.LogMsg($"override: {callsign} before hdg {(bHdg < 0f ? "n/a" : bHdg + "°")} spd {bSpd:F0} kt → after hdg {(aHdg < 0f ? "none (game's own)" : aHdg + "°")} (heading-only — game keeps position & speed)");
        return true;
    }

    /// <summary>
    /// Heading in the game's convention — the UI shows atan2(dir.x, dir.z) in
    /// degrees (verified live 2026-08-03: Vector3(-1,0,0) displays as 270° west).
    /// To command heading H send (dx, dy) = (sin H, cos H): +Z = north, +X = east
    /// (360 → (0,1), 180 → (0,−1), 270 → (−1,0), 90 → (1,0)).
    /// </summary>
    private static float HeadingDeg(Vector3 dir)
    {
        if (dir.sqrMagnitude < 1e-6f) return -1f;   // no direction — e.g. hold position
        float h = Mathf.Atan2(dir.x, dir.z) * Mathf.Rad2Deg;
        return h < 0f ? h + 360f : h;
    }

    public static bool clearOverride(string callsign)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // The override only touched the heading channels — the game resumes
        // writing them on the next tick, nothing else needs restoring.
        return _overrides.Remove(ac);
    }

    public static bool IsOverridden(Aircraft ac) => _overrides.ContainsKey(ac);

    /// <summary>Called by the Harmony postfix on Aircraft.Step(), every fixed tick.</summary>
    public static void OnAircraftStep(Aircraft ac)
    {
        // Reverse-lookup caches — keep the dynamics/data → callsign mapping
        // fresh every tick (the traces run on the game's main thread).
        if (ac._dynamics != null) _dynToCs[ac._dynamics] = ac.CallSign;
        if (ac.DynamicsData != null) _dataToCs[ac.DynamicsData] = ac.CallSign;

        // Approach watch: per-step diag for the first ~1.7 s after a
        // clear_for_appr patch (steps 0,10,20,...,90). Same dump shape as the
        // 1 s tracer — state machines + params + the ACTIVE state's own path
        // copy — so the seconds after the patch show whether the aircraft
        // turns onto the ILS (st=ApproachState stPath= the approach list,
        // position closing on path[0]) or keeps flying the STAR.
        if (_approachWatch.TryGetValue(ac, out int remain))
        {
            int done = ApproachWatchBudget - remain;
            _approachWatch[ac] = remain - 1;
            if (remain - 1 <= 0) _approachWatch.Remove(ac);
            if (done % 10 == 0)
                Plugin.LogMsg($"watch: {ac.CallSign} step {done} {ParamTrace.BuildDump(ac)}");
        }

        // Replant detection (replaces the unpatchable setter hook): if ANYTHING
        // re-plants the data channel's params after our patch — a deferred game
        // flow loading the STAR's FlyApproachDynamicsParams — the pointer
        // changes. Diff it every step while tracked + planted (post-patch
        // window); log the moment it changes, with WHICH params took its place.
        if (ac.DynamicsData != null
            && _plantedParams.TryGetValue(ac, out IntPtr planted)
            && ParamTrace.IsTracked(ac.CallSign))
        {
            var cur = ac.DynamicsData.DynamicsParams;
            IntPtr curPtr = cur is Il2CppObjectBase curOb ? curOb.Pointer : IntPtr.Zero;
            if (curPtr != planted)
            {
                Plugin.LogMsg($"params-replant: {ac.CallSign} DynamicsParams ← {ReplantName(cur)} (was 0x{planted.ToInt64():X}, now 0x{curPtr.ToInt64():X})");
                _plantedParams[ac] = curPtr;               // log each distinct re-plant once
            }
        }

        if (!_overrides.TryGetValue(ac, out var e)) return;

        // HEADING-ONLY override: force the nose to the commanded heading.
        // Position and speed are 100% the game's — the dynamics keeps
        // integrating its own route at its own speed, and the game's own
        // heading write each Step is re-pointed by the set_Direction channel
        // lock. Zero direction = no heading command (nothing is touched).
        if (e.Direction != Vector3.zero)
        {
            ac.Direction = e.Direction;
            // 1b) heading channels — the game may drive its readouts/visual
            //     from the serialized reactive `_direction` and the `Rotation`
            //     heading instead of the `Direction` property; write all of
            //     them so every consumer sees the commanded heading. (The diag
            //     samples below show which channel the game actually follows.)
            if (ac.DirectionReactive != null) ac.DirectionReactive.Value = e.Direction;
            if (ac.Rotation != null) ac.Rotation.Value = HeadingDeg(e.Direction);
        }

        // 2) diagnostics — sample the first ~0.5 s of the override so a single
        //    live test shows whether the heading holds across the channels and
        //    that the game's own motion (view3D-pos / dynVel / rbVel) is
        //    untouched — the aircraft keeps flying its own route at its own
        //    speed, only the nose is re-pointed.
        if (e.View == null) e.View = FindView3D(ac);
        e.StepCount++;
        if (e.StepCount <= 30 && (e.StepCount == 1 || e.StepCount % 10 == 0))
            LogDiagnostic(ac, e);
    }

    /// <summary>One-sample read-back of every heading channel plus the game's
    /// own motion (position / velocities / speed), for the diag line. With
    /// the heading-only override, pos/dynVel/rbVel are expected NON-zero —
    /// they prove the game's own flight is untouched.</summary>
    private static void LogDiagnostic(Aircraft ac, Entry e)
    {
        float propHdg = HeadingDeg(ac.Direction);
        float rxHdg = ac.DirectionReactive != null ? HeadingDeg(ac.DirectionReactive.Value) : float.NaN;
        float rot = ac.Rotation != null ? Convert.ToSingle(ac.Rotation.Value) : float.NaN;
        // Display-only read of the game's own speed (knots) — proves the
        // override never touches it.
        float kts = ac.TaxiSpeed != null ? Convert.ToSingle(ac.TaxiSpeed.Value)
                 : ac.AirSpeedKnot != null ? Convert.ToSingle(ac.AirSpeedKnot.Value)
                 : float.NaN;
        string view = "none", viewPos = "none", rbVel = "none";
        var v = e.View ?? FindView3D(ac);
        if (v != null && v.transform != null)
        {
            var eu = v.transform.eulerAngles;
            view = $"{eu.x:F1},{eu.y:F1},{eu.z:F1}";
            var wp = v.transform.position;
            viewPos = $"({wp.x:F1},{wp.y:F1},{wp.z:F1})";
            var rb = v.GetComponent<Rigidbody>();
            if (rb != null) rbVel = rb.velocity.magnitude.ToString("F2");
        }
        var p = ac.Position;
        var dyn = ac._dynamics;
        string dynPos = dyn != null ? $"({dyn.Position.x:F1},{dyn.Position.y:F1},{dyn.Position.z:F1})" : "none";
        string dynVel = dyn != null ? dyn.Velocity.magnitude.ToString("F2") : "none";
        Plugin.LogMsg($"diag: {ac.CallSign} step {e.StepCount} spd {kts:F0} pos ({p.x:F1},{p.y:F1},{p.z:F1}) propHdg {propHdg:F2}° rxHdg {rxHdg:F2}° rot {rot:F2}° view3D-euler {view} view3D-pos {viewPos} rbVel {rbVel} dynPos {dynPos} dynVel {dynVel}");
    }

    /// <summary>The first visible Aircraft3D bound to this aircraft (its own Step
    /// drives Aircraft.Step, then syncs the view — the last writer of the visible
    /// transform).</summary>
    private static Aircraft3D FindView3D(Aircraft ac)
    {
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source == ac) return v;
        return null;
    }

    /// <summary>Read accessor for the view-level hijack (Patches).</summary>
    public static Vector3 CommandedDirection(Aircraft ac)
        => _overrides.TryGetValue(ac, out var e) ? e.Direction : Vector3.zero;

    /// <summary>Heading in the game UI's convention — public for the view hijack.</summary>
    public static float GameHeading(Vector3 dir) => HeadingDeg(dir);

    public static Aircraft FindByCallsign(string callsign)
    {
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source != null && v.Source.CallSign == callsign)
                return v.Source;
        return null;
    }

    public static List<string> AllCallsigns()
    {
        var list = new List<string>();
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source != null && v.Source.CallSign != null)
                list.Add(v.Source.CallSign);
        return list;
    }

    /// <summary>Reverse lookup: which aircraft owns this dynamics instance?
    /// Cache-first (refreshed every tick in OnAircraftStep — the view scan
    /// misses during level load). Used by the RestoreRuntimeData /
    /// SetCurrentState traces — the game log doesn't name the aircraft.</summary>
    public static string FindCallsignByDynamics(Dynamics dyn)
    {
        if (dyn == null) return null;
        if (_dynToCs.TryGetValue(dyn, out var cached)) return cached;
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
        {
            var src = v.Source;
            if (src != null && src._dynamics == dyn)
            {
                _dynToCs[dyn] = src.CallSign;
                return src.CallSign;
            }
        }
        return null;
    }

    /// <summary>Reverse lookup for the data channel (AircraftDynamicsData) —
    /// same cache pattern.</summary>
    public static string FindCallsignByData(AircraftDynamicsData data)
    {
        if (data == null) return null;
        if (_dataToCs.TryGetValue(data, out var cached)) return cached;
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
        {
            var src = v.Source;
            if (src != null && src.DynamicsData == data)
            {
                _dataToCs[data] = src.CallSign;
                return src.CallSign;
            }
        }
        return null;
    }

    /// <summary>Which concrete params class is on the channel now — same
    /// interface-proxy gotcha as everywhere (the getter returns the interface
    /// wrapper, `is` never matches): identify by native class pointer.</summary>
    private static string ReplantName(object p)
    {
        if (p is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachDynamicsParams>.NativeClassPtr) return "ApproachDynamicsParams";
                if (ob.ObjectClass == Il2CppClassPointerStore<FlyApproachDynamicsParams>.NativeClassPtr) return "FlyApproachDynamicsParams";
                return $"0x{ob.ObjectClass.ToInt64():X}";
            }
            catch { return "?"; }
        }
        return p?.GetType().Name ?? "<null>";
    }

    // ── clear_for_appr: state 30 → 5 approach handoff (report §6.4) ─────

    /// <summary>
    /// Hand a STAR (state 30 / Fly) aircraft onto the final approach
    /// (state 5 / Approach) with fully populated approach geometry,
    /// mirroring an ACL pre-spawned state=5 aircraft (buildState5AircraftBlock).
    /// speedKnots &gt; 0 commands the approach speed (raw knots — the game's own
    /// ApproachSpeedKts scale); speedKnots &lt;= 0 (default) leaves the
    /// aircraft's speed fields untouched.
    /// </summary>
    public static bool clearForApproach(string callsign, float speedKnots = 0f, string apprName = null,
                                        bool useNative = true)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // Diagnostics: pin the exact state at patch receipt (the 1 s tracer
        // streams the same shape; this line marks the command-time snapshot).
        ParamTrace.DumpNow(callsign, "BEFORE");

        // 1) A heading override would fight the approach — drop it (the
        //    override only touched heading channels, nothing to restore).
        _overrides.Remove(ac);

        // 2) Only aircraft on the STAR can be handed to the approach.
        if (!ac.IsInState(EAircraftState.Fly)) return false;

        // 3) Resolve the approach procedure (RouteType.APP): by name if supplied,
        //    else nearest to the aircraft among the runway's registered APP routes
        //    (same variant-selection rule the editor uses with hintPosition).
        var routes = ResolveAirwayRouteService();
        if (routes == null) return false;
        var runway = GetArrivalRunway(ac, routes);
        if (runway == null) return false;

        Runway.Route appr = null;
        if (!string.IsNullOrEmpty(apprName))
            appr = FindApproachRouteByName(routes, runway, apprName);
        if (appr == null)
        {
            try
            {
                appr = routes.GetRoute(ac.Position, runway, AirwayRouteService.RouteType.APP);
            }
            catch (Exception ex)   // game-side dict miss → bail cleanly, don't let it escape into the tick
            {
                Plugin.LogMsg($"cfa: {callsign} GetRoute FAILED (runway {runway.Name}/{runway.PhysicalName}): {ex.GetType().Name}: {ex.Message}");
                return false;
            }
        }
        if (appr == null) return false;

        // 4) Build the ACL-equivalent ApproachDynamicsParams.
        var pathList = new Il2CppSystem.Collections.Generic.List<Vector3>();
        foreach (var node in appr.AirwayNodes)
            if (node != null) pathList.Add(node.Position);   // IAF → threshold
        if (pathList.Count < 2) return false;

        var dp = ac.DynamicsData;                    // the serialized data channel
        if (dp == null) return false;

        var p = new ApproachDynamicsParams {
            ProgressRatio = 0f,                           // game re-derives pose from path (ACL constant)
            TouchDownPosition = runway.TouchDownPosition, // public getter — runway threshold
            ApproachDirection = (pathList[pathList.Count - 1] - pathList[pathList.Count - 2]).normalized,
            CommandedGoAround = false,
            InitialPosition = new Vector3(pathList[0].x, 15.24f, pathList[0].z),   // IAF, Y = approach ceiling (ACL constant)
            PathPointList = pathList,
        };

        // 4b) The aircraft's runtime state-30 params still carry the STAR path
        //     in FlyApproachPathPointList; the game's path-following continues
        //     from THAT list through the handoff (observed live: approach
        //     follows the STAR, not the ILS). Overwrite it with the full
        //     approach procedure — the same IAF→threshold list going into
        //     PathPointList. (No clear step needed: assigning a fresh list
        //     replaces the STAR path atomically. AppPointList already holds
        //     the APP points per state-30 semantics — untouched.)
        //
        //     Interop gotcha (live-verified 2026-08-03): the interface-typed
        //     getter returns the object wrapped in the interface's interop
        //     class ("IDynamicsParams"), so `is FlyApproachDynamicsParams`
        //     NEVER matches — the write above silently no-oped. Identify the
        //     concrete class by its native class pointer and re-wrap the
        //     native pointer in it instead.
        if (dp.DynamicsParams is Il2CppObjectBase dpOb)
        {
            try
            {
                if (dpOb.ObjectClass == Il2CppClassPointerStore<FlyApproachDynamicsParams>.NativeClassPtr)
                {
                    var flyParams = new FlyApproachDynamicsParams(dpOb.Pointer);
                    flyParams.FlyApproachPathPointList = pathList;
                    Plugin.LogMsg($"cfa: {callsign} FlyApproachPathPointList overwritten ({pathList.Count} pts)");
                }
                else
                    Plugin.LogMsg($"cfa: {callsign} step 4b: params NOT FlyApproachDynamicsParams (class 0x{dpOb.ObjectClass.ToInt64():X}) — fly-path overwrite skipped");
            }
            catch (Exception ex)
            {
                Plugin.LogMsg($"cfa: {callsign} step 4b FAILED: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // The ACTIVE state instance carries its OWN captured copy too
        // (FlyApproachState._flyApproachPathPointList — Init-copied when the
        // state was activated at level load). A revert back to FlyApproach
        // continues from THAT copy, not from the params object. Align it with
        // the approach procedure as well. (The state instances are exposed
        // fields on Dynamics — reachable directly, no interface proxy.)
        var flyState = ac._dynamics?._flyApproachState;
        if (flyState != null)
        {
            try
            {
                flyState._flyApproachPathPointList = pathList;
                Plugin.LogMsg($"cfa: {callsign} FlyApproachState._flyApproachPathPointList overwritten ({pathList.Count} pts)");
            }
            catch (Exception ex)
            {
                Plugin.LogMsg($"cfa: {callsign} fly-state write FAILED: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // 5) Plant the params through the game's serialized channel — the same
        //    data flow the level loader uses (AircraftDynamicsData → dynamics).
        //    (The DynamicsState enum write moved to step 6c, AFTER the
        //    transition attempts: live log 2026-08-03 showed a pre-set enum +
        //    gated fires = a HALF-transition — enum Approaching while the
        //    ACTIVE STATE object stayed FlyApproachState — and the readback
        //    (IsInState / dynState=) then lied about it. The enum should
        //    reflect the transition, not pre-empt it.)
        dp.DynamicsParams = p;
        _plantedParams[ac] = p.Pointer;                   // for the per-step replant diff
        // Speed: raw knots (the game's own ApproachSpeedKts scale — the m/s
        // write drove state integration at ~half speed, see OnAircraftStep).
        // speedKnots <= 0 = "not given" → leave the aircraft's speed untouched.
        if (speedKnots > 0f)
        {
            dp.TaxiSpeed = speedKnots;
            dp.TargetTaxiSpeed = speedKnots;
            if (ac.TaxiSpeed != null) ac.TaxiSpeed.Value = speedKnots;
            if (ac.AirSpeedKnot != null) ac.AirSpeedKnot.Value = speedKnots;
        }
        dp.ForwardSpeed = true;
        dp.PositiveTaxiAcceleration = 1f; dp.NegativeTaxiAcceleration = -2f;   // ACL constants

        // 6) Fire the game's own transitions. The aircraft-level machine's
        //    Fly→Approach transition is gated by FlyToApproachCondition; the
        //    game's own command API (CommandContinueApproach — the "continue
        //    approach" handoff) is the canonical entry that respects the
        //    gate, so try it FIRST, then the direct fires as fallback (any
        //    of them may drive the other — or none may stick, which is
        //    exactly what the AFTER dump is for). Each attempt is logged.
        //
        //    useNative=false (frame flag `native=0`, 5th field): skip
        //    CommandContinueApproach entirely. Its deferred flow (radio
        //    chatter ~3 s + "Dynamics: restore runtime data: FlyApproaching"
        //    right after the patch — Dynamics.RestoreRuntimeData()) is the
        //    prime suspect for the observed revert back to the STAR; the
        //    direct fires alone produce the same transition (verified live:
        //    AFTER dump shows Appr(5)/Approaching). Test both modes with the
        //    1 s tracer to see which one sticks.
        if (useNative)
        {
            try { ac.CommandContinueApproach(); Plugin.LogMsg($"cfa: {callsign} CommandContinueApproach → ok"); }
            catch (Exception ex) { Plugin.LogMsg($"cfa: {callsign} CommandContinueApproach FAILED: {ex.GetType().Name}: {ex.Message}"); }
        }
        else Plugin.LogMsg($"cfa: {callsign} CommandContinueApproach SKIPPED (native=0)");
        if (ac.IsInState(EAircraftState.Fly))
        {
            try { ac._stateMachine.Fire(EAircraftTrigger.Approach); Plugin.LogMsg($"cfa: {callsign} Fire(Approach) → ok"); }
            catch (Exception ex) { Plugin.LogMsg($"cfa: {callsign} Fire(Approach) FAILED: {ex.GetType().Name}: {ex.Message}"); }
        }
        if (ac._dynamics.CurrentState != State.Approaching)
        {
            try { ac._dynamics.FlyApproach2Approach(); Plugin.LogMsg($"cfa: {callsign} FlyApproach2Approach → ok"); }
            catch (Exception ex) { Plugin.LogMsg($"cfa: {callsign} FlyApproach2Approach FAILED: {ex.GetType().Name}: {ex.Message}"); }
        }

        // 6b) The state machine's ACTIVE state holds its own copies
        //     (ApproachState._runtimeData + _pathPointList — Init-captured
        //     when the state was activated). The game's path-following
        //     (ApproachState.Update) reads THOSE, not the aircraft's data
        //     channel — if the transition activated with stale params (e.g. a
        //     trigger instance captured at level load), the aircraft keeps
        //     flying the STAR's captured path even though the data channel
        //     shows our approach. Read the active state and rewrite its
        //     copies when they don't match our path.
        if (ac._dynamics != null && ac._dynamics._currentState is Il2CppObjectBase curOb)
        {
            try
            {
                if (curOb.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                {
                    var st = new ApproachState(curOb.Pointer);
                    bool mismatch = st._pathPointList == null || st._pathPointList.Count != pathList.Count
                        || (st._pathPointList.Count > 0
                            && (st._pathPointList[0] != pathList[0]
                                || st._pathPointList[st._pathPointList.Count - 1] != pathList[pathList.Count - 1]));
                    Plugin.LogMsg($"cfa: {callsign} state check: ApproachState stPath={ParamTrace.ListSummary(st._pathPointList)} stPr={st.GetProgressRatio():F3} — {(mismatch ? "MISMATCH — rewriting" : "matches our path")}");
                    if (mismatch)
                    {
                        st._pathPointList = pathList;
                        if (st._runtimeData != null) st._runtimeData = p;
                        Plugin.LogMsg($"cfa: {callsign} ApproachState._pathPointList + _runtimeData rewritten ({pathList.Count} pts)");
                    }
                }
                else if (curOb.ObjectClass == Il2CppClassPointerStore<FlyApproachState>.NativeClassPtr)
                {
                    // Live 2026-08-03: the transition NEVER activates the state
                    // OBJECT. The fires flipped the enum (dyn.CurrentState →
                    // Approaching — the AFTER dump read Appr(5)/Approaching)
                    // but `_currentState` stayed FlyApproachState through all
                    // 90 watch steps: the game's Fly→Approach transition is
                    // gated by FlyToApproachCondition (the aircraft must be at
                    // the STAR's transition point; ours was mid-STAR at
                    // pr=0.68), so the fires' transition was silently dropped.
                    // The aircraft then flew a degenerate FlyApproachState (our
                    // overwritten 3-pt path + frozen pr=0.682 — stall, then
                    // south-east drift), and the channel carried whatever the
                    // ACTIVE state re-plants each step (`params-replant: …
                    // ← FlyApproachDynamicsParams` at watch step 0 — the state
                    // owns the channel's params, which is why our
                    // ApproachDynamicsParams lived < 1 step).
                    //
                    // Bypass the gate via the CANONICAL transition entry — the
                    // game's own SetCurrentState(IDynamicState, IDynamicsParams),
                    // which every real transition flows through and Inits the
                    // activated state from the params; the gate is upstream of
                    // it. Use the dynamics' pre-created ApproachState instance
                    // (the sibling of _flyApproachState) — a genuine game
                    // object, nothing minted. If SetCurrentState itself refuses
                    // (it shouldn't — it's the canonical entry), last resort is
                    // a direct `_currentState` field force + captured-copy
                    // rewrite (the interop stub exposes the field as a public
                    // property with a setter). Every path is logged.
                    Plugin.LogMsg($"cfa: {callsign} state check: STILL FlyApproachState — the transition did not take (gate) — attempting SetCurrentState bypass");
                    var dyn2 = ac._dynamics;
                    ApproachState apprSt = dyn2 != null ? dyn2._approachState : null;
                    if (apprSt != null)
                    {
                        try
                        {
                            Plugin.LogMsg($"cfa: {callsign} bypass: _approachState stPath={ParamTrace.ListSummary(apprSt._pathPointList)} stPr={apprSt.GetProgressRatio():F3} — calling SetCurrentState(_approachState, planted params)");
                            // Interface-proxy gotcha (the same one everywhere in
                            // this project): the stub's concrete states do NOT
                            // cast to IDynamicState — the interface has its own
                            // interop wrapper class. Wrap the native pointer in
                            // it (the game's native side only sees the pointer).
                            dyn2.SetCurrentState(new IDynamicState(apprSt.Pointer), p);
                            if (dyn2._currentState is Il2CppObjectBase cur2
                                && cur2.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                            {
                                var st2 = new ApproachState(cur2.Pointer);
                                bool mismatch2 = st2._pathPointList == null || st2._pathPointList.Count != pathList.Count
                                    || (st2._pathPointList.Count > 0
                                        && (st2._pathPointList[0] != pathList[0]
                                            || st2._pathPointList[st2._pathPointList.Count - 1] != pathList[pathList.Count - 1]));
                                Plugin.LogMsg($"cfa: {callsign} bypass: SetCurrentState → ApproachState stPath={ParamTrace.ListSummary(st2._pathPointList)} stPr={st2.GetProgressRatio():F3} — {(mismatch2 ? "MISMATCH — rewriting" : "matches our path")}");
                                if (mismatch2)
                                {
                                    st2._pathPointList = pathList;
                                    if (st2._runtimeData != null) st2._runtimeData = p;
                                    Plugin.LogMsg($"cfa: {callsign} bypass: ApproachState._pathPointList + _runtimeData rewritten ({pathList.Count} pts)");
                                }
                            }
                            else
                            {
                                Plugin.LogMsg($"cfa: {callsign} bypass: SetCurrentState did not stick ({(dyn2._currentState is Il2CppObjectBase curB ? $"state 0x{curB.ObjectClass.ToInt64():X}" : "state ?")}) — forcing _currentState field");
                                dyn2._currentState = new IDynamicState(apprSt.Pointer);
                                apprSt._pathPointList = pathList;
                                if (apprSt._runtimeData != null) apprSt._runtimeData = p;
                                Plugin.LogMsg($"cfa: {callsign} bypass: _currentState forced → ApproachState + captured copies rewritten");
                            }
                        }
                        catch (Exception ex)
                        {
                            Plugin.LogMsg($"cfa: {callsign} bypass FAILED: {ex.GetType().Name}: {ex.Message}");
                        }
                    }
                    else
                    {
                        Plugin.LogMsg($"cfa: {callsign} bypass: Dynamics has no _approachState instance — transition cannot be forced");
                    }
                }
                else
                    Plugin.LogMsg($"cfa: {callsign} state check: state 0x{curOb.ObjectClass.ToInt64():X}");
            }
            catch (Exception ex)
            {
                Plugin.LogMsg($"cfa: {callsign} state check FAILED: {ex.GetType().Name}: {ex.Message}");
            }
        }

        // 6c) Reflect the transition on the serialized channel — AFTER the
        //     fires/bypass, so the gate and the state check saw the true
        //     pre-transition state. If the game's own transition already set
        //     it, this is a no-op; if the bypass forced the state object, this
        //     keeps the AFTER dump's readback (IsInState / dynState=) honest.
        dp.DynamicsState.Value = State.Approaching;       // 2 — ACL's DynamicsState

        // 7) Route label = approach procedure name (ACL parity).
        var name = !string.IsNullOrEmpty(apprName) ? apprName : appr.Name;
        if (!string.IsNullOrEmpty(name))
            ac._route.Value = name;

        // 8) ACL parity: the aircraft now waits for the landing clearance.
        //    (Il2CppStructArray — the interop array type the stub property wants.)
        ac._waitingForCommands.Value =
            new Il2CppStructArray<ECommand>(new[] { ECommand.PermitLanding });   // 22 — game enum, NOT the editor's CMD_* numbers

        // Diagnostics: the post-patch state (both machines + params channel).
        // The BEFORE/AFTER dumps alone end at the patch — the seconds after
        // are the ones that show whether the RNAV holds or the aircraft
        // reverts. Arm the per-step watch (~1.7 s at step resolution) AND the
        // 1 s auto-trace (30 s) so the aftermath ALWAYS lands in the log even
        // if `track|CS` was never sent (previous live test ended at the patch
        // line with zero post-patch visibility).
        _approachWatch[ac] = ApproachWatchBudget;
        ParamTrace.AutoTrack(callsign, 30f);
        Plugin.LogMsg($"patch: auto-track {callsign} (30 s) + step watch armed");
        ParamTrace.DumpNow(callsign, "AFTER");

        return true;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private static AirwayRouteService _routeService;   // cache; invalidate on level switch

    private static AirwayRouteService ResolveAirwayRouteService()
    {
        if (_routeService != null) return _routeService;
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
            if (scope.Container != null && scope.Container.TryResolve(out AirwayRouteService svc))
                return _routeService = svc;
        return null;
    }

    private static Runway GetArrivalRunway(Aircraft ac, AirwayRouteService routes)
    {
        // Assigned runway — but only usable if the route service actually
        // keys it. RunwayReactive can hold a runway RouteDict doesn't
        // (no routes registered, or a different instance than the keys),
        // and GetRoute's dictionary access then throws KeyNotFoundException
        // (live log 2026-08-03). Resolve against the keys by identity/name
        // so the service always receives one of its own instances.
        var rw = ac.RunwayReactive?.CurrentValue;                // assigned runway (public)
        if (rw != null)
        {
            var keyed = FindKeyedRunway(routes, rw.Name, rw.PhysicalName);
            if (keyed != null) return keyed;
        }
        // fallback: flight plan → arrival runway name → registered runway
        var fp = ac._flightPlan;
        var name = fp?.GetRunway(EFlightDirection.Arrival);
        if (string.IsNullOrEmpty(name)) return null;
        return FindKeyedRunway(routes, name, name);
    }

    private static Runway FindKeyedRunway(AirwayRouteService routes, string name, string physicalName)
    {
        if (routes.RouteDict == null) return null;
        foreach (var r in routes.RouteDict.Keys)          // registered runways (RouteDict keys)
            if (r.Name == name || r.PhysicalName == physicalName || r.PhysicalName == name) return r;
        return null;
    }

    private static Runway.Route FindApproachRouteByName(AirwayRouteService routes, Runway runway, string name)
    {
        if (routes.RouteDict != null
            && routes.RouteDict.TryGetValue(runway, out var byType)
            && byType.TryGetValue(AirwayRouteService.RouteType.APP, out var list))
            foreach (var r in list)
                if (r != null && r.Name == name) return r;
        return null;
    }
}

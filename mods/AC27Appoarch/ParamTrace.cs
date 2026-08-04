using System;
using System.Collections.Generic;
using System.Text;
using ContextCross;
using ContextCross.Aircrafts;
using ContextCross.Aircrafts.Enums;
using ContextCross.Dynamics;
using ContextCross.Dynamics.Enums;
using ContextCross.Dynamics.States;
using ContextCross.Enums;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using UnityEngine;

namespace AC27Appoarch;

/// <summary>
/// Per-second parameter tracer for the clear_for_appr handoff (2026-08-03).
/// `track|CS` toggles a 1 s dump of one aircraft's full params: aircraft
/// state (Fly/Approach), dynamics state (FlyApproaching/Approaching), the
/// DynamicsParams object — whichever class it is, with its path lists
/// summarized (STAR tail vs full ILS procedure are distinguishable at a
/// glance) — plus position / heading / speed / route label / waiting
/// commands. The tick runs on a MonoBehaviour because BasePlugin has no
/// Update loop. The patch itself also emits BEFORE/AFTER dumps at command
/// time (OverrideController.clearForApproach), so the log shows the exact
/// transition moment AND the seconds around it.
/// </summary>
public static class ParamTrace
{
    private static readonly HashSet<string> _tracked = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, float> _expiry = new(StringComparer.Ordinal);   // auto-track window (unscaled time)

    /// <summary>Toggle the 1 s trace for one callsign. Returns the new state (true = ON).</summary>
    public static bool ToggleTrack(string callsign)
    {
        if (!_tracked.Remove(callsign)) { _tracked.Add(callsign); _expiry.Remove(callsign); }
        else _expiry.Remove(callsign);
        return _tracked.Contains(callsign);
    }

    /// <summary>Auto-track a callsign for `seconds` — clear_for_appr arms this
    /// so the post-patch seconds ALWAYS land in the log even if the operator
    /// forgets `track|CS` (the previous live test ended at the patch line).</summary>
    public static void AutoTrack(string callsign, float seconds)
    {
        _tracked.Add(callsign);
        _expiry[callsign] = Time.unscaledTime + seconds;
    }

    public static bool IsTracked(string callsign) => _tracked.Contains(callsign);

    /// <summary>The 1 s tick — dump every tracked aircraft (label = elapsed seconds).</summary>
    public static void DumpTracked()
    {
        float now = Time.unscaledTime;
        foreach (var cs in new List<string>(_tracked))
        {
            if (_expiry.TryGetValue(cs, out float exp) && now >= exp)
            {
                _tracked.Remove(cs);
                _expiry.Remove(cs);
                Plugin.LogMsg($"patch: auto-track {cs} ended");
                continue;
            }
            DumpNow(cs, null);
        }
    }

    /// <summary>Dump one aircraft now, with an explicit label ("BEFORE"/"AFTER")
    /// or null for the timed tick line. Never throws into the caller.</summary>
    public static void DumpNow(string callsign, string label)
    {
        try
        {
            var ac = OverrideController.FindByCallsign(callsign);
            if (ac == null)
            {
                Plugin.LogMsg($"trace: {callsign} [{label ?? $"t={Time.unscaledTime:F0}"}] NOT FOUND");
                return;
            }
            Plugin.LogMsg($"trace: {callsign} [{label ?? $"t={Time.unscaledTime:F0}"}] {BuildDump(ac)}");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"trace: {callsign} [{label ?? "tick"}] FAILED: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>Full one-line dump of an aircraft (1 s tracer + watch lines share this).</summary>
    public static string BuildDump(Aircraft ac)
    {
        var sb = new StringBuilder();
        var p = ac.Position;
        sb.Append("pos (").Append(F(p.x)).Append(',').Append(F(p.y)).Append(',').Append(F(p.z)).Append(')');
        sb.Append(" hdg ").Append(OverrideController.GameHeading(ac.Direction).ToString("F0")).Append('°');
        float spd = ac.TaxiSpeed != null ? Convert.ToSingle(ac.TaxiSpeed.Value)
                  : ac.AirSpeedKnot != null ? Convert.ToSingle(ac.AirSpeedKnot.Value)
                  : float.NaN;
        sb.Append(" spd ").Append(spd.ToString("F0")).Append("kt");
        sb.Append(" acState ");
        if (ac.IsInState(EAircraftState.Fly)) sb.Append("Fly(30)");
        else if (ac.IsInState(EAircraftState.Approach)) sb.Append("Appr(5)");
        else sb.Append('?');
        var dyn = ac._dynamics;
        if (dyn != null)
        {
            sb.Append(" dyn=").Append(dyn.CurrentState);
            // Is the aircraft's data channel the SAME object the dynamics'
            // state machine reads (dyn._runtimeData)? If not, writes to
            // ac.DynamicsData never reach the state machine.
            var data = ac.DynamicsData;
            sb.Append(" dataSame=").Append(data != null && dyn._runtimeData != null && data.Pointer == dyn._runtimeData.Pointer ? '1' : '0');
            // The ACTIVE state's own captured copies (ApproachState
            // _pathPointList / FlyApproachState _flyApproachPathPointList —
            // Init-captured at activation). The game's path-following reads
            // THESE, not the data channel — so this is the list the aircraft
            // is actually flying (STAR tail vs full ILS procedure at a glance).
            sb.Append(" st=").Append(DescribeState(dyn));
        }
        else sb.Append(" dyn=<null>");

        var dp = ac.DynamicsData;
        if (dp == null) { sb.Append(" params=<null DynamicsData>"); return sb.ToString(); }
        sb.Append(" dynState=").Append(dp.DynamicsState != null ? dp.DynamicsState.Value.ToString() : "<null>");
        sb.Append(" params=").Append(DescribeParams(dp.DynamicsParams));
        if (ac._route != null) sb.Append(" route=").Append(ac._route.Value);
        var w = ac._waitingForCommands != null ? ac._waitingForCommands.Value : null;
        if (w != null && w.Length > 0)
        {
            sb.Append(" wait=[");
            for (int i = 0; i < w.Length; i++) { if (i > 0) sb.Append(','); sb.Append((int)w[i]); }
            sb.Append(']');
        }
        return sb.ToString();
    }

    /// <summary>The active state machine state + the path list IT follows.
    /// IDynamicState is interface-typed — the same interop proxy gotcha as
    /// IDynamicsParams: identify the concrete class by native class pointer
    /// and re-wrap. For the two flight states the state's own list summary
    /// and progress ratio are included.</summary>
    private static string DescribeState(Dynamics dyn)
    {
        var cur = dyn._currentState;
        if (cur is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                {
                    var s = new ApproachState(ob.Pointer);
                    return $"ApproachState stPath={ListSummary(s._pathPointList)} stPr={s.GetProgressRatio():F3}";
                }
                if (ob.ObjectClass == Il2CppClassPointerStore<FlyApproachState>.NativeClassPtr)
                {
                    var s = new FlyApproachState(ob.Pointer);
                    return $"FlyApproachState stPath={ListSummary(s._flyApproachPathPointList)} stPr={s.GetProgressRatio():F3}";
                }
                return $"state 0x{ob.ObjectClass.ToInt64():X}";
            }
            catch (Exception ex) { return $"state (native? {ex.GetType().Name}: {ex.Message})"; }
        }
        return cur?.GetType().Name ?? "<null>";
    }

    /// <summary>The DynamicsParams object's contents — whichever class it is.
    /// Path lists are summarized (count + first/last) so the before/after of
    /// the patch — STAR path vs full ILS procedure — is visible at a glance.</summary>
    private static string DescribeParams(object p)
    {
        // Interop gotcha (live-verified 2026-08-03): DynamicsData.DynamicsParams
        // is typed IDynamicsParams, and Il2CppInterop wraps the getter's return
        // in the INTERFACE's interop class — GetType().Name is literally
        // "IDynamicsParams" and `is FlyApproachDynamicsParams` / `is
        // ApproachDynamicsParams` never match. The concrete class is identified
        // by its native class pointer (Il2CppObjectBase.ObjectClass vs the
        // interop class store), and the object re-wrapped via its pointer.
        if (p is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachDynamicsParams>.NativeClassPtr)
                {
                    var appr = new ApproachDynamicsParams(ob.Pointer);
                    return $"ApproachDynamicsParams pr={appr.ProgressRatio:F3} path={ListSummary(appr.PathPointList)} init={V(appr.InitialPosition)} tdp={V(appr.TouchDownPosition)} dir={V(appr.ApproachDirection)} goAround={appr.CommandedGoAround}";
                }
                if (ob.ObjectClass == Il2CppClassPointerStore<FlyApproachDynamicsParams>.NativeClassPtr)
                {
                    var fly = new FlyApproachDynamicsParams(ob.Pointer);
                    return $"FlyApproachDynamicsParams pr={fly.ProgressRatio:F3} flyPath={ListSummary(fly.FlyApproachPathPointList)} appPts={ListSummary(fly.AppPointList)}";
                }
                return $"IDynamicsParams (class 0x{ob.ObjectClass.ToInt64():X})";
            }
            catch (Exception ex)
            {
                return $"IDynamicsParams (native? {ex.GetType().Name}: {ex.Message})";
            }
        }
        switch (p)
        {
            case FlyApproachDynamicsParams fly:
                return $"FlyApproachDynamicsParams pr={fly.ProgressRatio:F3} flyPath={ListSummary(fly.FlyApproachPathPointList)} appPts={ListSummary(fly.AppPointList)}";
            case ApproachDynamicsParams appr:
                return $"ApproachDynamicsParams pr={appr.ProgressRatio:F3} path={ListSummary(appr.PathPointList)} init={V(appr.InitialPosition)} tdp={V(appr.TouchDownPosition)} dir={V(appr.ApproachDirection)} goAround={appr.CommandedGoAround}";
            default:
                return p?.GetType().Name ?? "<null>";
        }
    }

    /// <summary>len + first/last of a path list — public for the state-copy check.</summary>
    public static string ListSummary(Il2CppSystem.Collections.Generic.List<Vector3> list)
    {
        if (list == null) return "<null>";
        int n = list.Count;
        if (n == 0) return "len=0";
        var sb = new StringBuilder("len=").Append(n).Append(" f=").Append(V(list[0]));
        if (n > 2) sb.Append(" l=").Append(V(list[n - 1]));
        return sb.ToString();
    }

    private static string V(Vector3 v) => $"({v.x:F1},{v.y:F1},{v.z:F1})";
    private static string F(float x) => x.ToString("F1");
}

/// <summary>MonoBehaviour heartbeat for the 1 s param trace — BasePlugin has no Update loop.</summary>
public class TracerBehaviour : MonoBehaviour
{
    private float _nextDump;

    private void Update()
    {
        if (Time.unscaledTime < _nextDump) return;
        _nextDump = Time.unscaledTime + 1f;
        ParamTrace.DumpTracked();
    }
}

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

    /// <summary>Toggle the 1 s trace for one callsign. Returns the new state (true = ON).</summary>
    public static bool ToggleTrack(string callsign)
    {
        if (!_tracked.Remove(callsign)) _tracked.Add(callsign);
        return _tracked.Contains(callsign);
    }

    public static bool IsTracked(string callsign) => _tracked.Contains(callsign);

    /// <summary>The 1 s tick — dump every tracked aircraft (label = elapsed seconds).</summary>
    public static void DumpTracked()
    {
        foreach (var cs in new List<string>(_tracked))
            DumpNow(cs, null);
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
            sb.Append(" st=").Append(DescribeState(dyn, p));
        }
        else sb.Append(" dyn=<null>");

        var dp = ac.DynamicsData;
        if (dp == null) { sb.Append(" params=<null DynamicsData>"); return sb.ToString(); }
        sb.Append(" dynState=").Append(dp.DynamicsState != null ? dp.DynamicsState.Value.ToString() : "<null>");
        // Data-channel speed fields (2026-08-04): the crawl diagnostic — the
        // aircraft-level `spd` read above does NOT reflect these; the approach
        // path-following speed comes from the channel (prime suspect: kts-less
        // frames left them unset → the ~1-4 u/s crawl instead of 240 kt).
        sb.Append(" chTs=").Append(F(dp.TaxiSpeed));
        sb.Append(" chTts=").Append(F(dp.TargetTaxiSpeed));
        sb.Append(" chDTts=").Append(F(dp.DynamicsTargetTaxiSpeed));
        sb.Append(" chFwd=").Append(dp.ForwardSpeed);
        sb.Append(" params=").Append(DescribeParams(dp.DynamicsParams));
        if (ac._route != null) sb.Append(" route=").Append(ac._route.Value);
        var w = ac._waitingForCommands != null ? ac._waitingForCommands.Value : null;
        if (w != null && w.Length > 0)
        {
            sb.Append(" wait=[");
            for (int i = 0; i < w.Length; i++) { if (i > 0) sb.Append(','); sb.Append((int)w[i]); }
            sb.Append(']');
        }
        // Radio channels (2026-08-03): Type/PK of the aircraft's two channel
        // slots — the jurisdiction handoff's proof and re-assert detector
        // (AFTER shows rc=Approach/… jrc=Tower/…; a jrc flip back names the
        // culprit flow via the log line before it).
        var rc = ac._radioChannel != null ? ac._radioChannel.Value : null;
        var jrc = ac._jurisdictionRadioChannel != null ? ac._jurisdictionRadioChannel.Value : null;
        sb.Append(" rc=").Append(rc != null ? rc.Type + "/" + rc.PK : "<null>");
        sb.Append(" jrc=").Append(jrc != null ? jrc.Type + "/" + jrc.PK : "<null>");
        return sb.ToString();
    }

    /// <summary>The active state machine state + the path list IT follows.
    /// IDynamicState is interface-typed — the same interop proxy gotcha as
    /// IDynamicsParams: identify the concrete class by native class pointer
    /// and re-wrap. For the two flight states the state's own list summary
    /// and progress ratio are included; `pos` (the aircraft's position) feeds
    /// the ApproachState hold diagnostics (2026-08-04).</summary>
    private static string DescribeState(Dynamics dyn, Vector3 pos)
    {
        var cur = dyn._currentState;
        if (cur is Il2CppObjectBase ob)
        {
            try
            {
                if (ob.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                {
                    var s = new ApproachState(ob.Pointer);
                    return $"ApproachState stPath={ListSummary(s._pathPointList)} stPr={s.GetProgressRatio():F3}{ApproachStateDiag(s, pos)}";
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
    /// the patch — STAR path vs full ILS procedure — is visible at a glance.
    /// Public for the state-check verdict line (state vs channel in one log).</summary>
    public static string DescribeParams(object p)
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

    /// <summary>ApproachState hold diagnostics (2026-08-04): the Init-derived
    /// copies and the 2-D vs 3-D distance from the aircraft to BOTH path[0]
    /// surfaces — the gate-target discriminator. stA0 near 0/15 while rtA0 is
    /// large = the gate reads the runtime-data path (stale 5-pt); both near
    /// 0/15 = join-leg tracking working. afm fields are diagnostic-only
    /// (AircraftFlightMetrics is Init-built from the flight plan — not
    /// rebuildable from the plugin). Public for the state-check verdict line.
    /// Never throws — returns "" on any interop failure.</summary>
    public static string ApproachStateDiag(ApproachState st, Vector3 acPos)
    {
        try
        {
            var sb = new StringBuilder();
            sb.Append(" stInit=").Append(V(st._initialPosition));
            sb.Append(" stSP=").Append(st.startingProgress.ToString("F3"));
            var lp = st._pathPointList;
            if (lp != null && lp.Count > 0) sb.Append(" stA0=").Append(Dist2(acPos, lp[0])).Append('/').Append(Dist3(acPos, lp[0]));
            var rd = st._runtimeData;
            if (rd != null && rd.PathPointList != null && rd.PathPointList.Count > 0)
                sb.Append(" rtA0=").Append(Dist2(acPos, rd.PathPointList[0])).Append('/').Append(Dist3(acPos, rd.PathPointList[0]));
            if (st.afm != null)
            {
                sb.Append(" afmRem=").Append(st.afm.RemainingDistance.ToString("F1"));
                try { sb.Append(" afmAppT=").Append(st.afm._appRouteTime); } catch { sb.Append(" afmAppT=?"); }
            }
            return sb.ToString();
        }
        catch { return ""; }
    }

    private static string Dist2(Vector3 a, Vector3 b) => Mathf.Sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)).ToString("F1");
    private static string Dist3(Vector3 a, Vector3 b) => Vector3.Distance(a, b).ToString("F1");

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

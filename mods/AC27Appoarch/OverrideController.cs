using System;
using System.Collections.Generic;
using System.Linq;
using ContextCross;
using ContextCross.Aircrafts;
using ContextCross.Clock;
using ContextCross.Aircrafts.Enums;
using ContextCross.Dynamics;
using ContextCross.Dynamics.Enums;
using ContextCross.Dynamics.States;
using ContextCross.Enums;
using ContextCross.Managers;
using ContextCross.Models;
using ContextCross.Radio;
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
        public Vector3 Direction;      // COMMANDED heading — normalized; zero = no heading command
        public Vector3 Current;        // smoothed intermediate heading — what is actually written each tick
        public float TurnRateDeg;      // nose rotation rate, °/GAME-second; <= 0 = INSTANT (pre-smoothing behavior)
        public int StepCount;          // diagnostics: sample the first ~0.5 s of override
        public Aircraft3D View;        // cached visible view (diagnostics)
        public bool CfaFollow;         // v6: clear_for_appr bounded de-snap — nose tracks path[0] at rate while pre-capture
        public Vector3 Path0;          // v6: approach path start (the IAF) — the de-snap target + release gate
        public float TargetKts;        // v6: commanded approach speed — the pre-capture AVC target lift
        public int CfaTicks;           // v6: de-snap step counter (10 s hard cap)
        public int RescheduleLogs;     // v7: per-tick reschedule re-assert log spam guard (first 3, then every 30th)
        public Vector3 GameIntended;   // v8-d: the game's own steering output (path tangent), stashed per tick by CommandedDirection
        public float AltTargetFt;      // COMMANDED altitude, ft; <= 0 = no altitude command (nothing written)
        public float AltCurrentFt;     // smoothed intermediate altitude, ft — what is actually written each tick
        public float AltRateFpm;       // vertical rate, ft/GAME-minute; <= 0 = INSTANT (seeded at the command)
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

    // Approach watch: per-step diag for the first ~3.3 s after a
    // clear_for_appr patch (200 steps — longer than the ~3 s deferred
    // CommandContinueApproach radio-chatter window) — the critical window
    // where the aircraft either turns onto the ILS or keeps flying the STAR.
    // Value = steps remaining.
    private const int ApproachWatchBudget = 200;
    private static readonly Dictionary<Aircraft, int> _approachWatch = new();

    // v8-d post-release observation: 5 s (300 steps) after the de-snap
    // releases, log the game-owned nose motion every 10 steps — the overshoot
    // the user sees ("overshoot the turning direction, have to turn back")
    // happens AFTER the release (the 21:08 CSN2197 log ends at the release
    // line — the window is unobserved), and it must be captured before any
    // fix is designed. Value = steps remaining.
    private const int PostReleaseBudget = 300;
    private static readonly Dictionary<Aircraft, int> _postRelease = new();

    // Replant detection: the data channel's DynamicsParams pointer WE planted
    // (per aircraft). The setter is an IL2CPP field accessor — unpatchable by
    // both Harmony backends — and the game's native C++ writes the field
    // directly, bypassing the managed stub entirely. The only way to see a
    // re-plant is to diff the pointer every step while the aircraft is
    // tracked (the post-patch window) — catches native direct writes too.
    private static readonly Dictionary<Aircraft, IntPtr> _plantedParams = new();

    // v6 de-snap (clear_for_appr): release when the aircraft reaches the join
    // window (~1 s out at 240 kt — the game's tangent steering then owns the
    // final turn at the IAF) or the hard cap. v9 (2026-08-04): the on-aim
    // release is GONE — the 21:36 post-release evidence (live CCA4851: the
    // game's re-engagement line-capture swung the nose 253.3° → 232.5° — 21°
    // PAST the IAF bearing at its max ~23°/s, then τ≈5 s back) proved the
    // game's steering executes its capture turn whenever it re-takes the nose
    // while the aircraft is far off the path line — the on-aim release handed
    // over at ~700 u. The cap covers the crawl-speed closure (700 u at the
    // broken-STAR pace 1.24 u/s = 33.8k ticks at ×1; 11.4k at ×3) — the cap is
    // the safety net, the join window is the normal release.
    private const float CfaJoinDist = 120f;
    private const int CfaDeSnapCap = 36000;

    // v7 (2026-08-04): the game's own clock — the speed multiplier lives in
    // ContextCross.Clock.GameTime (TimeScale / IsPaused / FixedDeltaTime),
    // NOT Unity's Time.timeScale (which reads 1 at any game speed — the
    // CES5578 ×10 slow-turn log: 0.048°/step = the unscaled 3°/s).
    // v7 correction: GameTime.Delta is NOT usable — it read 0.00000 s/tick
    // live with the sim running (v6 log line 4); treat it as a stubbed
    // getter. TimeScale (live field — 1.0 at ×1) × FixedDeltaTime (the
    // dump's 1/60) IS the true per-tick advanced game time: 1/60 at ×1,
    // 1/6 at ×10, 0 while paused (IsPaused gate). Every rate-driven motion
    // steps by rate × dt, so a turn completes in the same GAME time at any
    // speed multiplier and freezes on pause. Resolved lazily from any
    // aircraft's afm (AircraftFlightMetrics._gameTime — every aircraft has
    // one; the same object the states' afm fields reference); VContainer
    // TryResolve as fallback (same pattern as ResolveAirwayRouteService).
    // The UDP telemetry header mirrors TimeScale as timeScale (offset 33) /
    // simFlags bit 0 = isPaused — the in-process clock is authoritative.
    private static GameTime GameClock;
    private static bool _clockLogged;
    private static bool _clockFailLogged;   // v8-d: one failure line when the resolution scans find nothing

    private static float GameDt()
    {
        if (GameClock == null)
        {
            foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
            {
                var src = v.Source;
                if (src != null && src._dynamics != null && src._dynamics.AircraftFlightMetrics != null
                    && src._dynamics.AircraftFlightMetrics._gameTime != null)
                {
                    GameClock = src._dynamics.AircraftFlightMetrics._gameTime;
                    break;
                }
            }
            if (GameClock == null)
                foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
                    if (scope.Container != null && scope.Container.TryResolve(out GameTime gt))
                    {
                        GameClock = gt;
                        break;
                    }
        }
        if (!_clockLogged && GameClock != null)
        {
            _clockLogged = true;
            // v7: Delta is diagnostic only (stubbed getter — 0.00000 live);
            // TimeScale × FixedDeltaTime is the operative dt. The ×10 test
            // must read TimeScale 10.0; the pause test IsPaused True.
            Plugin.LogMsg($"game-time: clock resolved — Delta {GameClock.Delta:F5} s/tick (stubbed — unused), TimeScale {GameClock.TimeScale:F1}, FixedDeltaTime {GameTime.FixedDeltaTime:F5} s, IsPaused {GameClock.IsPaused}");
        }
        if (!_clockFailLogged && GameClock == null)
        {
            // v8-d: the 21:08 CSN2197 log has NO clock line at all — the scans
            // found no resolvable clock and the fallback was operative (the
            // 0.146°/tick rotation ≈ 3°/s × 1/60 × 3 proves the fallback's
            // Time.timeScale read 3 at game ×3). Log the fallback's dt once so
            // the next test shows which clock path ran.
            _clockFailLogged = true;
            float fb = Time.fixedDeltaTime * Mathf.Max(0f, Time.timeScale);
            Plugin.LogMsg($"game-time: clock NOT resolved — fallback dt={fb:F5} s/tick (fixedDeltaTime {Time.fixedDeltaTime:F5} × timeScale {Time.timeScale:F1})");
        }
        if (GameClock != null)
        {
            try
            {
                // v7: TimeScale (live field) × GameTime.FixedDeltaTime (STATIC
                // constant 1/60 — the compiler enforces type access, so no
                // stubbed-getter risk) = the true per-tick advanced game
                // time — 1/60 at ×1, 1/6 at ×10, 0 while paused (the
                // IsPaused gate is a belt-and-suspenders — Aircraft.Step may
                // not even fire while paused).
                float dt = GameTime.FixedDeltaTime * GameClock.TimeScale;
                if (GameClock.IsPaused) dt = 0f;
                return Mathf.Max(0f, dt);
            }
            catch { GameClock = null; }   // per-level service — a stale cache across level switches re-resolves
        }
        return Time.fixedDeltaTime * Mathf.Max(0f, Time.timeScale);
    }

    // ── altitude constants (2026-08-04) ──────────────────────────────────
    // Conversion (user-confirmed): 1 GU = 100 m → ft = y × 100/0.3048 ≈
    // y × 328.084; GU = ft × 0.003048. Sanity: Y = 15.24 GU = 5000 ft (the
    // game's approach ceiling — the same 15.24 clearForApproach's
    // InitialPosition uses).
    internal const float FeetPerGameUnit = 100f / 0.3048f;   // ≈ 328.08399
    private const float GameUnitPerFoot = 0.3048f / 100f;    // = 0.003048
    private const float DefaultAltRateFpm = 1000f;           // plugin default when the frame omits rate

    /// <summary>Unified patch API: "update_heading" | "update_position" (legacy) | "clear_for_appr" | "altitude".</summary>
    public static bool PatchAircraft(string commandType, string callsign,
                                     Vector3 direction = default, float speedKnots = 0f,
                                     string apprName = null, bool useNative = true,
                                     float turnRateDeg = 0f, float altTargetFt = 0f, float altRateFpm = 0f)
    {
        switch (commandType)
        {
            case "update_heading":  return patchHeading(callsign, direction, turnRateDeg);
            case "update_position": return patchHeading(callsign, direction, turnRateDeg);   // legacy alias (kts ignored)
            case "clear_for_appr":  return clearForApproach(callsign, speedKnots, apprName, useNative, turnRateDeg);
            case "altitude":        return patchAltitude(callsign, altTargetFt, altRateFpm);
            default:                return false;
        }
    }

    // ── update_heading: heading-only override (report §4.3) ──────────────

    /// <summary>Force the aircraft's nose to `direction`. Position and speed
    /// stay 100% the game's — the dynamics keeps flying the aircraft's own
    /// route at its own speed; only the heading (property / reactive /
    /// rotation channels + visible nose) is overridden.
    /// `turnRateDeg` > 0 rotates the nose smoothly at that many °/GAME-second
    /// (respects the game's speed multiplier and pauses with it — see
    /// OnAircraftStep); <= 0 (omitted) snaps instantly — the pre-smoothing
    /// behavior.</summary>
    public static bool patchHeading(string callsign, Vector3 direction, float turnRateDeg = 0f)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // Before-state: what the game had running before the override.
        // Heading uses the game's own convention (UI shows atan2(dir.x, dir.z) in °).
        float bHdg = HeadingDeg(ac.Direction);
        float bSpd = ac.AirSpeedKnot != null ? Convert.ToSingle(ac.AirSpeedKnot.Value) : 0f;

        var cmd = direction.sqrMagnitude > 1e-6f ? direction.normalized : Vector3.zero;

        // Smooth-turn start pose (2026-08-03): seed Current from where the nose
        // ACTUALLY points so the rotation starts from the real heading — the
        // aircraft's own motion has been writing ac.Direction up to this tick.
        // Mid-turn re-commands keep the existing entry's Current: the aircraft
        // simply re-targets and keeps rotating from its intermediate heading.
        // Instant mode (rate <= 0 / omitted — the pre-smoothing contract) MUST
        // seed Current AT the command: with Current left at the old heading and
        // RotateTowards maxDelta <= 0 the nose would never converge — frozen.
        Vector3 current = cmd;
        _overrides.TryGetValue(ac, out var existing);
        if (turnRateDeg > 0f)
        {
            if (existing != null && existing.Current.sqrMagnitude > 1e-6f)
                current = existing.Current;                             // mid-turn re-command — continue from here
            else if (ac.Direction.sqrMagnitude > 1e-6f)
                current = ac.Direction.normalized;                      // fresh command — start from the real nose
        }

        // Mutate-in-place (2026-08-04): a heading command must not disturb an
        // active climb/descend-and-maintain — the altitude channels
        // (AltTargetFt/AltCurrentFt/AltRateFpm) survive on the existing entry.
        var e = existing != null ? existing : new Entry();
        e.Direction = cmd;
        e.Current = current;
        e.TurnRateDeg = turnRateDeg;
        _overrides[ac] = e;

        // After-state: what the override commands. Speed and position are not
        // touched — the game keeps them; the aircraft flies its own route at
        // its own speed, pointing at the commanded heading.
        float aHdg = HeadingDeg(e.Direction);
        Plugin.LogMsg($"override: {callsign} before hdg {(bHdg < 0f ? "n/a" : bHdg + "°")} spd {bSpd:F0} kt → after hdg {(aHdg < 0f ? "none (game's own)" : aHdg + "°")} rate {turnRateDeg:F0}°/s (heading-only — game keeps position & speed)");
        return true;
    }

    // ── altitude: climb/descend-and-maintain override (2026-08-04) ───────

    /// <summary>Force the aircraft's Y toward `targetFt` (feet). X/Z, heading,
    /// speed, and route stay 100% the game's — the aircraft keeps flying its
    /// own lateral path at its own speed; only the vertical position (model Y
    /// + HeightFeet readout + visible view Y) is overridden. `rateFpm` > 0
    /// moves the altitude smoothly at that many ft/GAME-minute (GameDt-scaled
    /// — the same game-time rule as the heading turn, frozen while paused);
    /// <= 0 (omitted) uses DefaultAltRateFpm (1000). targetFt <= 0 / NaN is
    /// invalid and rejected.</summary>
    public static bool patchAltitude(string callsign, float targetFt, float rateFpm = 0f)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // NaN parses fine and compares false to everything — `<= 0` alone
        // would let it through; reject explicitly. +Infinity converges in one
        // tick (≈ instant).
        if (targetFt <= 0f || float.IsNaN(targetFt))
        {
            Plugin.LogMsg($"override: {callsign} altitude REJECTED — target {targetFt} ft is not a valid altitude (> 0)");
            return false;
        }

        // Before-state: the game's own altitude at patch receipt (same channel
        // the editor telemetry derives ft from — position.y).
        float bAltFt = ac.Position.y * FeetPerGameUnit;

        float rate = rateFpm > 0f ? rateFpm : DefaultAltRateFpm;

        // Smooth-vertical start pose: seed AltCurrentFt from where the aircraft
        // ACTUALLY is — the game's own motion has been writing position.y up to
        // this tick. Mid-transition re-commands keep the existing entry's
        // AltCurrentFt: the aircraft re-targets and keeps moving from its
        // intermediate altitude (mirror patchHeading).
        float currentFt = bAltFt;
        if (_overrides.TryGetValue(ac, out var existing) && existing.AltTargetFt > 0f)
            currentFt = existing.AltCurrentFt;

        // Mutate-in-place: a heading override (Direction) or a cfa de-snap
        // (CfaFollow) keeps running — only the altitude channels change.
        var e = existing != null ? existing : new Entry();
        e.AltTargetFt = targetFt;
        e.AltCurrentFt = currentFt;
        e.AltRateFpm = rate;
        _overrides[ac] = e;

        Plugin.LogMsg($"override: {callsign} before alt {bAltFt:F0} ft → after alt {targetFt:F0} ft rate {rate:F0} ft/min (X/Z + heading stay the game's)");
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

        // The override only touched the heading/altitude channels — the game
        // resumes writing them on the next tick, nothing else needs restoring.
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

        // Approach watch: per-step diag for the first ~3.3 s after a
        // clear_for_appr patch (steps 0,10,20,...,190). Same dump shape as the
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
        // changes. Diff it every step while tracked OR under the approach watch
        // (post-patch window; the watch outlives the deferred ~3 s flow);
        // log the moment it changes, with WHICH params took its place.
        if (ac.DynamicsData != null
            && _plantedParams.TryGetValue(ac, out IntPtr planted)
            && (ParamTrace.IsTracked(ac.CallSign) || _approachWatch.ContainsKey(ac)))
        {
            var cur = ac.DynamicsData.DynamicsParams;
            IntPtr curPtr = cur is Il2CppObjectBase curOb ? curOb.Pointer : IntPtr.Zero;
            if (curPtr != planted)
            {
                Plugin.LogMsg($"params-replant: {ac.CallSign} DynamicsParams ← {ReplantName(cur)} (was 0x{planted.ToInt64():X}, now 0x{curPtr.ToInt64():X})");
                _plantedParams[ac] = curPtr;               // log each distinct re-plant once
            }
        }

        // v8-d post-release observer: the de-snap release removes the override
        // and the game owns the heading from there — but the 200-step approach
        // watch ends BEFORE the release can fire (live CSN2197: release at
        // ~tick 400, watch ended at 190), so the game-owned window is dark.
        // Log the actual nose motion + position + speed for 5 s after a
        // release — the overshoot evidence.
        if (_postRelease.TryGetValue(ac, out int prLeft))
        {
            int prDone = PostReleaseBudget - prLeft;
            _postRelease[ac] = prLeft - 1;
            if (prLeft - 1 <= 0) _postRelease.Remove(ac);
            if (prDone % 10 == 0)
            {
                float spd = -1f;
                var view = FindView3D(ac);
                var rb = view != null ? view.GetComponent<Rigidbody>() : null;
                if (rb != null) spd = rb.velocity.magnitude;
                var p = ac.Position;
                Plugin.LogMsg($"cfa: {ac.CallSign} post-release: hdg {HeadingDeg(ac.Direction):F1}° pos ({p.x:F1},{p.z:F1}) rbVel {spd:F2}");
            }
        }

        if (!_overrides.TryGetValue(ac, out var e)) return;

        // v6 (2026-08-04) CLEAR_FOR_APPR bounded de-snap: while the aircraft
        // is pre-capture (ahead of path[0]), rotate the nose at the frame's
        // rate toward the approach path start — the IAF — which IS the game's
        // own pre-capture steering aim (zero fight; without this the game's
        // easing sweeps the nose at ~35°/s — the CJX2697 fast-turn log), and
        // re-lift the AVC target speed to the commanded knots every tick (the
        // OPERATIVE speed target — the approach state leaves the stale STAR
        // pace ~2.4 kt in place until capture, so the aircraft otherwise
        // crawls at ~1.24 u/s — live CJX2697). v9 (2026-08-04): released ONLY
        // on capture (dist to path[0] < ~1 s at 240 kt — the game's tangent
        // steering takes over and flies the final turn at the IAF) or the cap
        // — the on-aim release is GONE (the 21:36 evidence: the game's
        // re-engagement line-capture swung the nose 21° PAST the IAF bearing
        // when the handover happened ~700 u out — see the CfaDeSnapCap
        // comment). The de-snap holds the IAF bearing while the aircraft
        // closes; a reverted/go-around aircraft (no longer in the approach
        // state) drops the override immediately instead of holding for the
        // (now 60× longer) cap. Release = remove from _overrides — the game
        // owns the heading from there.
        if (e.CfaFollow)
        {
            e.CfaTicks++;
            // v7: per-tick reschedule re-assert — the transition finalize
            // rebuilds the flight model ONCE (afm _shouldUpdateMetaData →
            // Update() re-derives plan + _appRouteTime from the level
            // schedule; live CCA4851: the 6b2 dispatch shift read 00:00:11.7
            // in the AFTER dump, back at 00:07:55.867 by watch step 0), so
            // the dispatch-time shift alone is clobbered. Re-assert while
            // pre-capture; the idempotent guard (ETA > newEta + 5 s) makes
            // it fire once after the rebuild, then stay silent.
            RescheduleEta(ac, e.TargetKts, "per-tick", e);
            // v9 state guard: the de-snap must not hold a nose the game no
            // longer wants pointed — a reverted / go-around aircraft (the
            // transition half-failed or the game flipped it back to the STAR)
            // leaves the approach state; drop the override immediately (the
            // cap is now 36k ticks — the old 10 s cap masked this).
            if (ac._dynamics != null && ac._dynamics.CurrentState != State.Approaching)
            {
                _overrides.Remove(ac);
                Plugin.LogMsg($"cfa: {ac.CallSign} de-snap dropped (state → {ac._dynamics.CurrentState}) — the aircraft left the approach state");
                return;
            }
            var pos = ac.Position;
            Vector3 aim = new Vector3(e.Path0.x - pos.x, 0f, e.Path0.z - pos.z);
            float dist = aim.magnitude;
            // v8-d de-snap diag: every 10 ticks, the nose vs OUR aim vs the
            // game's own steering output (stashed by CommandedDirection) — the
            // sweep evidence: Δ ≈ 0 through the hold = the zero-fight claim
            // holds; Δ growing = the game's own turn starts, and toward WHAT
            // heading. The release-time behavior must be observed, not assumed.
            if (e.CfaTicks % 10 == 0)
            {
                bool aimOk = dist > 1e-4f;
                float gameHdg = e.GameIntended.sqrMagnitude > 1e-6f ? HeadingDeg(e.GameIntended) : -1f;
                float delta = aimOk && e.GameIntended.sqrMagnitude > 1e-6f
                    ? Vector3.Angle(aim.normalized, e.GameIntended) : -1f;
                Plugin.LogMsg($"cfa: {ac.CallSign} de-snap diag: hdg {HeadingDeg(e.Current):F1}° aim(IAF) {(aimOk ? HeadingDeg(aim.normalized) : -1f):F1}° game {gameHdg:F1}° Δ {delta:F1}° dist {dist:F0}");
            }
            if (dist < CfaJoinDist || e.CfaTicks >= CfaDeSnapCap)
            {
                _postRelease[ac] = PostReleaseBudget;   // v8-d: observe the game-owned nose for 5 s
                _overrides.Remove(ac);
                Plugin.LogMsg($"cfa: {ac.CallSign} de-snap released ({(dist < CfaJoinDist ? "captured" : "cap")}) — the game's steering owns the heading");
                return;
            }
            e.Direction = aim.normalized;
            if (ac._dynamics?.AVCController != null)
                ac._dynamics.AVCController.SetTargetSpeed(e.TargetKts);
        }

        // HEADING-ONLY override: force the nose to the (smoothed) commanded
        // heading. Position and speed are 100% the game's — the dynamics keeps
        // integrating its own route at its own speed, and the game's own
        // heading write each Step is re-pointed by the set_Direction channel
        // lock. Zero direction = no heading command (nothing is touched).
        if (e.Direction != Vector3.zero)
        {
            // SMOOTH TURN (2026-08-03): rotate the intermediate heading toward
            // the commanded heading by at most rate × dt per fixed tick —
            // shortest arc (RotateTowards handles the 0/360 wrap; never
            // reimplement with euler angles). GAME-TIME-aware dt (v6,
            // 2026-08-04): the rotation must track the game's sim clock, not
            // Unity's — the speed multiplier lives in ContextCross.Clock.
            // GameTime (Delta = the TRUE per-tick advanced game time: 1/60 at
            // ×1, 1/6 at ×10, 0 while paused → the rotation freezes with the
            // game; Time.timeScale reads 1 at any game speed — the CES5578
            // ×10 slow-turn log). A turn completes in the same GAME time at
            // any speed multiplier. Rate <= 0 = INSTANT — Current was seeded
            // at the command, so the else-branch is the pre-smoothing write
            // verbatim.
            if (e.TurnRateDeg > 0f)
            {
                e.Current = Vector3.RotateTowards(e.Current, e.Direction,
                    e.TurnRateDeg * Mathf.Deg2Rad * GameDt(), 0f);
            }
            else
                e.Current = e.Direction;

            WriteHeading(ac, e);
        }

        // ALTITUDE override (2026-08-04): force the aircraft's vertical
        // position toward the commanded altitude. X/Z stay 100% the game's —
        // the dynamics keeps integrating its own lateral path; only Y (model
        // + HeightFeet readout) is overridden, and the SetWorldPosition
        // channel lock holds the visible view. Zero target = no altitude
        // command (nothing is touched).
        if (e.AltTargetFt > 0f)
        {
            // SMOOTH VERTICAL — the same GAME-TIME-aware dt rule as the turn
            // (GameDt, 2026-08-04): rate ft/GAME-minute → per-tick step =
            // rate × dt/60. 0 while paused → frozen with the game; ×2 speed
            // doubles the per-tick step so the move completes in the same
            // GAME time. Rate <= 0 = INSTANT — AltCurrentFt was seeded at the
            // command, so the else-branch is the pre-smoothing write verbatim.
            if (e.AltRateFpm > 0f)
                e.AltCurrentFt = Mathf.MoveTowards(e.AltCurrentFt, e.AltTargetFt,
                    e.AltRateFpm * GameDt() / 60f);
            else
                e.AltCurrentFt = e.AltTargetFt;

            WriteAltitude(ac, e);
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

    /// <summary>Write the smoothed intermediate heading to all three heading
    /// channels — the game may drive its readouts/visual from the serialized
    /// reactive `_direction` and the `Rotation` heading instead of the
    /// `Direction` property; write all of them so every consumer sees the
    /// same value. (The diag samples below show which channel the game
    /// actually follows.)</summary>
    private static void WriteHeading(Aircraft ac, Entry e)
    {
        ac.Direction = e.Current;
        if (ac.DirectionReactive != null) ac.DirectionReactive.Value = e.Current;
        if (ac.Rotation != null) ac.Rotation.Value = HeadingDeg(e.Current);
    }

    /// <summary>Write the smoothed intermediate altitude to the model's
    /// vertical channels — the serialized reactive `_position` (Y only — X/Z
    /// are the game's own, fresh from this Step's dynamics write) and the
    /// `HeightFeet` readout the game may drive its UI from. The visible view
    /// is locked by the SetWorldPosition channel hijack (Patches).</summary>
    private static void WriteAltitude(Aircraft ac, Entry e)
    {
        float y = e.AltCurrentFt * GameUnitPerFoot;
        var p = ac.Position;
        p.y = y;
        ac.Position = p;
        if (ac.PositionReactive != null) ac.PositionReactive.Value = p;
        if (ac.HeightFeet != null) ac.HeightFeet.Value = e.AltCurrentFt;   // game readout in ft
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
        // Altitude after-state: the commanded/smoothed readout vs the target
        // (2026-08-04). Note the game's own dynPos above shows the game's Y —
        // the "untouched lateral motion" proof.
        string altStr = "altCur n/a altTgt n/a";
        if (e.AltTargetFt > 0f)
            altStr = $"altCur {p.y * FeetPerGameUnit:F0}ft altTgt {e.AltTargetFt:F0}ft";
        Plugin.LogMsg($"diag: {ac.CallSign} step {e.StepCount} spd {kts:F0} pos ({p.x:F1},{p.y:F1},{p.z:F1}) propHdg {propHdg:F2}° rxHdg {rxHdg:F2}° rot {rot:F2}° view3D-euler {view} view3D-pos {viewPos} rbVel {rbVel} dynPos {dynPos} dynVel {dynVel} {altStr}");
    }

    /// <summary>The first visible Aircraft3D bound to this aircraft (its own Step
    /// drives Aircraft.Step, then syncs the view — the last writer of the visible
    /// transform). Public for ParamTrace's rbVel read (the actual-motion crawl
    /// diagnostic — the trace shows the real u/s, not the channel's knots).</summary>
    public static Aircraft3D FindView3D(Aircraft ac)
    {
        foreach (var v in UnityEngine.Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source == ac) return v;
        return null;
    }

    /// <summary>Read accessor for the view-level hijack (Patches). Returns the
    /// SMOOTHED intermediate heading (2026-08-03) — the channel locks must
    /// feed Current, not Command, or the game's own path-tangent write inside
    /// Step would snap the nose back to the full command every tick. (v6,
    /// 2026-08-04: the cfa bounded de-snap sets its per-tick Direction itself
    /// — the pre-capture aim at path[0] — so the gameIntended parameter
    /// remains unused.)</summary>
    public static Vector3 CommandedDirection(Aircraft ac, Vector3 gameIntended = default)
    {
        if (_overrides.TryGetValue(ac, out var e))
        {
            // v8-d: stash the game's TRUE steering output (the path tangent
            // the channel-lock prefix intercepted) — the de-snap diag's sweep
            // evidence (Δ = Angle(our aim, the game's output) every 10 ticks).
            if (gameIntended.sqrMagnitude > 1e-6f) e.GameIntended = gameIntended.normalized;
            return e.Current;
        }
        return Vector3.zero;
    }

    /// <summary>Read accessor for the view-level hijack (Patches). Returns the
    /// SMOOTHED intermediate altitude in GU (Y) — the channel lock must feed
    /// AltCurrent, not the target, or the game's own glideslope write inside
    /// Step would snap the aircraft to the full command every tick (mirror
    /// CommandedDirection). 0 = no altitude command.</summary>
    public static float CommandedAltitudeY(Aircraft ac)
        => _overrides.TryGetValue(ac, out var e) && e.AltTargetFt > 0f
            ? e.AltCurrentFt * GameUnitPerFoot : 0f;

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
    /// (state 5 / Approach), mirroring an ACL pre-spawned state=5 aircraft
    /// (buildState5AircraftBlock).
    /// speedKnots &gt; 0 commands the approach speed (raw knots — the game's own
    /// ApproachSpeedKts scale); speedKnots &lt;= 0 uses the ACL default 240 —
    /// the approach speed is ALWAYS written (v3).
    /// v5 (2026-08-04) NATURAL FLOW: no path is planted. The game's own
    /// ApproachState.Init derives the approach path from the aircraft's own
    /// AppPointList (its procedure from the IAF), and the game's pre-capture
    /// steering naturally heads the aircraft there. v6 (2026-08-04): the
    /// flight model's ETA is re-anchored post-Init (plan + _appRouteTime —
    /// the schedule-derived floor that kept the pace at ~3 u/s, live
    /// CJX2697), the AVC target speed is lifted while pre-capture (the stale
    /// STAR pace otherwise holds ~1.24 u/s), and turnRateDeg is honored again
    /// via a bounded de-snap — the nose rotates at rate °/GAME-second toward
    /// the IAF (the game's own pre-capture aim) until capture, then the
    /// game's steering flies the final turn. v7 (2026-08-04): the re-anchor
    /// is re-asserted per-tick from the de-snap branch — the transition
    /// finalize rebuilds the flight model once from the level schedule and
    /// clobbers a dispatch-only shift (live CCA4851); rotations step by
    /// GameTime TimeScale × FixedDeltaTime (Delta read 0 live — stubbed
    /// getter — and froze every rotation in v6).
    /// </summary>
    public static bool clearForApproach(string callsign, float speedKnots = 0f, string apprName = null,
                                        bool useNative = true, float turnRateDeg = 0f)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        // Diagnostics: pin the exact state at patch receipt (the 1 s tracer
        // streams the same shape; this line marks the command-time snapshot).
        ParamTrace.DumpNow(callsign, "BEFORE");

        // 1) A heading/altitude override would fight the approach — drop it
        //    (the override only touched heading/altitude channels, nothing to
        //    restore; an altitude hold ends with the handoff — the aircraft
        //    descends the glideslope).
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

        var dp = ac.DynamicsData;                    // the serialized data channel
        if (dp == null) return false;

        // 4) v5 (2026-08-04) NATURAL FLOW: nothing is planted. The approach
        //    path is the AIRCRAFT'S OWN procedure — its
        //    FlyApproachDynamicsParams AppPointList (the same list the game's
        //    own ApproachState.Init derives the approach path from, from the
        //    IAF to the threshold). The aircraft's own STAR lists stay
        //    untouched, so there is no command-time anchor for the game's
        //    steering to return to: when the transition lands, the game's
        //    pre-capture steering naturally heads the aircraft toward the IAF
        //    and the approach activates on capture. The v2-v4 join-leg
        //    machinery (prepend, per-tick path[0] tracking, release rule)
        //    existed for the capture-gate / stale-path[0] symptoms; the
        //    CCA4851 live log showed the gate OPEN (stPr advancing on a
        //    static path[0]) yet the aircraft still crawling at ~1-4 u/s —
        //    the flight-model pace, which the reschedule at step 5b fixes.
        var flyParams = default(FlyApproachDynamicsParams);
        var sourceNodes = new List<Vector3>();
        // 4a) Path reference — the aircraft's own procedure (for the state
        //     check + the gate-bypass params). Same interop gotcha as
        //     everywhere in this project: the interface-typed getter wraps
        //     the object in the interface's interop class ("IDynamicsParams"),
        //     so `is FlyApproachDynamicsParams` NEVER matches; identify by
        //     native class pointer and re-wrap.
        if (dp.DynamicsParams is Il2CppObjectBase srcOb)
        {
            try
            {
                if (srcOb.ObjectClass == Il2CppClassPointerStore<FlyApproachDynamicsParams>.NativeClassPtr)
                {
                    flyParams = new FlyApproachDynamicsParams(srcOb.Pointer);
                    var appPts = flyParams.AppPointList;
                    if (appPts != null && appPts.Count >= 2)
                    {
                        for (int i = 0; i < appPts.Count; i++) sourceNodes.Add(appPts[i]);
                        Plugin.LogMsg($"cfa: {callsign} approach path = the aircraft's own procedure (AppPointList, len={sourceNodes.Count}) — natural IAF join");
                    }
                    else
                        Plugin.LogMsg($"cfa: {callsign} step 4a: AppPointList empty — falling back to the GetRoute procedure");
                }
                else
                    Plugin.LogMsg($"cfa: {callsign} step 4a: params NOT FlyApproachDynamicsParams (class 0x{srcOb.ObjectClass.ToInt64():X}) — falling back to the GetRoute procedure");
            }
            catch (Exception ex)
            {
                Plugin.LogMsg($"cfa: {callsign} step 4a FAILED: {ex.GetType().Name}: {ex.Message}");
            }
        }
        if (sourceNodes.Count == 0)
        {
            foreach (var node in appr.AirwayNodes)
                if (node != null) sourceNodes.Add(node.Position);   // IAF → threshold
            Plugin.LogMsg($"cfa: {callsign} path from GetRoute AirwayNodes (len={sourceNodes.Count}) — AppPointList unavailable");
        }
        if (sourceNodes.Count < 2) return false;

        // 4b) Expected path for the state check / gate-bypass: the aircraft's
        //     own procedure (IAF → threshold) as an Il2Cpp list. The game's
        //     own ApproachState.Init derives exactly this from AppPointList —
        //     the 6b state check VERIFIES it rather than rewriting.
        var expectedPath = new Il2CppSystem.Collections.Generic.List<Vector3>();
        for (int i = 0; i < sourceNodes.Count; i++) expectedPath.Add(sourceNodes[i]);

        // 5) Speed. No params plant (v5): the game's own ApproachState.Init
        //    derives the approach params from AppPointList when the transition
        //    lands, and the ACTIVE state owns the channel's params thereafter
        //    (the replant-diff keeps watching). The flight-model reschedule
        //    moved to 6b2 (post-Init — v1 at 5b shifted only the plan anchor
        //    and the ETA floor held; live CJX2697). The DynamicsState enum
        //    write is at step 6c, AFTER the transition attempts: live log
        //    2026-08-03 showed a pre-set enum + gated fires = a HALF-transition
        //    — enum Approaching while the ACTIVE STATE object stayed
        //    FlyApproachState — and the readback (IsInState / dynState=) then
        //    lied about it. The enum reflects the transition, not pre-empts it.
        // Speed: ALWAYS write the approach speed — raw knots (the game's own
        // ApproachSpeedKts = 240 scale — the m/s write drove state integration
        // at ~half speed, see OnAircraftStep). The ACL state-5 block ALWAYS
        // carries TaxiSpeed=240 (editor constants 240/1/-2); the pre-v3
        // kts-only behavior (fields untouched without a kts field) is the
        // prime suspect for the approach path-following crawl — ~1-4 u/s
        // instead of ~123 u/s at 240 kt (live log 2026-08-03: stPr advanced
        // 0.005/s; the aircraft crept along the STAR tail for minutes).
        // speedKnots > 0 overrides the default 240.
        float apprSpeedKts = speedKnots > 0f ? speedKnots : 240f;
        dp.TaxiSpeed = apprSpeedKts;
        dp.TargetTaxiSpeed = apprSpeedKts;
        dp.DynamicsTargetTaxiSpeed = apprSpeedKts;
        if (ac.TaxiSpeed != null) ac.TaxiSpeed.Value = apprSpeedKts;
        if (ac.AirSpeedKnot != null) ac.AirSpeedKnot.Value = apprSpeedKts;
        dp.ForwardSpeed = true;
        dp.PositiveTaxiAcceleration = 1f; dp.NegativeTaxiAcceleration = -2f;   // ACL constants
        Plugin.LogMsg($"cfa: {callsign} speed: ts={apprSpeedKts:F0} tts={apprSpeedKts:F0} dtts={apprSpeedKts:F0} fwd=True accel 1/-2{(speedKnots > 0f ? "" : " (default 240)")}");

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

        // 6b) State check — VERIFY only (v5): the game's own ApproachState.Init
        //     derives the approach path from the aircraft's AppPointList — the
        //     same procedure this handoff relies on — so no planting or
        //     rewriting is needed. Log what the active state actually carries
        //     (path / progress / the Init-built flight model) so the watch can
        //     be read against it. If the transition never activated the state
        //     OBJECT (the FlyToApproachCondition gate — mid-STAR aircraft fail
        //     it), bypass the gate via the game's canonical
        //     SetCurrentState(_approachState, params-from-own-procedure).
        if (ac._dynamics != null && ac._dynamics._currentState is Il2CppObjectBase curOb)
        {
            try
            {
                // v6: arm the bounded de-snap (rate=N honored again — the
                // game's own pre-capture easing otherwise sweeps the nose at
                // ~35°/s, live CJX2697) + the per-tick AVC target-speed lift
                // (the stale STAR pace ~2.4 kt otherwise holds the aircraft at
                // ~1.24 u/s until capture — the OPERATIVE speed target).
                // Called ONLY where the state check CONFIRMS the approach state
                // object — the direct transition or the gate-bypass — never
                // for a still-STAR aircraft (the de-snap target is the
                // approach path start; its steering must not be fought).
                void ArmDeSnap()
                {
                    var deSnap = new Entry {
                        Direction = Vector3.zero,   // set per-tick by the de-snap branch in OnAircraftStep
                        Current = ac.Direction.sqrMagnitude > 1e-6f ? ac.Direction.normalized : new Vector3(0f, 0f, 1f),
                        TurnRateDeg = turnRateDeg > 0f ? turnRateDeg : 3f,   // frame rate or the plugin's standard default
                        CfaFollow = true,
                        Path0 = expectedPath[0],
                        TargetKts = apprSpeedKts,
                    };
                    _overrides[ac] = deSnap;
                    Plugin.LogMsg($"cfa: {callsign} de-snap armed: rate {deSnap.TurnRateDeg:F0}°/s toward IAF {expectedPath[0]}, pre-capture speed {apprSpeedKts:F0} kt");
                }

                if (curOb.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                {
                    var st = new ApproachState(curOb.Pointer);
                    bool pathMismatch = PathMismatch(st._pathPointList, expectedPath);
                    bool rtMismatch = st._runtimeData == null || PathMismatch(st._runtimeData.PathPointList, expectedPath);
                    Plugin.LogMsg($"cfa: {callsign} state check: ApproachState stPath={ParamTrace.ListSummary(st._pathPointList)} stPr={st.GetProgressRatio():F3}{ParamTrace.ApproachStateDiag(st, ac.Position)} — {(pathMismatch ? "PATH MISMATCH (Init derived something else than the aircraft's own procedure?)" : "path ok (aircraft's own procedure)")}{(rtMismatch ? " RT MISMATCH" : " rt ok")}");
                    // No rewrite: the aircraft's own procedure is correct by
                    // definition; a mismatch here means a game flow re-derived
                    // the path from other data — logged for the watch read.
                    ArmDeSnap();
                }
                else if (curOb.ObjectClass == Il2CppClassPointerStore<FlyApproachState>.NativeClassPtr)
                {
                    // Live 2026-08-03: the transition NEVER activates the state
                    // OBJECT. The fires flipped the enum (dyn.CurrentState →
                    // Approaching — the AFTER dump read Appr(5)/Approaching)
                    // but `_currentState` stayed FlyApproachState through all
                    // 90 watch steps: the game's Fly→Approach transition is
                    // gated by FlyToApproachCondition (the aircraft must be at
                    // the STAR's transition point; ours was mid-STAR), so the
                    // fires' transition was silently dropped. Bypass the gate
                    // via the CANONICAL transition entry — the game's own
                    // SetCurrentState(IDynamicState, IDynamicsParams), which
                    // every real transition flows through and Inits the
                    // activated state from the params. Use the dynamics'
                    // pre-created ApproachState instance (nothing minted). If
                    // SetCurrentState itself refuses, last resort is a direct
                    // `_currentState` field force. Every path is logged.
                    var p2 = new ApproachDynamicsParams {
                        ProgressRatio = 0f,                           // game re-derives pose from path (ACL constant)
                        TouchDownPosition = runway.TouchDownPosition, // public getter — runway threshold
                        ApproachDirection = (expectedPath[expectedPath.Count - 1] - expectedPath[expectedPath.Count - 2]).normalized,
                        CommandedGoAround = false,
                        InitialPosition = new Vector3(ac.Position.x, 15.24f, ac.Position.z),   // the aircraft's pose — what the game's own Init computes
                        PathPointList = expectedPath,                 // the aircraft's OWN procedure (IAF → threshold)
                    };
                    Plugin.LogMsg($"cfa: {callsign} state check: STILL FlyApproachState — the transition did not take (gate) — attempting SetCurrentState bypass");
                    var dyn2 = ac._dynamics;
                    ApproachState apprSt = dyn2 != null ? dyn2._approachState : null;
                    if (apprSt != null)
                    {
                        try
                        {
                            Plugin.LogMsg($"cfa: {callsign} bypass: _approachState stPath={ParamTrace.ListSummary(apprSt._pathPointList)} stPr={apprSt.GetProgressRatio():F3} — calling SetCurrentState(_approachState, own-procedure params)");
                            // Interface-proxy gotcha (the same one everywhere in
                            // this project): the stub's concrete states do NOT
                            // cast to IDynamicState — the interface has its own
                            // interop wrapper class. Wrap the native pointer in
                            // it (the game's native side only sees the pointer).
                            dyn2.SetCurrentState(new IDynamicState(apprSt.Pointer), p2);
                            if (dyn2._currentState is Il2CppObjectBase cur2
                                && cur2.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                            {
                                var st2 = new ApproachState(cur2.Pointer);
                                bool mismatch2 = PathMismatch(st2._pathPointList, expectedPath);
                                Plugin.LogMsg($"cfa: {callsign} bypass: SetCurrentState → ApproachState stPath={ParamTrace.ListSummary(st2._pathPointList)} stPr={st2.GetProgressRatio():F3}{ParamTrace.ApproachStateDiag(st2, ac.Position)} — {(mismatch2 ? "MISMATCH — rewriting to the aircraft's own procedure" : "matches the aircraft's own procedure")}");
                                if (mismatch2)
                                {
                                    st2._pathPointList = expectedPath;
                                    st2._initialPosition = p2.InitialPosition;
                                    st2._approachDirection = p2.ApproachDirection;
                                    st2._touchDownPosition = p2.TouchDownPosition;
                                    st2.startingProgress = 0f;
                                    st2._runtimeData = p2;
                                    Plugin.LogMsg($"cfa: {callsign} bypass: ApproachState path + Init fields + _runtimeData rewritten ({expectedPath.Count} pts)");
                                }
                                // Channel re-plant: SetCurrentState's Init may
                                // have re-derived the channel params from the
                                // fly lists — make sure the channel carries p2.
                                var chParams2 = dp.DynamicsParams;
                                if (chParams2 is Il2CppObjectBase chOb2
                                    && chOb2.ObjectClass == Il2CppClassPointerStore<ApproachDynamicsParams>.NativeClassPtr
                                    && PathMismatch(new ApproachDynamicsParams(chOb2.Pointer).PathPointList, expectedPath))
                                {
                                    dp.DynamicsParams = p2;
                                    _plantedParams[ac] = p2.Pointer;
                                    Plugin.LogMsg($"cfa: {callsign} bypass: params-replant: DynamicsParams ← ApproachDynamicsParams (aircraft's own procedure)");
                                }
                            }
                            else
                            {
                                Plugin.LogMsg($"cfa: {callsign} bypass: SetCurrentState did not stick ({(dyn2._currentState is Il2CppObjectBase curB ? $"state 0x{curB.ObjectClass.ToInt64():X}" : "state ?")}) — forcing _currentState field");
                                dyn2._currentState = new IDynamicState(apprSt.Pointer);
                                apprSt._pathPointList = expectedPath;
                                apprSt._initialPosition = p2.InitialPosition;
                                apprSt._approachDirection = p2.ApproachDirection;
                                apprSt._touchDownPosition = p2.TouchDownPosition;
                                apprSt.startingProgress = 0f;
                                if (apprSt._runtimeData != null) apprSt._runtimeData = p2;
                                dp.DynamicsParams = p2;
                                _plantedParams[ac] = p2.Pointer;
                                Plugin.LogMsg($"cfa: {callsign} bypass: _currentState forced → ApproachState + captured copies + channel rewritten");
                            }
                        }
                        catch (Exception ex)
                        {
                            Plugin.LogMsg($"cfa: {callsign} bypass FAILED: {ex.GetType().Name}: {ex.Message}");
                        }

                        // v6: the bypass landed on ApproachState (SetCurrentState
                        // success or the forced _currentState write) — arm the
                        // de-snap + speed lift like the direct-transition path.
                        if (dyn2?._currentState is Il2CppObjectBase curF
                            && curF.ObjectClass == Il2CppClassPointerStore<ApproachState>.NativeClassPtr)
                            ArmDeSnap();
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

        // 6b2) FLIGHT-MODEL RESCHEDULE v2 (2026-08-04, v7: shared helper) —
        //     the v1 write (step 5b, pre-fires) shifted only the plan anchor,
        //     but the afm's ETA is floored by the cached _appRouteTime (the
        //     schedule-derived approach duration; ETA = max(planDelta,
        //     _appRouteTime − elapsedSinceRouteEntry)). Shift BOTH the plan
        //     anchor AND _appRouteTime so ETA = remaining/speed and the
        //     model's pace target = the commanded speed. The dispatch shift
        //     alone is clobbered by the transition-finalize rebuild (v7 — the
        //     de-snap branch re-asserts it per-tick until it converges).
        RescheduleEta(ac, apprSpeedKts, "dispatch");

        // 6c) Reflect the transition on the serialized channel — AFTER the
        //     fires/bypass, so the gate and the state check saw the true
        //     pre-transition state. If the game's own transition already set
        //     it, this is a no-op; if the bypass forced the state object, this
        //     keeps the AFTER dump's readback (IsInState / dynState=) honest.
        dp.DynamicsState.Value = State.Approaching;       // 2 — ACL's DynamicsState

        // 6d) RADIO HANDOFF (v2, 2026-08-04): ACL parity — the state-5 block
        //     stores the tower channel in BOTH radio slots (RadioChannelGuid
        //     AND JurisdictionRadioChannelGuid = tower). v1 wrote only the
        //     jurisdiction slot and the aircraft stayed on the approach
        //     frequency — the tower seat still could not own it (verified
        //     live); v2 writes BOTH, so the strip/telemetry flip to the tower
        //     seat at command time. No radio audio by design (the silent
        //     handoff). Resolution failure is a logged skip: the aircraft
        //     stays on approach and self-heals on touchdown, exactly as before.
        try
        {
            var tower = ResolveTowerRadioChannel();
            var rc = ac._radioChannel;
            var jc = ac._jurisdictionRadioChannel;
            if (tower == null || rc == null || jc == null)
                Plugin.LogMsg($"cfa: {callsign} radio: tower channel NOT resolved ({(tower == null ? "no tower channel" : "missing radio slot")}) — stays on approach (self-heals on touchdown)");
            else
            {
                var rcBefore = rc.Value != null ? rc.Value.PK : "<null>";
                var jcBefore = jc.Value != null ? jc.Value.PK : "<null>";
                rc.Value = tower;
                jc.Value = tower;
                Plugin.LogMsg($"cfa: {callsign} radio: radio {rcBefore} → TWR({tower.PK})");
                Plugin.LogMsg($"cfa: {callsign} radio: jurisdiction {jcBefore} → TWR({tower.PK})");
            }
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"cfa: {callsign} radio handoff FAILED: {ex.GetType().Name}: {ex.Message}");
        }

        // 7) Route label = approach procedure name (ACL parity).
        var name = !string.IsNullOrEmpty(apprName) ? apprName : appr.Name;
        if (!string.IsNullOrEmpty(name))
            ac._route.Value = name;

        // 8) ACL parity: the aircraft now waits for the landing clearance.
        //    (Il2CppStructArray — the interop array type the stub property wants.)
        ac._waitingForCommands.Value =
            new Il2CppStructArray<ECommand>(new[] { ECommand.PermitLanding });   // 22 — game enum, NOT the editor's CMD_* numbers

        // 9) No INSTANT heading snap (v5+): the natural flow plants no path,
        //     so the game's own steering owns the heading ("naturally head
        //     towards the IAF") — the v6 bounded de-snap (armed at 6b) rate-
        //     limits the pre-capture rotation to the frame's rate=N (default
        //     3°/s of GAME time — GameDt) and releases on capture, so the
        //     final turn at the IAF is the game's own.

        // Diagnostics: the post-patch state (both machines + params channel).
        // The BEFORE/AFTER dumps alone end at the patch — the seconds after
        // are the ones that show whether the RNAV holds or the aircraft
        // reverts. Arm the per-step watch (~3.3 s at step resolution) so the
        // aftermath lands in the log without the 1 s auto-trace spam (the
        // 30-line-per-handoff trace stream is gone since 2026-08-03 v2 —
        // `track|CS` remains for deliberate 1 s dumps).
        _approachWatch[ac] = ApproachWatchBudget;
        ParamTrace.DumpNow(callsign, "AFTER");

        return true;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /// <summary>Path-list identity for the state check (2026-08-04): count +
    /// LAST point only — enough to prove the active state carries the
    /// aircraft's own procedure (the game's Init-derived path is the same
    /// point sequence; first-point differences are cosmetic).</summary>
    private static bool PathMismatch(Il2CppSystem.Collections.Generic.List<Vector3> l,
                                     Il2CppSystem.Collections.Generic.List<Vector3> expected)
        => l == null || expected == null || l.Count != expected.Count
        || (l.Count > 0 && l[l.Count - 1] != expected[expected.Count - 1]);

    /// <summary>v7: the flight-model reschedule — shift BOTH the plan anchor
    /// and _appRouteTime by (ETA − remaining/speed) so ETA = remaining/speed
    /// and the model's pace target = the commanded knots (the crawl = rem/ETA
    /// against the level schedule's ~8-min-out landing time). Called at
    /// dispatch (6b2) AND per-tick from the cfa de-snap branch: the
    /// transition finalize rebuilds the model ONCE (afm _shouldUpdateMetaData
    /// → Update() re-derives plan + _appRouteTime from the schedule — live
    /// CCA4851: the dispatch shift read 00:00:11.7 in the AFTER dump, back at
    /// 00:07:55.867 by watch step 0), so the per-tick re-assert is what
    /// converges. The guard ETA > newEta + 5 s makes it idempotent: silent
    /// once converged, one write per rebuild. Raw-ticks shift — the interop
    /// exposes the IL2CPP BCL's DateTime/TimeSpan with no managed operators
    /// in the stubs. `entry` (the de-snap) rate-limits the per-tick log: the
    /// first 3 fires, then every 30th — a steady re-fire stream would reveal
    /// a per-tick rebuild and is exactly what the log must show.</summary>
    private static void RescheduleEta(Aircraft ac, float speedKts, string tag, Entry entry = null)
    {
        try
        {
            var afm = ac._dynamics?.AircraftFlightMetrics;
            if (afm == null || afm.FlightPlan == null || afm.ETA.TotalSeconds <= 0.0) return;
            double speedMs = speedKts * 0.51444;
            double newEtaSec = afm.RemainingDistance / speedMs;
            if (afm.ETA.TotalSeconds <= newEtaSec + 5.0) return;
            if (entry != null)
            {
                entry.RescheduleLogs++;
                if (entry.RescheduleLogs > 3 && entry.RescheduleLogs % 30 != 0) return;
            }
            double beforeEta = afm.ETA.TotalSeconds;
            long shiftTicks = (long)((beforeEta - newEtaSec) * TimeSpan.TicksPerSecond);
            var plan = afm.FlightPlan;
            var end = plan.GetEndTime(EFlightDirection.Arrival);
            plan.SetEndTime(EFlightDirection.Arrival, new Il2CppSystem.DateTime(end.Ticks - shiftTicks));
            afm._appRouteTime = new Il2CppSystem.TimeSpan(afm._appRouteTime.Ticks - shiftTicks);
            Plugin.LogMsg($"cfa: {ac.CallSign} flight-model reschedule v2 ({tag}): ETA {beforeEta:F0} s → {newEtaSec:F1} s (rem {afm.RemainingDistance:F0} u) — plan anchor AND _appRouteTime shifted −{shiftTicks / TimeSpan.TicksPerSecond:F0} s — pace target = {speedKts:F0} kt");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"cfa: {ac.CallSign} flight-model reschedule v2 ({tag}) FAILED: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static AirwayRouteService _routeService;   // cache; invalidate on level switch

    private static AirwayRouteService ResolveAirwayRouteService()
    {
        if (_routeService != null) return _routeService;
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
            if (scope.Container != null && scope.Container.TryResolve(out AirwayRouteService svc))
                return _routeService = svc;
        return null;
    }

    /// <summary>Resolve the airport's tower RadioChannel instance — the game's
    /// OWN resolver first (RadioChannelManager.GetResolvedChannel(EChannel.Tower),
    /// the same path Aircraft / AircraftFactory / RuntimeAircraftSpawnService
    /// use for their channel work; VContainer [Inject]-registered), then the
    /// RadioSystem audio bindings as fallback (PK → RadioChannelBinding — the
    /// private-field-as-public-property gotcha again). Returns null when
    /// unresolvable — the caller keeps the current behavior (the aircraft
    /// stays on approach and self-heals on touchdown).</summary>
    private static RadioChannel ResolveTowerRadioChannel()
    {
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            try
            {
                if (scope.Container.TryResolve(out RadioChannelManager mgr))
                {
                    var ch = mgr.GetResolvedChannel(EChannel.Tower);
                    if (ch != null) return ch;
                }
            }
            catch { }   // a partially-initialized scope — try the next
        }
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            try
            {
                if (scope.Container.TryResolve(out RadioSystem radio) && radio._radioChannelBindings != null)
                    foreach (var pair in radio._radioChannelBindings)
                    {
                        var b = pair.Value;
                        if (b != null && b.Channel != null && b.Channel.Type == EChannel.Tower)
                            return b.Channel;
                    }
            }
            catch { }
        }
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

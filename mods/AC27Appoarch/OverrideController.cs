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
        public bool FollowGameHeading; // cfa-turn mode (2026-08-03): Direction = zero; the rotation target is the
                                       // game's own path-tangent heading (stashed by the channel-lock prefixes),
                                       // and the lock is phase-gated (Phase 1 pass-through → Phase 2 rotate)
        public Vector3 GameIntended;   // cfa-turn: the game's intended heading from the latest prefix stash
        public bool Locked;            // cfa-turn Phase 2: actively rotating onto the approach course
        public Vector3 LockTangent;    // cfa-turn: the game's tangent at lock — the deferred-window baseline
        public bool TangentMoved;      // the tangent swept > CfaTurnMinSweepDeg — the game's real turn ran
        public int Phase2Ticks;        // cfa-turn Phase-2 elapsed ticks (safety bound, see OnAircraftStep)
        public int StepCount;          // diagnostics: sample the first ~0.5 s of override; also Phase-1 timeout
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

    // Approach watch: per-step diag for the first ~3.3 s after a
    // clear_for_appr patch (200 steps — longer than the ~3 s deferred
    // CommandContinueApproach radio-chatter window) — the critical window
    // where the aircraft either turns onto the ILS or keeps flying the STAR.
    // Value = steps remaining.
    private const int ApproachWatchBudget = 200;
    private static readonly Dictionary<Aircraft, int> _approachWatch = new();

    // Replant detection: the data channel's DynamicsParams pointer WE planted
    // (per aircraft). The setter is an IL2CPP field accessor — unpatchable by
    // both Harmony backends — and the game's native C++ writes the field
    // directly, bypassing the managed stub entirely. The only way to see a
    // re-plant is to diff the pointer every step while the aircraft is
    // tracked (the post-patch window) — catches native direct writes too.
    private static readonly Dictionary<Aircraft, IntPtr> _plantedParams = new();

    // ── cfa smooth-turn constants (2026-08-03) ────────────────────────────
    // The editor's composer sends its TURN_RATE_DEG_S on the clear_for_appr
    // frame (rate=N); frames WITHOUT a rate (raw scripts, the !5: Mechanism
    // A path) get this default. IFR standard rate — the same value the
    // heading composer uses; keep in sync with
    // FlightPatchCommandBar.TURN_RATE_DEG_S.
    private const float ClearForApprTurnRateDeg = 3f;

    // Phase-1 timeout: if the approach transition never lands (deferred
    // handoff failed / reverted), drop the pass-through entry instead of
    // lingering in the override map.
    private const int CfaTurnPhase1TimeoutSteps = 600;   // 10 s at 60 TPS

    // Phase-2 sweep gate (2026-08-03 v2): the game's own approach turn is
    // DEFERRED (the CommandContinueApproach radio-chatter flow) — for ~3 s
    // after the lock the path-tangent heading is still the STAR tangent,
    // which sits ON the nose. Converging against THAT dropped the override
    // within ~2 ticks, and the game's real turn (observed ~42°/s easing)
    // then snapped the nose onto the final course. So a drop is only
    // allowed once the tangent has actually SWEPT from the lock-time
    // snapshot — proof the deferred turn ran — and the nose has caught it.
    private const float CfaTurnMinSweepDeg = 2f;    // tangent sweep that proves the deferred turn started
    private const int CfaTurnPhase2MaxSteps = 3600; // 60 s at 60 TPS — safety: never hold the nose forever

    /// <summary>Unified patch API: "update_heading" | "update_position" (legacy) | "clear_for_appr".</summary>
    public static bool PatchAircraft(string commandType, string callsign,
                                     Vector3 direction = default, float speedKnots = 0f,
                                     string apprName = null, bool useNative = true,
                                     float turnRateDeg = 0f)
    {
        switch (commandType)
        {
            case "update_heading":  return patchHeading(callsign, direction, turnRateDeg);
            case "update_position": return patchHeading(callsign, direction, turnRateDeg);   // legacy alias (kts ignored)
            case "clear_for_appr":  return clearForApproach(callsign, speedKnots, apprName, useNative, turnRateDeg);
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
        if (turnRateDeg > 0f)
        {
            if (_overrides.TryGetValue(ac, out var existing) && existing.Current.sqrMagnitude > 1e-6f)
                current = existing.Current;                             // mid-turn re-command — continue from here
            else if (ac.Direction.sqrMagnitude > 1e-6f)
                current = ac.Direction.normalized;                      // fresh command — start from the real nose
        }

        var e = new Entry {
            Direction = cmd,
            Current = current,
            TurnRateDeg = turnRateDeg,
        };
        _overrides[ac] = e;

        // After-state: what the override commands. Speed and position are not
        // touched — the game keeps them; the aircraft flies its own route at
        // its own speed, pointing at the commanded heading.
        float aHdg = HeadingDeg(e.Direction);
        Plugin.LogMsg($"override: {callsign} before hdg {(bHdg < 0f ? "n/a" : bHdg + "°")} spd {bSpd:F0} kt → after hdg {(aHdg < 0f ? "none (game's own)" : aHdg + "°")} rate {turnRateDeg:F0}°/s (heading-only — game keeps position & speed)");
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

        if (!_overrides.TryGetValue(ac, out var e)) return;

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
            // reimplement with euler angles). GAME-TIME-aware dt: the rotation
            // must track the game's sim clock, not the wall clock —
            // Time.timeScale = game speed multiplier (pause = 0, "Game pause
            // sets time scale 0"), Time.fixedDeltaTime = one fixed tick
            // (1/60). dt = fixedDeltaTime × timeScale is the game time that
            // passes per tick; 0 while paused → the rotation freezes with the
            // game, and ×2 speed doubles the per-tick rotation so the turn
            // completes in the same GAME time. (If live testing at ×2 shows
            // the turn finishing in HALF the game time — the game ticking
            // 2×/wall-s at 1/60 each — drop the timeScale factor; per-tick
            // stepping is then automatically game-time-correct and the pause
            // gate stays as `timeScale <= 0`.) Rate <= 0 = INSTANT — Current
            // was seeded at the command, so the else-branch is the
            // pre-smoothing write verbatim.
            if (e.TurnRateDeg > 0f)
            {
                float scale = Mathf.Max(0f, Time.timeScale);
                e.Current = Vector3.RotateTowards(e.Current, e.Direction,
                    e.TurnRateDeg * Mathf.Deg2Rad * Time.fixedDeltaTime * scale, 0f);
            }
            else
                e.Current = e.Direction;

            WriteHeading(ac, e);
        }
        else if (e.FollowGameHeading)
        {
            // CFA SMOOTH TURN (2026-08-03): smooth the clear_for_appr
            // handoff — the state transition + path overwrite makes the game
            // write the approach path-tangent heading verbatim (the
            // one-frame snap). The rotation TARGET is the game's own intended
            // heading, stashed by the channel-lock prefixes
            // (SetDirectionPrefix — the only place the true path-tangent
            // heading is visible; our own write-back through the same setter
            // is filtered by the exact-match rule in CommandedDirection).
            //
            // PHASE-GATED: Phase 1 (not Locked) = PASS-THROUGH — the lock
            // prefixes return zero and the nose flies the STAR freely until
            // the approach transition actually lands (native mode's deferred
            // CommandContinueApproach flow takes ~3 s; the direct fires land
            // immediately) — locking early would fight the STAR's own turns.
            // The aircraft-level state machine is the transition signal:
            // leaving Fly = the handoff landed → Phase 2. Back to Fly (the
            // restore-runtime-data revert) or 10 s without a transition →
            // drop the entry (the game owns the flight again).
            if (!e.Locked)
            {
                if (ac.IsInState(EAircraftState.Fly))
                {
                    if (e.StepCount >= CfaTurnPhase1TimeoutSteps)
                    {
                        _overrides.Remove(ac);
                        Plugin.LogMsg($"override: {ac.CallSign} cfa-turn: no approach transition within {CfaTurnPhase1TimeoutSteps / 60} s — override dropped (game's own flight resumes)");
                    }
                    // else: Phase 1 pass-through — nothing to write; the nose
                    //       keeps flying the game's own (STAR) heading.
                }
                else
                {
                    e.Locked = true;
                    e.LockTangent = e.GameIntended;   // deferred-window baseline (still the STAR tangent)
                    Plugin.LogMsg($"override: {ac.CallSign} cfa-turn: approach transition landed — rotating onto the approach course at {e.TurnRateDeg:F0}°/s");
                }
            }
            if (e.Locked)
            {
                if (ac.IsInState(EAircraftState.Fly))
                {
                    // Handoff reverted (the restore-runtime-data flow) — the
                    // aircraft is back on the STAR; drop the lock, the game
                    // owns the flight again.
                    _overrides.Remove(ac);
                    Plugin.LogMsg($"override: {ac.CallSign} cfa-turn: aircraft back on the STAR (handoff reverted) — override dropped");
                }
                else if (e.GameIntended.sqrMagnitude > 1e-6f)
                {
                    // SWEEP GATE (2026-08-03 v2): the game's own approach
                    // turn is DEFERRED (CommandContinueApproach radio chatter
                    // ~3 s) — for that window the path-tangent heading is
                    // still the STAR tangent, sitting ON the nose, and
                    // converging against it dropped the override ~2 ticks
                    // after lock while the game's real turn (observed ~42°/s
                    // easing) then snapped the nose onto the final course
                    // (live log: CJX2697 hdg 110→137 across watch steps
                    // 10–60). So a drop is only allowed once the tangent has
                    // actually SWEPT from the lock-time snapshot — proof the
                    // deferred turn ran — and the nose has caught it.
                    // Meanwhile rotate at the entry's rate toward the LIVE
                    // tangent: the nose chases the game's turn and catches it
                    // once the tangent settles on the final course — the
                    // release is seamless. (If the game's easing re-reads
                    // ac.Direction each tick, the suppressed writes slow the
                    // path curve to the nose's rate too — the watch position
                    // deltas show which model is real.)
                    e.Phase2Ticks++;
                    if (!e.TangentMoved && e.LockTangent.sqrMagnitude > 1e-6f)
                    {
                        float sweep = Vector3.Angle(e.LockTangent, e.GameIntended);
                        if (sweep > CfaTurnMinSweepDeg)
                        {
                            e.TangentMoved = true;
                            Plugin.LogMsg($"override: {ac.CallSign} cfa-turn: game's approach turn running — tangent swept {sweep:F0}° — nose chasing at {e.TurnRateDeg:F0}°/s");
                        }
                    }
                    float gap = Vector3.Angle(e.Current, e.GameIntended);
                    if (gap < 0.1f && e.TangentMoved)
                    {
                        // Converged: the nose caught the SETTLED tangent (the
                        // sweep gate proves the game's real turn ran) — snap
                        // the last hair and release; the game's own writes
                        // now equal the nose, so nothing snaps.
                        e.Current = e.GameIntended.normalized;
                        _overrides.Remove(ac);
                        Plugin.LogMsg($"override: {ac.CallSign} cfa-turn converged — nose on the approach course (tangent swept {Vector3.Angle(e.LockTangent, e.GameIntended):F0}°) — override dropped (game's own heading writes resume)");
                        WriteHeading(ac, e);
                    }
                    else if (e.Phase2Ticks >= CfaTurnPhase2MaxSteps)
                    {
                        // Safety backstop: never hold the nose forever (e.g.
                        // the tangent never settles — a hold pattern). The
                        // game's own heading writes resume (residual gap =
                        // one snap, but bounded and late).
                        _overrides.Remove(ac);
                        Plugin.LogMsg($"override: {ac.CallSign} cfa-turn: {CfaTurnPhase2MaxSteps / 60} s phase-2 bound — override dropped (residual {gap:F1}° off the game's heading)");
                    }
                    else
                        RotateAndWrite(ac, e);
                }
                // else: no intended heading stashed yet — hold (nothing written).
            }
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

    /// <summary>One-tick rotation step toward the entry's current target
    /// (cfa-turn mode: e.GameIntended) at the entry's rate — GAME-TIME-aware
    /// dt, the same rule as the update_heading turn: Time.timeScale = game
    /// speed multiplier (pause = 0), Time.fixedDeltaTime = one fixed tick
    /// (1/60); ×2 speed doubles the per-tick rotation so the turn completes
    /// in the same GAME time, and 0 while paused freezes the rotation with
    /// the game.</summary>
    private static void RotateAndWrite(Aircraft ac, Entry e)
    {
        float scale = Mathf.Max(0f, Time.timeScale);
        e.Current = Vector3.RotateTowards(e.Current, e.GameIntended,
            e.TurnRateDeg * Mathf.Deg2Rad * Time.fixedDeltaTime * scale, 0f);
        WriteHeading(ac, e);
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

    /// <summary>Read accessor for the view-level hijack (Patches). Returns the
    /// SMOOTHED intermediate heading (2026-08-03) — the channel locks must
    /// feed Current, not Command, or the game's own path-tangent write inside
    /// Step would snap the nose back to the full command every tick.
    ///
    /// cfa-turn mode (FollowGameHeading, 2026-08-03): the game's intended
    /// heading IS the rotation target — stash it for OnAircraftStep. BUT NOT
    /// OUR OWN WRITE-BACK: the Step postfix writes Current through the same
    /// set_Direction this prefix locks, and stashing that would make the
    /// target equal the nose (rotation stall). The write-back is bit-identical
    /// to Current; the game's true path-tangent heading differs from the nose
    /// as soon as it lags the path (the exact-match filter). Phase 1 (not
    /// locked) returns zero = pass-through: the nose flies the game's own
    /// heading until the approach transition lands.</summary>
    public static Vector3 CommandedDirection(Aircraft ac, Vector3 gameIntended = default)
    {
        if (_overrides.TryGetValue(ac, out var e))
        {
            if (e.FollowGameHeading
                && gameIntended.sqrMagnitude > 1e-6f
                && (gameIntended - e.Current).sqrMagnitude > 1e-12f)
                e.GameIntended = gameIntended.normalized;
            if (e.FollowGameHeading && !e.Locked) return Vector3.zero;   // Phase 1 pass-through
            return e.Current;
        }
        return Vector3.zero;
    }

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
    /// turnRateDeg &gt; 0 arms the SMOOTH handoff turn (2026-08-03): the nose
    /// rotates from where it actually points onto the approach course at
    /// that many °/GAME-second (game-time-aware, pause-aware — same mechanics
    /// as update_heading's smoothing) instead of snapping in the tick the
    /// transition lands; &lt;= 0 / omitted uses ClearForApprTurnRateDeg (the
    /// default — the handoff turn is ALWAYS smooth now).
    /// </summary>
    public static bool clearForApproach(string callsign, float speedKnots = 0f, string apprName = null,
                                        bool useNative = true, float turnRateDeg = 0f)
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

        var dp = ac.DynamicsData;                    // the serialized data channel
        if (dp == null) return false;

        // 4) Build the ACL-equivalent ApproachDynamicsParams. The path is the
        //    AIRCRAFT'S OWN procedure (AppPointList — the same list the game's
        //    own transition builds its ApproachState from; the state check
        //    below proves it) with the aircraft's position prepended as the
        //    JOIN LEG. Without the join leg the approach state holds pr at 0
        //    until the aircraft captures path[0] — and GetRoute's nearest-
        //    first-fix variant pick (report §6.2) put path[0] 300-700 units
        //    from mid-STAR aircraft, producing minutes of dead cruise (live
        //    log 2026-08-03: CES5578/CSN2197 stPr=0.000 frozen through the
        //    watch; CSN2197's 60 s phase-2 bound with the tangent never
        //    swept). Starting the path AT the aircraft makes the approach
        //    activate immediately.
        var flyParams = default(FlyApproachDynamicsParams);
        var sourceNodes = new List<Vector3>();
        // 4a) Path source — the aircraft's own procedure. Same interop gotcha
        //     as everywhere in this project: the interface-typed getter wraps
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
                        Plugin.LogMsg($"cfa: {callsign} path from aircraft AppPointList (len={sourceNodes.Count}) — the aircraft's own procedure");
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

        // 4b) The join leg: aircraft position as path[0] (y=0 — the path-list
        //     convention; the game derives the aircraft's altitude from
        //     InitialPosition/TouchDownPosition, not path y — aircraft fly at
        //     ~15.2 on all-y=0 paths). The approach activates with the
        //     aircraft ON the path: pr advances and the steering turns the
        //     aircraft onto the intercept immediately.
        var pathList = new Il2CppSystem.Collections.Generic.List<Vector3>();
        pathList.Add(new Vector3(ac.Position.x, 0f, ac.Position.z));
        for (int i = 0; i < sourceNodes.Count; i++) pathList.Add(sourceNodes[i]);
        if (pathList.Count < 3) return false;

        var p = new ApproachDynamicsParams {
            ProgressRatio = 0f,                           // game re-derives pose from path (ACL constant)
            TouchDownPosition = runway.TouchDownPosition, // public getter — runway threshold
            ApproachDirection = (pathList[pathList.Count - 1] - pathList[pathList.Count - 2]).normalized,
            CommandedGoAround = false,
            InitialPosition = new Vector3(pathList[0].x, 15.24f, pathList[0].z),   // join-leg start, Y = approach ceiling (ACL constant)
            PathPointList = pathList,
        };

        // 4c) The aircraft's runtime state-30 params still carry the STAR path
        //     in FlyApproachPathPointList; the game's path-following continues
        //     from THAT list through the handoff (observed live: approach
        //     follows the STAR, not the ILS). Overwrite it with the full
        //     approach procedure — the same join-leg list going into
        //     PathPointList. (No clear step needed: assigning a fresh list
        //     replaces the STAR path atomically. AppPointList already holds
        //     the APP points per state-30 semantics — the join leg does not
        //     touch it.)
        if (flyParams != null)
        {
            try
            {
                flyParams.FlyApproachPathPointList = pathList;
                Plugin.LogMsg($"cfa: {callsign} FlyApproachPathPointList overwritten ({pathList.Count} pts)");
            }
            catch (Exception ex)
            {
                Plugin.LogMsg($"cfa: {callsign} step 4c FAILED: {ex.GetType().Name}: {ex.Message}");
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
                    Plugin.LogMsg($"cfa: {callsign} state check: ApproachState stPath={ParamTrace.ListSummary(st._pathPointList)} stPr={st.GetProgressRatio():F3} ch={ParamTrace.DescribeParams(dp.DynamicsParams)} — {(mismatch ? "MISMATCH — rewriting" : "matches our path")}");
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

        // 9) SMOOTH TURN (2026-08-03): the state transition + path overwrite
        //     means the game's next Step writes the approach path-tangent
        //     heading verbatim — the one-frame snap at the handoff. Plant a
        //     FollowGameHeading entry instead: Phase 1 = pass-through (the
        //     nose keeps flying the STAR freely until the handoff ACTUALLY
        //     lands — the deferred CommandContinueApproach flow takes ~3 s;
        //     locking early would fight the STAR's own turns), then Phase 2
        //     = lock: rotate the nose from where it actually points onto the
        //     game's own approach heading at the standard rate (game-time-
        //     aware, pauses with the game), dropping once converged. The
        //     transition signal is the aircraft-level state machine (not-Fly
        //     = the handoff landed); see OnAircraftStep.
        var turnRate = turnRateDeg > 0f ? turnRateDeg : ClearForApprTurnRateDeg;
        if (turnRate > 0f && ac.Direction.sqrMagnitude > 1e-6f)
        {
            // Re-applied mid-turn (a second cfa frame): continue from the
            // existing entry's Current; otherwise start from the real nose.
            var nose = _overrides.TryGetValue(ac, out var existing) && existing.Current.sqrMagnitude > 1e-6f
                ? existing.Current : ac.Direction.normalized;
            _overrides[ac] = new Entry {
                Direction = Vector3.zero,
                Current = nose,
                TurnRateDeg = turnRate,
                FollowGameHeading = true,
            };
            Plugin.LogMsg($"override: {callsign} cfa-turn: nose {HeadingDeg(nose):F1}° → smooth turn armed ({turnRate:F0}°/s game-time; locks when the approach transition lands)");
        }

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

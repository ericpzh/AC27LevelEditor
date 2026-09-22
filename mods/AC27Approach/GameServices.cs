using System;
using ContextCross.Aircrafts;
using ContextCross.Managers;
using UnityEngine;
using VContainer;
using VContainer.Unity;

namespace AC27Approach;

/// <summary>
/// Shared game-service lookups (VContainer scope scan) for the plugin's
/// non-patch paths — the command receiver and diagnostics. Mirrors the
/// resolution pattern used by TelemetryEmitter / OverrideController.
/// </summary>
internal static class GameServices
{
    /// <summary>Resolve a game service from the active VContainer scope.</summary>
    public static T Resolve<T>() where T : class
    {
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            try { if (scope.Container.TryResolve(out T svc) && svc != null) return svc; } catch { }
        }
        return null;
    }

    /// <summary>
    /// The per-level manager tracking every loaded aircraft. Re-resolved on each
    /// call (the manager is recreated per level) and the scope with the most
    /// aircraft wins, so a stale scope can never be picked.
    /// </summary>
    public static AircraftApproachSequencingManager Sequencer()
    {
        AircraftApproachSequencingManager best = null;
        int bestCount = -1;
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            AircraftApproachSequencingManager m;
            try { if (!scope.Container.TryResolve(out m) || m == null) continue; } catch { continue; }
            int n = 0;
            try { n = m.aircraftList?.Count ?? 0; } catch { }
            if (n > bestCount) { bestCount = n; best = m; }
        }
        return best;
    }

    /// <summary>Find a live aircraft by callsign (manager list, then approach sequence).</summary>
    public static Aircraft FindAircraft(string callSign)
    {
        if (string.IsNullOrEmpty(callSign)) return null;
        var mgr = Sequencer();
        if (mgr == null) return null;

        var hit = FindIn(SafeList(() => mgr.aircraftList), callSign)
               ?? FindIn(SafeList(() => mgr.AircraftApproachSequence?.Aircrafts), callSign);
        return hit;
    }

    private static Il2CppSystem.Collections.Generic.List<Aircraft> SafeList(
        Func<Il2CppSystem.Collections.Generic.List<Aircraft>> f)
    {
        try { return f(); } catch { return null; }
    }

    private static Aircraft FindIn(Il2CppSystem.Collections.Generic.List<Aircraft> list, string callSign)
    {
        if (list == null) return null;
        try
        {
            for (int i = 0; i < list.Count; i++)
            {
                var ac = list[i];
                if (ac == null) continue;
                string cs;
                try { cs = ac.CallSign; } catch { continue; }
                if (string.Equals(cs, callSign, StringComparison.Ordinal)) return ac;
            }
        }
        catch { }
        return null;
    }
}

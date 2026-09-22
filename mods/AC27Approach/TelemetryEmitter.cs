using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using ContextCross.Aircrafts;
using ContextCross.Aircrafts.Policies;
using ContextCross.Clock;
using ContextCross.Managers;
using ContextCross.Models;
using ContextCross.Services;
using UnityEngine;
using VContainer;
using VContainer.Unity;

namespace AC27Approach;

/// <summary>
/// Emits the GATC v2 aircraft telemetry datagram the editor ingests on
/// 127.0.0.1:20266, at the game's 10 Hz cadence.
///
/// Why the plugin owns this now: the AC27 shipping build dropped
/// ContextCross.Telemetry entirely (no AircraftUdpTelemetryService / no
/// AircraftTelemetryPacketWriter), so nothing emits the radar/strips feed.
/// The aircraft data itself is still fully present — it is read here from the
/// live AircraftApproachSequencingManager (the per-level service that tracks
/// every loaded aircraft) and serialized with the TelemetryProtocol layout.
///
/// Field mapping to the editor's record (electron/udp_listener.js):
///   callSign        ← Aircraft.CallSign
///   aircraftType    ← Aircraft.Specification.Designator
///   flightDirection ← Aircraft.IsArrival (1) / departure (0)
///   controlSeat     ← Aircraft.CurrentRadioChannel.Type (Ramp..Apron → 1..7)
///   seatSequence    ← 1-based order within the seat group (as emitted)
///   telemetryStatus ← IsWaitingForCommands→2, IsHandoffPending→3, parked→4/5, else 1
///   position/nose   ← Aircraft.Position / .Direction
///   taxiSpeed       ← Aircraft.TaxiSpeed.Value
///   airSpeedKnot    ← Aircraft.AirSpeedKnot.Value
///   star            ← FlightPlan.GetStar()
///   runway/stand    ← Aircraft.RunwayName / .StandName
///   route           ← Aircraft.Route
/// timeScale/isPaused come from the resolved GameTime.
/// </summary>
internal sealed class TelemetryEmitter : MonoBehaviour
{
    private const float IntervalSec = 0.1f;     // 10 Hz — the game's cadence
    private const int MaxRecords = 256;
    private const int TicksPerPacket = 6;       // ≈60 Hz sim ticks at a 10 Hz send

    // telemetryStatus values (editor: 0 Unknown, 1 Active, 2 ActionRequired,
    // 3 HandoffPending, 4 PendingAtStand, 5 CompletedAtStand)
    private const byte StatusActive = 1;
    private const byte StatusActionRequired = 2;
    private const byte StatusHandoffPending = 3;
    private const byte StatusPendingAtStand = 4;
    private const byte StatusCompletedAtStand = 5;

    private static readonly IPEndPoint Dest = new(IPAddress.Loopback, TelemetryProtocol.TelemetryPort);

    private readonly byte[] _buf = new byte[TelemetryProtocol.HeaderSize + TelemetryProtocol.RecordSize * MaxRecords];
    private readonly List<Aircraft> _scratch = new(MaxRecords);
    private readonly Dictionary<int, int> _seatCounts = new();

    private Socket _socket;
    private float _nextSend;
    private float _nextResolve;
    private float _nextLog;
    private ulong _tick;
    private ushort _heartbeat;
    private long _sends;
    private bool _failLogged;
    private bool _levelActive;        // false while at the menu / between levels
    private bool _needHasLevelLow;    // first frame after (re)activation advertises hasLevel=0

    private AircraftApproachSequencingManager _sequencer;
    private AirportInfrastructureSizeLimitService _limits;
    private GameTime _gameTime;
    private string _srcName = "none";
    private int _srcTotal;
    private int _mgrCount;
    private int _seqCount;
    private readonly HashSet<string> _seenCs = new(StringComparer.Ordinal);

    private void Awake()
    {
        try
        {
            _socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            Plugin.LogMsg($"telemetry: emitter ready — 10 Hz → 127.0.0.1:{TelemetryProtocol.TelemetryPort}");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"telemetry: socket setup FAILED — {ex.GetType().Name}: {ex.Message}");
        }
    }

    private void OnDestroy()
    {
        try { _socket?.Close(); } catch { }
        _socket = null;
    }

    private void Update()
    {
        if (_socket == null) return;
        float now = Time.unscaledTime;
        if (now < _nextSend) return;
        _nextSend = now + IntervalSec;

        try { Emit(); }
        catch (Exception ex)
        {
            if (!_failLogged) { _failLogged = true; Plugin.LogMsg($"telemetry: emit FAILED — {ex.GetType().Name}: {ex.Message}"); }
        }
    }

    private void Emit()
    {
        if (Time.unscaledTime >= _nextResolve) ResolveServices();

        string icao = null;
        try { icao = _limits?.AirportIcao; } catch { }

        // Level-teardown STOP: the removed AircraftUdpCommandService.Start/Dispose
        // were the per-level (re)bind / teardown signal. With no level scope the
        // editor must be told the session ended — emit ONE final hasLevel=0 frame
        // and then go silent, so the editor's 5 s stale timeout clears the aircraft
        // and raises the "no live session" overlay (a continuous heartbeat would
        // keep the stale state alive forever).
        bool active = _sequencer != null || !string.IsNullOrEmpty(icao);
        if (!active)
        {
            if (_levelActive)
            {
                _levelActive = false;
                Plugin.LogMsg("telemetry: level teardown — emitting STOP frame, then silent until a level loads");
                try { OverrideController.ResetForLevelLoad("level teardown — no level scope"); } catch { }
                try
                {
                    int stop = WriteStopFrame();
                    _socket.SendTo(_buf, 0, stop, SocketFlags.None, Dest);
                    _heartbeat++; _sends++;
                }
                catch { }
            }
            return;
        }

        if (!_levelActive)
        {
            _levelActive = true;
            _needHasLevelLow = true;   // force a 0→1 hasLevel transition so the editor resets
        }

        bool hasLevel = !string.IsNullOrEmpty(icao) && !_needHasLevelLow;
        int paused, timeScale;
        ReadClock(out paused, out timeScale);

        int n = WriteHeaderAndRecords(icao, hasLevel, paused != 0, timeScale);
        _needHasLevelLow = false;
        _socket.SendTo(_buf, 0, TelemetryProtocol.HeaderSize + n * TelemetryProtocol.RecordSize, SocketFlags.None, Dest);
        _heartbeat++;
        _tick += TicksPerPacket;
        _sends++;

        if (Time.unscaledTime >= _nextLog)
        {
            _nextLog = Time.unscaledTime + 5f;
            Plugin.LogMsg($"telemetry: icao={(hasLevel ? icao : "-")} records={n} src={_srcName} total={_srcTotal} clock={_gameTime != null} x{timeScale} sends={_sends}{Sample()}");
        }
    }

    /// <summary>Final teardown frame: header only, 0 records, hasLevel cleared.</summary>
    private int WriteStopFrame()
    {
        var b = _buf;
        Array.Clear(b, 0, TelemetryProtocol.HeaderSize);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(TelemetryProtocol.HMagic), TelemetryProtocol.Magic);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HVersion), TelemetryProtocol.Version);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HHeaderSize), TelemetryProtocol.HeaderSize);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HRecordSize), TelemetryProtocol.RecordSize);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HRecordCount), 0);
        BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(TelemetryProtocol.HSimTimeMs), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        b[TelemetryProtocol.HSimFlags] = TelemetryProtocol.FlagStarted;   // no hasLevel → session ended
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HHeartbeat), _heartbeat);
        return TelemetryProtocol.HeaderSize;
    }

    /// <summary>One-line per-aircraft diagnostic (log only) — callsign, seat, raw channel, status, altitude, stand/runway.</summary>
    private string Sample()
    {
        if (_scratch.Count == 0) return " sample:[]";
        var sb = new StringBuilder();
        int k = Math.Min(12, _scratch.Count);
        for (int i = 0; i < k; i++)
        {
            var ac = _scratch[i];
            var p = SafePosition(ac);
            sb.Append($" [{Safe(() => ac.CallSign)} seat={SeatOf(ac)} ch={ChannelName(ac)} st={Status(ac)} y={p.y:F1} stand={Safe(() => ac.StandName)} rwy={Safe(() => ac.RunwayName)}]");
        }
        return " sample:" + sb;
    }

    private static string ChannelName(Aircraft ac)
    {
        try { return ac.CurrentRadioChannel?.Type.ToString() ?? "null"; } catch { return "err"; }
    }

    private void ReadClock(out int paused, out int timeScale)
    {
        paused = 0; timeScale = 0;
        if (_gameTime == null) return;
        try
        {
            float ts = _gameTime.TimeScale;
            timeScale = Mathf.Clamp(Mathf.RoundToInt(ts), 0, 255);
            if (ts <= 0f) paused = 1;
        }
        catch { }
    }

    /// <summary>
    /// Resolve the per-level services. These are recreated on every level load
    /// (VContainer level scope), so a cached reference goes stale after the
    /// first airport — the manager keeps returning the OLD level's aircraft,
    /// which is why only the first airport streamed. Re-resolve every second and
    /// prefer the scope whose manager tracks the most aircraft (the live level).
    /// </summary>
    private void ResolveServices()
    {
        _nextResolve = Time.unscaledTime + 1f;

        LifetimeScope bestScope = null;
        AircraftApproachSequencingManager best = null;
        int bestCount = -1;

        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            AircraftApproachSequencingManager m;
            try { if (!scope.Container.TryResolve(out m) || m == null) continue; }
            catch { continue; }

            int n = SafeCount(m.aircraftList);
            if (n > bestCount) { bestCount = n; best = m; bestScope = scope; }
        }

        _sequencer = best;
        if (bestScope == null)
        {
            // No level scope (menu / between levels) — drop the stale per-level
            // services so `active` goes false and the STOP frame is emitted.
            _limits = null;
            _gameTime = null;
            return;
        }

        // Resolve the rest from the SAME scope so the airport ICAO and clock
        // always belong to the level the aircraft came from.
        try { if (bestScope.Container.TryResolve(out AirportInfrastructureSizeLimitService lim) && lim != null) _limits = lim; } catch { }
        try { if (bestScope.Container.TryResolve(out GameTime gt) && gt != null) _gameTime = gt; } catch { }
    }

    /// <summary>Resolve a game service from the active VContainer scope (same pattern as OverrideController).</summary>
    private static T Resolve<T>() where T : class
    {
        foreach (var scope in UnityEngine.Object.FindObjectsOfType<LifetimeScope>())
        {
            if (scope.Container == null) continue;
            try { if (scope.Container.TryResolve(out T svc) && svc != null) return svc; }
            catch { }
        }
        return null;
    }

    private int WriteHeaderAndRecords(string icao, bool hasLevel, bool paused, int timeScale)
    {
        var b = _buf;

        // ── header (40 B) ──
        Array.Clear(b, 0, TelemetryProtocol.HeaderSize);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(TelemetryProtocol.HMagic), TelemetryProtocol.Magic);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HVersion), TelemetryProtocol.Version);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HHeaderSize), TelemetryProtocol.HeaderSize);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HRecordSize), TelemetryProtocol.RecordSize);
        WriteAscii(b, TelemetryProtocol.HIcao, 4, icao);
        BinaryPrimitives.WriteUInt64LittleEndian(b.AsSpan(TelemetryProtocol.HSimTick), _tick);
        BinaryPrimitives.WriteInt64LittleEndian(b.AsSpan(TelemetryProtocol.HSimTimeMs), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        b[TelemetryProtocol.HSimFlags] = (byte)(TelemetryProtocol.FlagStarted
            | (hasLevel ? TelemetryProtocol.FlagHasLevel : 0)
            | (paused ? TelemetryProtocol.FlagPaused : 0));
        b[TelemetryProtocol.HTimeScale] = (byte)timeScale;
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HHeartbeat), _heartbeat);

        // ── records ──
        Collect();
        _seatCounts.Clear();
        int n = 0;
        for (int i = 0; i < _scratch.Count && n < MaxRecords; i++)
        {
            var ac = _scratch[i];
            int seat = SeatOf(ac);
            int seq = 0;
            if (seat > 0)
            {
                _seatCounts.TryGetValue(seat, out var c);
                c++;
                _seatCounts[seat] = c;
                seq = c > 255 ? 255 : c;
            }
            if (WriteRecord(ac, n, (byte)seat, (byte)seq)) n++;
        }

        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(TelemetryProtocol.HRecordCount), (ushort)n);
        return n;
    }

    /// <summary>
    /// Snapshot the live aircraft list — the UNION of the manager's tracked
    /// list (all loaded aircraft) and the published approach sequence, deduped
    /// by callsign. The approach sequence alone omits stand/ground traffic, so
    /// unioning is what makes the Surface radar complete.
    /// </summary>
    private void Collect()
    {
        _scratch.Clear();
        _seenCs.Clear();

        Il2CppSystem.Collections.Generic.List<Aircraft> mgr = null, seq = null;
        try { mgr = _sequencer?.aircraftList; } catch { }
        try { seq = _sequencer?.AircraftApproachSequence?.Aircrafts; } catch { }

        _mgrCount = SafeCount(mgr);
        _seqCount = SafeCount(seq);

        AddAll(mgr);
        AddAll(seq);

        _srcName = $"mgr{_mgrCount}+seq{_seqCount}";
        _srcTotal = _scratch.Count;
    }

    private void AddAll(Il2CppSystem.Collections.Generic.List<Aircraft> list)
    {
        if (list == null) return;
        try
        {
            for (int i = 0; i < list.Count && _scratch.Count < MaxRecords; i++)
            {
                var ac = list[i];
                if (ac == null) continue;
                string cs = Safe(() => ac.CallSign);
                if (string.IsNullOrEmpty(cs)) continue;
                if (!_seenCs.Add(cs)) continue;      // already added from the other source
                _scratch.Add(ac);
            }
        }
        catch { }
    }

    private static int SafeCount(Il2CppSystem.Collections.Generic.List<Aircraft> list)
    {
        try { return list?.Count ?? 0; } catch { return 0; }
    }

    private bool WriteRecord(Aircraft ac, int n, byte controlSeat, byte seatSequence)
    {
        string cs;
        try { cs = ac.CallSign; } catch { return false; }
        if (string.IsNullOrEmpty(cs)) return false;

        var b = _buf;
        int rec = TelemetryProtocol.HeaderSize + n * TelemetryProtocol.RecordSize;
        Array.Clear(b, rec, TelemetryProtocol.RecordSize);

        WriteAscii(b, rec + TelemetryProtocol.RCallSign, 12, cs);
        WriteAscii(b, rec + TelemetryProtocol.RAircraftType, 8, AircraftType(ac));
        b[rec + TelemetryProtocol.RFlightDirection] = (byte)(IsArrival(ac) ? 1 : 0);
        b[rec + TelemetryProtocol.RControlSeat] = controlSeat;
        b[rec + TelemetryProtocol.RSeatSequence] = seatSequence;
        b[rec + TelemetryProtocol.RStatus] = Status(ac);
        WriteVec3(b, rec + TelemetryProtocol.RPosition, SafePosition(ac));
        WriteVec3(b, rec + TelemetryProtocol.RNose, SafeDirection(ac));
        WriteFloat(b, rec + TelemetryProtocol.RTaxiSpeed, SafeFloat(() => ac.TaxiSpeed?.Value ?? 0f));
        WriteFloat(b, rec + TelemetryProtocol.RAirSpeed, SafeFloat(() => ac.AirSpeedKnot?.Value ?? 0f));
        WriteAscii(b, rec + TelemetryProtocol.RStar, 16, Safe(() => ac.FlightPlan?.GetStar()));
        WriteAscii(b, rec + TelemetryProtocol.RRunway, 4, Safe(() => ac.RunwayName));
        WriteAscii(b, rec + TelemetryProtocol.RStand, 8, Safe(() => ac.StandName));
        WriteAscii(b, rec + TelemetryProtocol.RRoute, 16, Safe(() => ac.Route?.CurrentValue));
        return true;
    }

    // ── field derivations (each guarded — a renamed member must never kill the feed) ──

    private static string AircraftType(Aircraft ac)
    {
        try { return ac.Specification?.Designator; } catch { return null; }
    }

    private static bool IsArrival(Aircraft ac)
    {
        try { return ac.IsArrival; } catch { return false; }
    }

    /// <summary>Editor control seat from the aircraft's current radio channel (1..7, else 0).</summary>
    private static int SeatOf(Aircraft ac)
    {
        try
        {
            var ch = ac.CurrentRadioChannel;
            if (ch == null) return 0;
            return SeatFromChannelName(ch.Type.ToString());
        }
        catch { return 0; }
    }

    private static int SeatFromChannelName(string name) => name switch
    {
        "Ramp" => 1,
        "Ground" => 2,
        "Tower" => 3,
        "Departure" => 4,
        "Approach" => 5,
        "Delivery" => 6,
        "Apron" => 7,
        _ => 0,
    };

    /// <summary>
    /// Approximates the game's telemetry status: awaiting a command → ActionRequired;
    /// a pending radio handoff → HandoffPending; parked at a stand → Pending/Completed;
    /// otherwise Active. (Same values the editor colours strips from.)
    /// </summary>
    private static byte Status(Aircraft ac)
    {
        bool waiting = SafeBool(() => ac.IsWaitingForCommands?.CurrentValue ?? false);

        if (waiting) return StatusActionRequired;

        bool handoff = false;
        try { handoff = AircraftRadioTransferPolicy.IsHandoffPending(ac.CurrentRadioChannel, ac.JurisdictionRadioChannel?.CurrentValue); } catch { }
        if (handoff) return StatusHandoffPending;

        if (IsParked(ac))
        {
            bool hasDeparture = true;
            try { hasDeparture = ac.FlightPlan?.HasDepartureLeg ?? true; } catch { }
            return hasDeparture ? StatusPendingAtStand : StatusCompletedAtStand;
        }

        return StatusActive;
    }

    private static bool IsParked(Aircraft ac)
    {
        try
        {
            bool flying = ac.IsFlying?.CurrentValue ?? false;
            float air = ac.AirSpeedKnot?.Value ?? 0f;
            float taxi = ac.TaxiSpeed?.Value ?? 0f;
            return !flying && air <= 1f && taxi <= 0.1f;
        }
        catch { return false; }
    }

    private static Vector3 SafePosition(Aircraft ac)
    {
        try { return ac.Position; } catch { return Vector3.zero; }
    }

    private static Vector3 SafeDirection(Aircraft ac)
    {
        try { return ac.Direction; } catch { return Vector3.zero; }
    }

    private static bool SafeBool(Func<bool> f) { try { return f(); } catch { return false; } }
    private static float SafeFloat(Func<float> f) { try { return f(); } catch { return 0f; } }
    private static string Safe(Func<string> f) { try { return f(); } catch { return null; } }

    // ── buffer helpers ────────────────────────────────────────────────
    private static void WriteVec3(byte[] b, int off, Vector3 v)
    {
        BitConverter.TryWriteBytes(b.AsSpan(off), v.x);
        BitConverter.TryWriteBytes(b.AsSpan(off + 4), v.y);
        BitConverter.TryWriteBytes(b.AsSpan(off + 8), v.z);
    }

    private static void WriteFloat(byte[] b, int off, float v) => BitConverter.TryWriteBytes(b.AsSpan(off), v);

    /// <summary>NUL-padded fixed-width ASCII (the editor trims at the first NUL).</summary>
    private static void WriteAscii(byte[] b, int off, int len, string s)
    {
        if (string.IsNullOrEmpty(s)) return;
        int m = Math.Min(len, s.Length);
        for (int i = 0; i < m; i++) b[off + i] = (byte)s[i];   // ASCII callsigns/labels — no transcoding needed
    }
}

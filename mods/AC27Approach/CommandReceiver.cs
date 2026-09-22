using System;
using System.Net;
using System.Net.Sockets;
using UnityEngine;

namespace AC27Approach;

/// <summary>
/// Receives the editor's command frames on 127.0.0.1:20267 and dispatches them
/// to <see cref="OverrideController"/>.
///
/// On the AC27 shipping build there is no native AircraftUdpCommandService to
/// hook, so the plugin owns the command socket itself (replacing the old
/// Mechanism A/B receive-buffer capture). On a build that still has the native
/// service (e.g. the 25 Playtest), the receiver disables itself so it never
/// competes for the port.
/// </summary>
internal sealed class CommandReceiver : MonoBehaviour
{
    private Socket _socket;
    private readonly byte[] _buf = new byte[2048];
    private EndPoint _from = new IPEndPoint(IPAddress.Any, 0);
    private bool _bound;

    private void Awake()
    {
        if (NativeServicePresent())
        {
            Plugin.LogMsg("commands: native AircraftUdpCommandService present — receiver disabled");
            enabled = false;
            return;
        }
        try
        {
            _socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            _socket.Bind(new IPEndPoint(IPAddress.Loopback, TelemetryProtocol.CommandPort));
            _socket.Blocking = false;
            _bound = true;
            Plugin.LogMsg($"commands: receiver bound 127.0.0.1:{TelemetryProtocol.CommandPort}");
        }
        catch (Exception ex)
        {
            Plugin.LogMsg($"commands: bind FAILED — {ex.GetType().Name}: {ex.Message}");
        }
    }

    private void OnDestroy()
    {
        try { _socket?.Close(); } catch { }
        _socket = null;
    }

    private void Update()
    {
        if (_socket == null || !_bound) return;

        // Drain everything queued this frame (non-blocking).
        for (int guard = 0; guard < 64; guard++)
        {
            int n;
            try { n = _socket.ReceiveFrom(_buf, 0, _buf.Length, SocketFlags.None, ref _from); }
            catch (SocketException se) when (se.SocketErrorCode == SocketError.WouldBlock) { break; }
            catch { break; }
            if (n <= 0) break;

            var datagram = new byte[n];
            Array.Copy(_buf, datagram, n);
            try { Patches.DispatchDatagram(datagram); }
            catch (Exception ex) { Plugin.LogMsg($"commands: dispatch FAILED — {ex.GetType().Name}: {ex.Message}"); }
        }
    }

    /// <summary>True when the build still ships the game's own UDP command service.</summary>
    private static bool NativeServicePresent()
    {
        try { return Type.GetType("ContextCross.Telemetry.AircraftUdpCommandService, GroundATC.Core") != null; }
        catch { return false; }
    }
}

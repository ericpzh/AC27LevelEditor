namespace AC27Approach;

/// <summary>
/// Wire layout shared with the editor. The editor's parser
/// (electron/udp_listener.js) is authoritative for the telemetry datagram and
/// electron/udp_remote_control.md for the command frame — change these
/// constants only alongside it.
///
/// The AC27 shipping build no longer contains ContextCross.Telemetry
/// (AircraftUdpCommandService / UdpCommandParser / AircraftTelemetryPacketWriter),
/// so the plugin carries the layout itself.
/// </summary>
internal static class TelemetryProtocol
{
    // ── Telemetry datagram (plugin → editor, 127.0.0.1:20266) ─────────
    public const uint Magic = 0x43544147;   // ASCII "GATC"
    public const ushort Version = 2;
    public const int HeaderSize = 40;
    public const int RecordSize = 112;
    public const int TelemetryPort = 20266;

    // header offsets
    public const int HMagic = 0;            // u32
    public const int HVersion = 4;          // u16
    public const int HHeaderSize = 6;       // u16
    public const int HRecordSize = 8;       // u16
    public const int HRecordCount = 10;     // u16
    public const int HIcao = 12;            // 4 bytes ASCII
    public const int HSimTick = 16;         // u64
    public const int HSimTimeMs = 24;       // i64
    public const int HSimFlags = 32;        // u8
    public const int HTimeScale = 33;       // u8
    public const int HHeartbeat = 34;       // u16

    // simFlags bits
    public const byte FlagPaused = 0x01;
    public const byte FlagStarted = 0x02;
    public const byte FlagHasLevel = 0x04;

    // record offsets (relative to the record start)
    public const int RCallSign = 0;         // 12 bytes ASCII
    public const int RAircraftType = 12;    // 8 bytes ASCII
    public const int RFlightDirection = 20; // u8  0=Departure 1=Arrival
    public const int RControlSeat = 21;     // u8
    public const int RSeatSequence = 22;    // u8
    public const int RStatus = 23;          // u8
    public const int RPosition = 24;        // 3 × f32 (x,y,z)
    public const int RNose = 36;            // 3 × f32
    public const int RTaxiSpeed = 48;       // f32
    public const int RAirSpeed = 52;        // f32
    public const int RStar = 56;            // 16 bytes ASCII
    public const int RRunway = 72;          // 4 bytes ASCII
    public const int RStand = 76;           // 8 bytes ASCII
    public const int RRoute = 84;           // 16 bytes ASCII

    // ── Command frame (editor → plugin, 127.0.0.1:20267) ──────────────
    // 8 B header (magic u32 + version u16 + commandId u16) + payload.
    public const int CommandPort = 20267;
    public const int CmdHeaderSize = 8;
    public const int CMagic = 0;            // u32
    public const int CVersion = 4;          // u16
    public const int CCommandId = 6;        // u16
    public const int CPayload = 8;
    public const ushort CmdVersion = 1;
    public const ushort SelectAircraftCommandId = 1;
    public const ushort PatchCommandId = 0x00E7;
    public const int PatchPayloadFieldSize = 64;   // hard contract — see PatchFrame
}

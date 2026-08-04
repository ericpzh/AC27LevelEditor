# BepInEx 6: Direct Aircraft Control — `PatchAircraft(command_type, …)` by Callsign

How to give yourself a runtime patch API with two commands — `PatchAircraft("update_position", callsign, direction, speed)` (section 4) and `PatchAircraft("clear_for_appr", callsign)` (section 6) — that actually work in-game, using the BepInEx 6 (IL2CPP) install already present in the game folder. Everything here is grounded in the Cpp2IL dump of `GameAssembly.dll` (see `aircraft-classes-report.md` / `aircraft-classes-inventory.md`) and in the editor's own ACL writers (`src/acl/approach.js`), which define the exact serialized format the game expects.

- **Game**: Airport Control 25 (Playtest), Unity 6000.3.12f1, IL2CPP metadata v39
- **BepInEx**: 6 IL2CPP at `D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest\BepInEx\`
  - `core\` — BepInEx + Harmony (`0Harmony.dll`) + Il2CppInterop runtime
  - `interop\` — Il2CppInterop-generated managed stubs of every game assembly (`GroundATC.Core.dll`, `VContainer.dll`, `R3.dll`, `UniTask.dll`, `Unity.Splines.dll`, …) — these are the DLLs your plugin references
  - `plugins\` — drop your compiled plugin DLL here

---

## 1. How the game moves an aircraft (the pieces that matter)

The game separates **model** from **view**:

| Layer | Class | Notes |
|---|---|---|
| Core entity (model) | `ContextCross.Aircrafts.Aircraft` | Plain class, **not** a MonoBehaviour. `[Serialize]` fields, state machine, flight plan. Ticked by the game's fixed-tick pipeline: `public void Step()` |
| Dynamics engine | `ContextCross.Dynamics.Dynamics` | Per-tick physics/spline integration: `public AircraftDynamicsOutput Update(AircraftDynamicsInput, float deltaTime)` |
| Serialized dynamics state | `AircraftDynamicsData` | `TaxiSpeed`, `DynamicsTargetTaxiSpeed`, `Positive/NegativeTaxiAcceleration`, `DynamicsState`, `DynamicsParams` — all `[Serialize]` |
| 3D view | `ContextCross.Aircrafts.Aircraft3D : ManagedBehaviour` | MonoBehaviour on the 3D aircraft GameObject. `public Aircraft Source`. Subscribes to the model's reactive properties and applies them to the GameObject (`SetWorldPosition` / `SetDirection`) |
| 2D/radar view | `ContextCross.View._2D.Aircraft2D : ManagedBehaviour` | Same — driven off the same `Aircraft` model |
| HD view | `ContextCross.HD.AircraftHD : ManagedBehaviour` | Same pattern |
| Tick base | `ContextCross.ManagedBehaviour : MonoBehaviour` | `FixedUpdate()` → `protected virtual void Step()` — the view step |
| Global tick | `ContextCross.Managers.TickManager` | Fixed 60 TPS clock (`TickPerSecond = 60`), drives `IFixedTickable`/`ITickable` |

**Consequence:** the `Aircraft` model is the single source of truth. Write to `Aircraft.Position` / `Aircraft.Direction` (public properties backed by `[Serialize] ReactiveProperty<Vector3>` fields `_position` / `_direction`) and the 3D model, radar sprite, and all UI update automatically through the reactive bindings. There is exactly **one** place the game writes the model position back: `Aircraft.Step()`, which runs the dynamics `Update()` and copies `AircraftDynamicsOutput` into the reactive properties. That makes `Aircraft.Step()` the perfect Harmony patch target.

Key public surface on `Aircraft` (from the dump):

```csharp
public class Aircraft : IRuntimeEntity, IResolveByPK, IEntity, IDisposalNode, IDisposable {
    public string  CallSign { get; }                 // e.g. "DAL123"
    public string  Registration { get; }
    public Vector3 Position { get; set; }            // ReactiveProperty<Vector3> _position
    public Vector3 Direction { get; set; }           // ReactiveProperty<Vector3> _direction
    public Vector3 Velocity { get; }                 // direction * speed (derived)
    public ReactiveProperty<Vector3> PositionReactive { get; }
    public ReactiveProperty<Vector3> DirectionReactive { get; }
    public AircraftDynamicsData DynamicsData { get; }// TaxiSpeed, DynamicsTargetTaxiSpeed, ...
    public Dynamics _dynamics;                       // public field! per-frame engine
    public ReactiveProperty<float> TaxiSpeed;        // public field
    public ReactiveProperty<float> AirSpeedKnot;     // public field
    public ReactiveProperty<float> HeightFeet;       // public field
    public ReactiveProperty<DynamicsModeType> KinematicMode; // public field, never set by game code
    public void Step();                              // <- Harmony target
    public void ActivateCollisions();  public void DeactivateCollisions();
    public bool IsInState(EAircraftState state);
    public State GetDynamicsState();
}
```

`Dynamics.Update` signature (verified):

```csharp
public struct AircraftDynamicsInput  { public Vector3 Position; public Vector3 Direction; public bool ForwardSpeed; }
public struct AircraftDynamicsOutput { public Vector3 Position; public Vector3 Direction; public float FrontWheelSteeringAngle; }

public AircraftDynamicsOutput Update(AircraftDynamicsInput dynamicsInput, float deltaTime = 0.01666667f);
```

Speed knobs the game itself uses (all public):
- Airborne: `Dynamics.AirSpeedKnot`, `Dynamics.VerticalSpeedKnot` (read); `Aircraft.AirSpeedKnot.Value = ...` (write)
- Taxiing: `Dynamics.DynamicsTargetTaxiSpeed` (set), `Dynamics.TaxiSpeed` (set), `AircraftDynamicsData.DynamicsTargetTaxiSpeed`

---

## 2. Finding an aircraft by callsign at runtime

Two ways, both verified against the dump:

### 2a. Via the view (recommended for a plugin — zero DI needed)

`Aircraft3D`, `Aircraft2D` and `AircraftHD` are MonoBehaviours with a public `Source` property, so you can scan the scene:

```csharp
using UnityEngine;

static Aircraft FindByCallsign(string callsign) {
    foreach (var v in Object.FindObjectsOfType<Aircraft3D>())   // interop generic overload
        if (v.Source != null && v.Source.CallSign == callsign)
            return v.Source;
    return null;
}
```

`Aircraft.CallSign` is the flight-strip callsign (what you type in the overlay). Keep a `Dictionary<Aircraft, ...>` keyed by the instance and only re-scan when the callsign is not found — `FindObjectsOfType` per frame is wasteful, per-command is fine.

### 2b. Via the game's entity registry (canonical)

The game enumerates aircraft itself through `GameStateRegistry : IGameStateRegistry`:

```csharp
IEnumerable<T> GetEntities<T>();     // IGameStateRegistry
T GetEntity(string pk);              // pk = "aircraft:" + registration (Aircraft.BuildPk)
```

The concrete registry lives in `ContextCross.States.GameStateRegistry`, constructed by VContainer DI. You can reach it from a plugin without touching DI by reading the private field off `GameManager` (it is `IFixedTickable`, alive for the whole session) with Harmony `Traverse`/`AccessTools.Field`, or by resolving it from a scene `LifetimeScope`:

```csharp
using VContainer;  // interop\VContainer.dll
var scope = Object.FindObjectsOfType<LifetimeScope>().FirstOrDefault(s => s.Container != null && s.Container.CanResolve(typeof(IGameStateRegistry)));
var registry = scope?.Container.Resolve<IGameStateRegistry>();   // -> GetEntities<Aircraft>()
```

2a is simpler and sufficient; 2b is what the game's own API endpoints use (`AircraftListEndpoint` does `_registry.GetEntities<Aircraft>()`).

---

## 3. The override strategy

The dynamics engine recomputes `Position`/`Direction` every tick inside `Aircraft.Step()`. An override therefore has to run **after** that write-back, every tick. Two designs:

### Design A — postfix on `Aircraft.Step()` (recommended)

```csharp
[HarmonyPatch(typeof(Aircraft), "Step")]
static class AircraftStepPatch {
    static void Postfix(Aircraft __instance) => OverrideController.OnAircraftStep(__instance);
}
```

After the game finishes the tick (dynamics integration + reactive write-back), we overwrite position/direction with the commanded kinematic value. **All game logic still runs** — state machine, radio, events, runway coordination, taxi coordination — only the aircraft's world pose and speed readout are ours. Release the override and the aircraft continues from wherever it is.

### Design B — prefix on `Dynamics.Update()` (full kinematic bypass)

```csharp
[HarmonyPatch(typeof(Dynamics), nameof(Dynamics.Update))]
static class DynamicsUpdatePatch {
    static bool Prefix(Dynamics __instance, ref AircraftDynamicsOutput __result,
                       AircraftDynamicsInput dynamicsInput, float deltaTime) {
        // skip the whole dynamics integration; fabricate the output
        __result = new AircraftDynamicsOutput {
            Position  = __instance.Position + __instance.Direction * speedMs * deltaTime,
            Direction = __instance.Direction,
        };
        return false;   // don't run the original
    }
}
```

Bypasses spline/path/acceleration logic entirely. Trade-off: internal dynamics state (`AirSpeedKnot`, `HeightFeet`, state-machine progress like `GetProgressRatio()`) stops updating, so you must also write `Aircraft.AirSpeedKnot.Value` / `TaxiSpeed.Value` yourself, and the approach/landing sequence (TouchDown, rollout) will not complete based on position — the dynamics state machine is what fires those, not the coordinates. Design A keeps the game "honest" about everything except the pose.

**The report's `patchAircraft()` uses Design A.**

### Where speed goes

- **Airborne**: `aircraft.AirSpeedKnot.Value = speedKnots;` (the flight strip / projection `AircraftProjection.AirSpeedKnots` reads this).
- **On ground**: `aircraft.TaxiSpeed.Value = speedMs;` and `aircraft.DynamicsData.DynamicsTargetTaxiSpeed = speedMs;` so the game's own taxi controllers agree with us.
- **Positional integration** (world units): `Position += Direction * speedKnots * KNOT_TO_MS * dt`, `KNOT_TO_MS ≈ 0.514444`. The game's world is Unity meters; the projection exposes speeds in knots, so knots → m/s is the natural contract. If your scene scale turns out different, calibrate once by overdriving a known heading and comparing the projection's `GroundSpeedKnots` readback to the commanded speed.
- dt must be **real** elapsed time, not the game's fixed delta: accumulate with `Time.realtimeSinceStartup` per aircraft. That keeps the override moving even when the game is paused or time-scale is changed.

---

## 4. The plugin

### 4.1 Project layout

```
AC25AircraftOverride/
├── AC25AircraftOverride.csproj
├── Plugin.cs               // BasePlugin entry
├── OverrideController.cs   // patchAircraft() + per-tick integration
├── Patches.cs              // Harmony patches
└── OverrideUi.cs           // in-game IMGUI overlay (section 5)
```

`AC25AircraftOverride.csproj` (net6.0; adjust `$(GameDir)` to your install):

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net6.0</TargetFramework>
    <Nullable>disable</Nullable>
    <LangVersion>10</LangVersion>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
  <ItemGroup>
    <GameDir>D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest</GameDir>
    <Reference Include="BepInEx.Core"><HintPath>$(GameDir)\BepInEx\core\BepInEx.Core.dll</HintPath></Reference>
    <Reference Include="BepInEx.Unity.IL2CPP"><HintPath>$(GameDir)\BepInEx\core\BepInEx.Unity.IL2CPP.dll</HintPath></Reference>
    <Reference Include="0Harmony"><HintPath>$(GameDir)\BepInEx\core\0Harmony.dll</HintPath></Reference>
    <Reference Include="Il2CppInterop.Common"><HintPath>$(GameDir)\BepInEx\core\Il2CppInterop.Common.dll</HintPath></Reference>
    <Reference Include="Il2CppInterop.Runtime"><HintPath>$(GameDir)\BepInEx\core\Il2CppInterop.Runtime.dll</HintPath></Reference>
    <!-- game assemblies -->
    <Reference Include="GroundATC.Core"><HintPath>$(GameDir)\BepInEx\interop\GroundATC.Core.dll</HintPath></Reference>
    <Reference Include="UnityEngine"><HintPath>$(GameDir)\BepInEx\interop\UnityEngine.dll</HintPath></Reference>
    <Reference Include="UnityEngine.CoreModule"><HintPath>$(GameDir)\BepInEx\interop\UnityEngine.CoreModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.IMGUIModule"><HintPath>$(GameDir)\BepInEx\interop\UnityEngine.IMGUIModule.dll</HintPath></Reference>
    <Reference Include="UnityEngine.InputLegacyModule"><HintPath>$(GameDir)\BepInEx\interop\UnityEngine.InputLegacyModule.dll</HintPath></Reference>
  </ItemGroup>
</Project>
```

Build output (`net6.0\AC25AircraftOverride.dll`) goes into `BepInEx\plugins\AC25AircraftOverride\`.

### 4.2 `Plugin.cs`

```csharp
using BepInEx;
using BepInEx.Unity.IL2CPP;
using BepInEx.Unity.IL2CPP.Utils;   // AddComponent<T>()
using HarmonyLib;

namespace AC25AircraftOverride;

[BepInPlugin("com.example.ac25.aircraftoverride", "AC25 Aircraft Override", "1.0.0")]
public class Plugin : BasePlugin
{
    public static Plugin Instance;

    public override void Load()
    {
        Instance = this;

        var harmony = new Harmony("com.example.ac25.aircraftoverride");
        harmony.PatchAll(typeof(Patches).Assembly);        // Aircraft.Step postfix
        // alternative manual patch:
        // harmony.Patch(AccessTools.Method(typeof(Aircraft), "Step"),
        //               postfix: new HarmonyMethod(typeof(Patches.AircraftStepPatch).GetMethod("Postfix")));

        AddComponent<OverrideUi>();                        // in-game input (section 5)

        Log.LogInfo("AC25 Aircraft Override loaded");
    }
}
```

### 4.3 `OverrideController.cs` — the `patchHeading` you asked for (heading-only, 2026-08-03)

> Decoupled 2026-08-03: speed and position are **no longer overridden** — the
> plugin writes only the heading channels. The aircraft keeps flying its own
> route at the game's own speed, pointing at the commanded heading.

```csharp
using System.Collections.Generic;
using UnityEngine;
using ContextCross.Aircrafts;

namespace AC25AircraftOverride;

public static class OverrideController
{
    private class Entry
    {
        public Vector3 Direction;      // normalized; zero = no heading command
        public int StepCount;          // diagnostics: sample the first ~0.5 s
        public Aircraft3D View;        // cached visible view (diagnostics)
    }

    private static readonly Dictionary<Aircraft, Entry> _overrides = new();

    /// <summary>Heading-only override: force the nose to `direction`.</summary>
    public static bool patchHeading(string callsign, Vector3 direction)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;

        _overrides[ac] = new Entry {
            Direction = direction.sqrMagnitude > 1e-6f ? direction.normalized : Vector3.zero,
        };
        return true;   // no speed, no position, no collision toggle
    }

    public static bool clearOverride(string callsign)
    {
        var ac = FindByCallsign(callsign);
        if (ac == null) return false;
        return _overrides.Remove(ac);   // heading only — the game resumes on the next tick
    }

    public static bool IsOverridden(Aircraft ac) => _overrides.ContainsKey(ac);

    /// <summary>Called by the Harmony postfix on Aircraft.Step(), every fixed tick.</summary>
    public static void OnAircraftStep(Aircraft ac)
    {
        if (!_overrides.TryGetValue(ac, out var e)) return;
        if (e.Direction == Vector3.zero) return;   // no heading command

        // HEADING-ONLY: position and speed are 100% the game's — the dynamics
        // keeps integrating its own route at its own speed. Only the heading
        // channels are written; the set_Direction channel lock re-points the
        // game's own per-tick direction write (the path-tangent heading).
        ac.Direction = e.Direction;
        ac.DirectionReactive.Value = e.Direction;
        ac.Rotation.Value = HeadingDeg(e.Direction);
    }

    public static Aircraft FindByCallsign(string callsign)
    {
        foreach (var v in Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source != null && v.Source.CallSign == callsign)
                return v.Source;
        return null;
    }

    public static List<string> AllCallsigns()
    {
        var list = new List<string>();
        foreach (var v in Object.FindObjectsOfType<Aircraft3D>())
            if (v.Source != null && v.Source.CallSign != null)
                list.Add(v.Source.CallSign);
        return list;
    }
}
```

> Smoothed 2026-08-03: with an optional rate the nose no longer snaps to the
> command. Each `Entry` gains `Current` (the smoothed intermediate heading —
> what is actually written each tick) and `TurnRateDeg` (°/GAME-second).
> `patchHeading` seeds `Current` from the aircraft's REAL heading at patch
> time (the turn starts where the nose actually points; a mid-turn
> re-command keeps the existing `Current` and re-targets `Direction`);
> instant mode (rate ≤ 0 / omitted) seeds `Current` AT the command so the
> pre-smoothing write path is preserved verbatim. Every fixed tick
> `OnAircraftStep` steps `Current` toward `Direction` with
> `Vector3.RotateTowards(Current, Direction, rate · Deg2Rad · fixedDeltaTime · timeScale, 0)`
> — shortest arc, wrap-safe — then writes `Current` to all three heading
> channels. **Game-time scaling:** `Time.timeScale` is the game's speed
> multiplier (pause = 0 — "Game pause sets time scale 0"; the UDP telemetry
> header's `timeScale` byte is the same value), so at ×2 the per-tick
> rotation doubles (turn completes in the same GAME time) and while paused
> `dt = 0` freezes the rotation with the game. `CommandedDirection` returns
> `Current` — the two direction-lock prefixes must feed the smoothed value,
> or the game's path-tangent write inside Step would snap the nose back to
> the full command every tick. If live testing at ×2 ever shows the turn
> finishing in HALF the game time (the game ticking 2×/wall-s at 1/60 each),
> drop the `timeScale` factor — per-tick stepping is then automatically
> game-time-correct; keep the `timeScale ≤ 0` pause gate either way.

### 4.4 `Patches.cs`

```csharp
using ContextCross.Aircrafts;
using HarmonyLib;

namespace AC25AircraftOverride;

public static class Patches
{
    [HarmonyPatch(typeof(Aircraft), nameof(Aircraft.Step))]
    [HarmonyPostfix]
    public static void AircraftStepPostfix(Aircraft __instance)
        => OverrideController.OnAircraftStep(__instance);
}
```

That's the whole mechanism: `patchAircraft("UAL223", someVector, 220f)` from anywhere (UI handler, hotkey, or an `HttpListener` thread) and the aircraft flies at 220 kt along `someVector`, per frame, until `clearOverride` is called. This is **command 1** of the unified API. **Command 2** — `clear_for_appr`, the state-30 → state-5 approach handoff with a fully populated dynamic path and touchdown position — is designed in section 6, where both commands are wrapped in a single `PatchAircraft(command_type, …)` dispatcher.

---

## 5. How to input overrides in-game

### 5.1 In-game IMGUI overlay (primary — recommended)

BepInEx 6's console is **log-output only** (interactive stdin input was removed in BepInEx 6; it is not available on the IL2CPP loader). So the practical input surface is an in-game window drawn with Unity IMGUI from the plugin itself. Add a MonoBehaviour via `AddComponent<OverrideUi>()`:

```csharp
using System.Collections.Generic;
using UnityEngine;

namespace AC25AircraftOverride;

public class OverrideUi : MonoBehaviour
{
    private bool _show;
    private string _callsign = "";
    private string _headingDeg = "90";    // compass heading, 0 = +X? see note below
    private string _speedKnots = "200";
    private string _status = "";
    private Vector2 _scroll;

    private void Update()
    {
        if (Input.GetKeyDown(KeyCode.F8)) _show = !_show;
    }

    private void OnGUI()
    {
        if (!_show) return;
        GUI.Window(777, new Rect(16, 16, 320, 360), DrawWindow, "AC25 Aircraft Override");
    }

    private void DrawWindow(int id)
    {
        GUILayout.BeginVertical();

        var callsigns = OverrideController.AllCallsigns();
        GUILayout.Label($"Aircraft in scene: {callsigns.Count}");
        _scroll = GUILayout.BeginScrollView(_scroll, GUILayout.Height(120));
        foreach (var cs in callsigns)
            if (GUILayout.Button(cs, GUILayout.Height(20)))
                _callsign = cs;
        GUILayout.EndScrollView();

        GUILayout.Label("Callsign");
        _callsign = GUILayout.TextField(_callsign);
        GUILayout.Label("Heading (deg, 0=North, 90=East)");
        _headingDeg = GUILayout.TextField(_headingDeg);
        GUILayout.Label("Speed (knots)");
        _speedKnots = GUILayout.TextField(_speedKnots);

        GUILayout.BeginHorizontal();
        if (GUILayout.Button("Apply"))
        {
            float hd = float.TryParse(_headingDeg, out var h) ? h : 0f;
            float sp = float.TryParse(_speedKnots, out var s) ? s : 0f;
            var dir = new Vector3(Mathf.Sin(hd * Mathf.Deg2Rad), 0f, Mathf.Cos(hd * Mathf.Deg2Rad));
            _status = OverrideController.patchAircraft(_callsign, dir, sp)
                ? $"Override active: {_callsign} @ {sp} kt heading {hd:0}"
                : $"Not found: {_callsign}";
        }
        if (GUILayout.Button("Clear"))
            _status = OverrideController.clearOverride(_callsign)
                ? $"Override cleared: {_callsign}"
                : $"No override: {_callsign}";
        GUILayout.EndHorizontal();

        GUILayout.Label(_status);
        GUILayout.EndVertical();
        GUI.DragWindow();
    }
}
```

> **Heading convention caveat.** The game stores direction as a `Vector3`; the dump does not pin down which axis is "north" in world space (the radar 2D layer and the 3D scene may not even share axis orientation). The UI above assumes `+Z = North, +X = East`. If the aircraft flies the wrong way, flip the formula (`-Sin`/`-Cos` or swap) — one trial run tells you. The programmatic API takes a raw `Vector3`, which is unambiguous.

**Usage**: launch the game, press **F8**, click a callsign (or type one), set heading + speed, hit **Apply**. The aircraft immediately flies the commanded vector; the radar and 3D view both follow because they read the same reactive properties. **Clear** hands control back to the ATC simulation.

### 5.2 Hotkeys (instant, no typing)

In the same `Update()`, bind quick actions, e.g.:

```csharp
if (Input.GetKeyDown(KeyCode.F9))     // stop the selected aircraft cold
    OverrideController.patchAircraft(_callsign, Vector3.zero, 0f);
if (Input.GetKeyDown(KeyCode.F10))    // resume ATC control
    OverrideController.clearOverride(_callsign);
```

### 5.3 External control (HTTP) — remote input

The game's own `ContextCross.Api` surface (`ApiGateway`, route `"aircraft.list"`, `AircraftGetEndpoint` by PK, etc.) has no network transport in the dump — it is in-process. For a remote/scripted control channel, host a tiny `HttpListener` inside the plugin (background thread) and route requests to `OverrideController.patchAircraft`:

```
POST /override  { "callsign": "UAL223", "heading": 270, "speedKt": 180 }
POST /clear     { "callsign": "UAL223" }
GET  /aircraft  -> [ "UAL223", "DAL889", ... ]
```

**Main-thread rule**: `patchAircraft` touches Unity objects (`FindObjectsOfType`, reactive properties) — marshal HTTP handling onto the main thread (a `ConcurrentQueue<Action>` drained in `Update()`) or Unity will throw `Il2CppObjectStack`/threading errors.

### 5.4 Native UDP channel — piggyback `PatchAircraft` on the game's own command socket (recommended)

**The game already runs a UDP command server, and the editor already speaks its protocol byte-for-byte.** `AircraftUdpCommandService` (`ContextCross.Telemetry`, VContainer `IStartable`/`IFixedTickable`/`IDisposable`) binds **port 20267** at startup, drains up to 64 datagrams per tick (`MaxCommandsPerTick`) from a 512-byte receive buffer (`ReceiveBufferSize`), parses each via the **static** `UdpCommandParser.TryParse(ReadOnlySpan<byte>, out UdpCommand)`, and dispatches through `Execute(in UdpCommand)` → `ExecuteSelectAircraft(string)` (a `IGameStateRegistry` lookup `candidate.CallSign == callSign`, then an `ApiGateway` event). The frame format:

| Offset | Field | Value |
|---|---|---|
| 0 | `Magic` (uint32 LE) | `1129595207` = `0x43544147` = **"GATC"** |
| 4 | `Version` (uint16 LE) | `1` |
| 6 | `CommandId` (uint16 LE) | only `1` (`SelectAircraft`) exists |
| 8 | payload | 12-byte NUL-padded ASCII callsign (20 B total) |

The editor matches exactly: `electron/udp_listener.js:35` `const MAGIC = 0x43544147` and `sendCommand()` builds the same 8-byte header — and the generic IPC **`send-udp-command(commandId, payloadB64)`** (`main.js:1926`) already forwards *any* command id + payload. So a patch command needs **zero new ports, zero new sockets** — just two Harmony prefixes and one editor-side frame builder.

**Mechanism A — reserved callsign prefix (the "special string", zero format change).**
A callsign can never start with `!`, so a `!`-prefixed 12-byte frame is silently ignored today (the registry lookup simply misses). A Harmony prefix on the dispatcher intercepts it:

```csharp
[HarmonyPatch(typeof(AircraftUdpCommandService), "Execute")]
static class Patch_Udp_Execute
{
    // "!5:<callsign>"  →  clear_for_appr  (≤12 B total, e.g. "!5:CQH8672")
    static bool Prefix(AircraftUdpCommandService __instance, UdpCommand command)
    {
        var cs = command.CallSign;
        if (string.IsNullOrEmpty(cs) || cs[0] != '!') return true;   // normal select → game as usual
        if (cs.StartsWith("!5:", StringComparison.Ordinal))
            PatchAircraft("clear_for_appr", cs.Substring(3));
        return false;                                                 // consumed — game's ExecuteSelectAircraft never runs
    }
}
```

Budget is **12 bytes total** — fine for `clear_for_appr`; `update_position`'s direction + speed cannot fit → Mechanism B. Send it through the generic IPC as a normal SelectAircraft frame (`send-udp-command(1, base64("!5:CQH8672\0\0"))`). **Do not route it through `select-aircraft-in-map`** — that handler would also set the editor's selection state and broadcast it.

**Mechanism B — extended frames with a custom command id (full commands).**
The receive loop forwards any ≤512-byte datagram to `TryParse`; only the *parser* is shape-strict. A datagram with the real magic + version but an unknown command id is today's `UnknownCommand` — logged once, ignored. A Harmony prefix on the static parser runs **before** the game's parsing with the raw span:

```csharp
[HarmonyPatch(typeof(UdpCommandParser), "TryParse")]
static class Patch_Udp_Parser
{
    private const ushort PatchCommandId = 0x00E7;   // our id — the game never emits it

    // Extended frame: 8 B header (same magic/version) + pipe-delimited ASCII payload:
    //   update_heading|CQH8672|12.5|-3.2          (heading-only — no speed field)
    //   update_heading|CQH8672|12.5|-3.2|3        (5th field = smooth-turn rate, °/s of GAME time)
    //   update_position|CQH8672|12.5|-3.2|180     (legacy alias — kts validated but ignored)
    //   clear_for_appr|CQH8672
    //   clear_for_appr|CQH8672|RNAV ILS Z RWY 01
    //   clear_for_appr|CQH8672|rate=3             (keyed rate = smooth handoff turn, °/s of game time)
    static bool Prefix(ReadOnlySpan<byte> datagram, out UdpCommand command)
    {
        command = default;
        if (datagram.Length < UdpCommandParser.HeaderSize) return true;
        if (System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(datagram.Slice(UdpCommandParser.MagicOffset, 4)) != UdpCommandParser.Magic) return true;
        if (System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(datagram.Slice(UdpCommandParser.VersionOffset, 2)) != UdpCommandParser.Version) return true;
        if (System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(datagram.Slice(UdpCommandParser.CommandIdOffset, 2)) != PatchCommandId) return true;

        var parts = System.Text.Encoding.ASCII.GetString(datagram.Slice(UdpCommandParser.PayloadOffset).ToArray()).Split('|');
        if (parts.Length >= 2)
        {
            switch (parts[0])
            {
                case "update_heading":
                case "update_position":   // legacy alias — pre-decouple name, kts ignored
                    if ((parts.Length == 4 || parts.Length == 5)
                        && float.TryParse(parts[2], out var dx) && float.TryParse(parts[3], out var dy)
                        && (parts.Length == 4 || float.TryParse(parts[4], out _)))
                    {
                        // Smoothed 2026-08-03: only update_heading reads the
                        // 5th field as a turn rate (°/s of GAME time); the
                        // legacy update_position 5th field stays kts-ignored.
                        float rate = 0f;
                        if (parts.Length == 5 && parts[0] == "update_heading"
                            && float.TryParse(parts[4], out var fifth) && fifth > 0f)
                            rate = fifth;
                        PatchAircraft("update_heading", parts[1], new Vector3(dx, 0f, dy), turnRateDeg: rate);
                    }
                    break;
                case "clear_for_appr":
                    PatchAircraft("clear_for_appr", parts[1], default, 0f, parts.Length > 2 ? parts[2] : null);
                    break;
            }
        }

        command = new UdpCommand(UdpCommandType.SelectAircraft, "@"); // benign frame the game can't resolve
        return false;                                                  // consumed — silent select miss, no log spam
    }
}
```

Both hooks funnel into the **same `PatchAircraft` dispatcher** as the overlay and HTTP (§6.4) — one switch, three input surfaces.

**Editor side** — one new IPC handler; `sendCommand` and `send-udp-command` already exist:

```js
// electron/main.js
ipcMain.handle('send-patch-command', async (_e, patch) => {
  // patch: { type: 'update_heading'|'update_position'|'clear_for_appr', callSign, dx?, dy?, rate?, kts?, appr? }
  // rate (update_heading) = smooth-turn speed in °/s of GAME time (5th frame
  // field; omitted = instant snap). rate (clear_for_appr, 2026-08-03) = the
  // same, sent as the KEYED field rate=N — a bare numeric would be misread
  // as the approach speed in kts (the plugin's cfa parser scans keyed flags).
  const parts = [patch.type, patch.callSign];
  if (patch.type === 'update_heading' || patch.type === 'update_position') {
    parts.push(patch.dx, patch.dy);
    if (patch.type === 'update_heading' && patch.rate) parts.push(patch.rate);
  }
  else if (patch.type === 'clear_for_appr') {
    if (patch.kts) parts.push(patch.kts);
    if (patch.appr) parts.push(patch.appr);
    if (patch.rate) parts.push('rate=' + patch.rate);
  }
  return await sendUdpCommand(0x00E7, Buffer.from(parts.join('|'), 'ascii'));
});
```

**Notes**
- **Ref-struct caveat**: Harmony prefixes mirror the original's parameter list, and `TryParse` takes `ReadOnlySpan<byte>` (byref-like). Current 0Harmony (BepInEx 6) supports byref-like patch params, but *verify at load* — a patch-apply failure shows in the BepInEx log. Fallback: Mechanism A's `Execute` prefix for `clear_for_appr`, and `update_position` stays on overlay/HTTP. (A `FixedTick` postfix reading the private `_receiveBuffer` via Traverse is possible but racy against the game's own drain — avoid.)
- **Trust model**: the service binds loopback and already accepts unauthenticated SelectAircraft from anything on localhost — the patch adds no new exposure. If the receive loop surfaces the sender `IPEndPoint` (`ReceiveFrom(byte[], ref IPEndPoint)`), optionally gate the dispatch on `IsLoopback`.
- **Safe rollback**: without the plugin, both mechanisms are inert — A frames miss the lookup, B frames hit `UnknownCommand` (one log line). The editor sender can ship first; removing the plugin restores stock behavior exactly.
- **Same-tick bursts**: up to 64 commands/tick are drained; batching a `clear_for_appr` + follow-up `update_position` in one tick is fine.

---

## 6. Second command: `clear_for_appr` — state 30 → 5 approach handoff

The editor's flight list works with two in-air states. The ACL stores them as the `State` field of the `ContextCross.States.AircraftState` block, and the game maps them 1:1 onto its `EAircraftState` enum:

| | State 30 — **Fly** (on the STAR) | State 5 — **Approach** (final approach) |
|---|---|---|
| `EAircraftState` | `Fly = 30` | `Approach = 5` |
| Dynamics `State` | `FlyApproaching = 1` | `Approaching = 2` |
| Dynamics params class | `FlyApproachDynamicsParams` | `ApproachDynamicsParams` |
| Params content | `ProgressRatio`, `FlyApproachPathPointList`, `AppPointList` | `ProgressRatio`, `TouchDownPosition`, `ApproachDirection`, `CommandedGoAround`, `InitialPosition`, `PathPointList` |
| `Route` label | STAR route name (e.g. `CAMRM5`) | **approach procedure name** (e.g. `RNAV ILS Z Rwy 19`) |
| Radio | Approach frequency | Tower frequency |
| Progression | player clears the approach → handoff → state 5 | flies the path, touchdown, rollout |

`clear_for_appr` performs that handoff directly — with the full approach geometry, exactly as an ACL pre-spawned state-5 aircraft would have it.

### 6.1 The ACL reference: what "fully populated" means

The editor's `buildState5AircraftBlock` (`src/acl/approach.js`) is the canonical state-5 block. The dynamic path and touchdown fields, and where the editor gets each value:

| ACL field | Value | Editor source (SceneryData) |
|---|---|---|
| `DynamicInternalState.DynamicsState` | `2` (`State.Approaching`) | constant |
| `DynamicsParams.ProgressRatio` | `0` | constant — the game re-derives position from the path (`STATE5_OUTPUT_PROGRESS_RATIO`) |
| `DynamicsParams.TouchDownPosition` | `Vector3` | runway entry's `TouchDownPoint` `$iref` → taxiway-node position |
| `DynamicsParams.ApproachDirection` | `Vector3` | `normalize(last − second-last)` point of the path (converges to runway heading) |
| `DynamicsParams.InitialPosition` | `Vector3` | first point of the path (the IAF), + glideslope Y |
| `DynamicsParams.PathPointList` | `List<Vector3>` | the **approach procedure route** (`RouteType = 1` / APP) `AirwayNodes` `$iref`s, in order, IAF → threshold |
| `Route` | `"RNAV ILS Z Rwy 19"` | the approach procedure route's `Name` |
| `WaitingForCommands` | `[22]` | `ECommand.PermitLanding` — the aircraft waits for the landing clearance |
| `RadioChannelGuid` / `JurisdictionRadioChannelGuid` | tower channel GUID | `Channels` dictionary (Type=5/`"APP"` → `"TWR"`) — the plugin mirrors this in-game: `RadioChannelManager.GetResolvedChannel(EChannel.Tower)` → written to **both** `_radioChannel` and `_jurisdictionRadioChannel` at handoff time (v2 — see §6.6) |
| `DynamicInternalState.TaxiSpeed` / `±Acceleration` | `240 / 1 / -2` | constants — the game's own `AirwayRouteService.ApproachSpeedKts = 240` |

Key selection rule from the editor: a runway may have **several** APP-route variants (ZSJN RWY 01 has three `RNAV ILS Z Rwy 01` variants starting at different fixes); `resolveApproachProcedureData` picks the variant whose first point is closest to the aircraft's current position (`hintPosition`). The in-game equivalent must do the same.

### 6.2 Where the same data lives in-game (all verified in the dump)

| ACL concept | In-game object |
|---|---|
| Runway + touchdown | `Aircraft.RunwayReactive` (public `ReadOnlyReactiveProperty<Runway>`); `Runway.TouchDownPosition` (public getter), `Runway.Direction` |
| Approach procedure routes | `AirwayRouteService` (VContainer `[Inject]` service): public `RouteDict: Dictionary<Runway, Dictionary<RouteType, List<Route>>>`, `RouteType { STAR=0, APP=1, SID=2, MissedApch=3 }`, `GetRoute(Vector3 position, Runway, RouteType)` |
| Route path points | `Route.Locations: AnyPath.Location[]` → `Location.Position` (`float3`) — the runtime equivalent of the ACL's `AirwayNodes` |
| Route label | `Route.Names: string[]` — `Names[0]` is the approach procedure name |
| Aircraft's route string | `Aircraft.Route` (public `ReadOnlyReactiveProperty<string>`, backing field `_route`) |
| STAR fallback | `Aircraft._flightPlan` (private) → `FlightPlan.GetRunway(EFlightDirection.Arrival)` / `GetStar()` (public) |
| Radio channels | `RadioChannelManager.GetResolvedChannel(EChannel.Tower)` (VContainer `[Inject]` service — the resolver `Aircraft`/`AircraftFactory`/`RuntimeAircraftSpawnService` use); fallback: `RadioSystem._radioChannelBindings` (PK → `RadioChannelBinding`) |

**Answering "do we need to pass the approach name in?":** only as a fallback. The name is derivable in-game: `AirwayRouteService.GetRoute(ac.Position, runway, RouteType.APP)` returns the approach route whose `Names[0]` is the procedure name — no caller input needed. The API keeps an optional `apprName` parameter for two cases: (1) the nearest-route heuristic picks the wrong variant (the editor has the same variant problem and solves it with `hintPosition`), and (2) you want exact ACL parity with a specific name.

### 6.3 The transition — what the game's own machinery offers

Two state machines are involved:

1. **Aircraft state machine** — `StateMachine<EAircraftState, EAircraftTrigger>` (private field `Aircraft._stateMachine`). The game's own Fly→Approach transition fires `EAircraftTrigger.Approach` (= 12), gated by the public `FlyToApproachCondition` reactive condition.
2. **Dynamics state machine** (`ContextCross.Dynamics`) — `public void FlyApproach2Approach()` is the game's own public FlyApproaching→Approaching transition. It fires the internal `_triggerApproachWithParams` (`TriggerWithParameters<State, Trigger, ApproachDynamicsParams>`), which delivers an `ApproachDynamicsParams` into `ApproachState.Init(IDynamicsParams)`.

The params travel through `Aircraft.DynamicsData` (`AircraftDynamicsData.DynamicsParams : IDynamicsParams`, `[Serialize]`) — the same channel the level loader uses to materialize an aircraft from an ACL state block (`Aircraft.ConfigureRuntimeData(…, AircraftDynamicsData)` → dynamics restore). That is exactly the seam the patch uses: **plant the params in `DynamicsData`, then fire the game's own transitions.**

> Truthfulness note: the dump is signatures only, no method bodies, so we cannot prove whether the transition action builds its own params or consumes `DynamicsData.DynamicsParams`. The design plants them first (the load-path pattern), fires the game's transitions, then **reads back** `ac.DynamicsData.DynamicsParams` and `ac.IsInState(EAircraftState.Approach)` to confirm. If the game rebuilt its own params, they come from the *same* `AirwayRouteService`/`Runway` sources in 6.2 — outcome-equivalent. The heavier, guaranteed-verbatim alternative is `ConfigureRuntimeData(...)` (see 6.4 note).

### 6.4 Implementation — the unified API

Both commands through one entry point — one function per override axis (the
heading axis is `update_heading`, section 4.3; `update_position` is a legacy
alias that lands on the same heading-only patch with its kts field ignored):

```csharp
/// <summary>Unified patch API (sections 4.3 + 6.4).</summary>
/// <param name="commandType">"update_heading" | "update_position" (legacy) | "clear_for_appr"</param>
public static bool PatchAircraft(string commandType, string callsign,
                                 Vector3 direction = default, float speedKnots = 0f,
                                 string apprName = null)
{
    switch (commandType)
    {
        case "update_heading":  return patchHeading(callsign, direction);
        case "update_position": return patchHeading(callsign, direction);   // legacy alias (kts ignored)
        case "clear_for_appr":  return clearForApproach(callsign, apprName);
        default:                return false;
    }
}
```

`clearForApproach` — the full implementation:

```csharp
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using ContextCross;                       // Route
using ContextCross.Aircrafts;
using ContextCross.Aircrafts.Enums;
using ContextCross.Dynamics;
using ContextCross.Dynamics.Enums;       // State
using ContextCross.Dynamics.States;      // ApproachDynamicsParams
using ContextCross.Enums;                // ECommand
using ContextCross.Services;             // AirwayRouteService
using VContainer;                        // LifetimeScope
using R3;                                // ReactiveProperty
using HarmonyLib;                        // Traverse

// inside OverrideController:

/// <summary>
/// Clear-for-approach: hand a STAR (state 30 / Fly) aircraft onto the final
/// approach (state 5 / Approach) with fully populated approach geometry,
/// mirroring an ACL pre-spawned state=5 aircraft (buildState5AircraftBlock).
/// </summary>
public static bool clearForApproach(string callsign, string apprName = null)
{
    var ac = FindByCallsign(callsign);
    if (ac == null) return false;

    // 1) A heading override would fight the approach — drop it (it only
    //    touched heading channels, nothing to restore).
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

    Route appr = null;
    if (!string.IsNullOrEmpty(apprName))
        appr = FindApproachRouteByName(routes, runway, apprName);
    appr ??= routes.GetRoute(ac.Position, runway, AirwayRouteService.RouteType.APP);
    if (appr == null) return false;

    // 4) Build the ACL-equivalent ApproachDynamicsParams.
    var pathList = new List<Vector3>();
    foreach (var loc in appr.Locations)
        pathList.Add((Vector3)loc.Position);          // AnyPath.Location.Position → float3
    if (pathList.Count < 2) return false;

    var p = new ApproachDynamicsParams {
        ProgressRatio = 0f,                           // game re-derives pose from path (ACL constant)
        TouchDownPosition = runway.TouchDownPosition, // public getter — runway threshold
        ApproachDirection = (pathList[pathList.Count - 1] - pathList[pathList.Count - 2]).normalized,
        CommandedGoAround = false,
        InitialPosition = pathList[0],                // IAF
        PathPointList = pathList,
    };

    // 5) Plant the params through the game's serialized channel — the same
    //    data flow the level loader uses (AircraftDynamicsData → dynamics).
    var dp = ac.DynamicsData;
    if (dp == null) return false;
    dp.DynamicsParams = p;
    dp.DynamicsState.Value = State.Approaching;       // 2 — ACL's DynamicsState
    dp.TaxiSpeed = 240f; dp.TargetTaxiSpeed = 240f; dp.ForwardSpeed = true;
    dp.PositiveTaxiAcceleration = 1f; dp.NegativeTaxiAcceleration = -2f;   // ACL constants

    // 6) Fire the game's own transitions. The aircraft-level machine (private
    //    field) is driven through Harmony Traverse; the dynamics transition
    //    is public API. try/catch because either one may drive the other.
    try { Traverse.Create(ac).Field("_stateMachine")
                   .Method("Fire", new object[] { EAircraftTrigger.Approach }).GetValue(); } catch { }
    if (ac._dynamics.CurrentState != State.Approaching)
        ac._dynamics.FlyApproach2Approach();          // public — FlyApproaching → Approaching

    // 7) Route label = approach procedure name (ACL parity).
    var name = !string.IsNullOrEmpty(apprName) ? apprName
             : (appr.Names != null && appr.Names.Length > 0 ? appr.Names[0] : "");
    if (!string.IsNullOrEmpty(name))
        Traverse.Create(ac).Field("_route").GetValue<ReactiveProperty<string>>().Value = name;

    // 8) ACL parity: the aircraft now waits for the landing clearance.
    Traverse.Create(ac).Field("_waitingForCommands")
           .GetValue<ReactiveProperty<ECommand[]>>().Value =
           new[] { ECommand.PermitLanding };          // 22 — game enum, NOT the editor's CMD_* numbers

    return true;
}

// ── helpers ──────────────────────────────────────────────────────
private static AirwayRouteService _routeService;   // cache; invalidate on level switch

private static AirwayRouteService ResolveAirwayRouteService()
{
    if (_routeService != null) return _routeService;
    foreach (var scope in Object.FindObjectsOfType<LifetimeScope>())
        if (scope.Container != null && scope.Container.CanResolve(typeof(AirwayRouteService)))
            return _routeService = scope.Container.Resolve<AirwayRouteService>();
    return null;
}

private static Runway GetArrivalRunway(Aircraft ac, AirwayRouteService routes)
{
    var rw = ac.RunwayReactive?.Value;                // assigned runway (public)
    if (rw != null) return rw;
    // fallback: flight plan → arrival runway name → registered runway
    var fp = Traverse.Create(ac).Field("_flightPlan").GetValue<FlightPlan>();
    var name = fp?.GetRunway(EFlightDirection.Arrival);
    if (string.IsNullOrEmpty(name)) return null;
    foreach (var r in routes.Runways)                 // public IReadOnlyCollection<Runway>
        if (r.Name == name || r.PhysicalName == name) return r;
    return null;
}

private static Route FindApproachRouteByName(AirwayRouteService routes, Runway runway, string name)
{
    if (routes.RouteDict != null
        && routes.RouteDict.TryGetValue(runway, out var byType)
        && byType.TryGetValue(AirwayRouteService.RouteType.APP, out var list))
        foreach (var r in list)
            if (r.Names != null && r.Names.Contains(name)) return r;
    return null;
}
```

**Runtime-verified deltas (2026-08-03, live game — supersedes the §5.4 hook points).** Harmony "applied at load" ≠ safe at runtime in this IL2CPP context. `Execute(in UdpCommand)` binds but the `in`-byref NREs inside the trampoline; `TryParse(ReadOnlySpan<byte>, out UdpCommand)`'s ref-struct param makes the Harmony DMD invalid IL — `InvalidProgramException` on **every** UDP frame, breaking the game's own select parsing. Correct hooks: Mechanism A = prefix on **`ExecuteSelectAircraft(string)`** (plain string — always binds; called for every parsed SelectAircraft command); Mechanism B = postfix on **`FixedTick()`** (public, no-arg — the service is `IFixedTickable`) reading the datagram back from the private `byte[] _receiveBuffer` field via Traverse. To keep the field-read robust, the Mechanism B payload became a **fixed 64-byte NUL-padded field** (72 B frame; find the payload by scanning for the first NUL at offset 8) with a same-frame dedup snapshot, since the postfix fires every tick and the buffer still holds the frame when no new datagram arrived. The id check at [6..8) is reliable because every datagram the game receives overwrites the header bytes and only 0x00E7 frames carry our id. Plugin logs one line per dispatched command; editor `send-patch-command` pads the field. Game-world heading convention (editor `main.js:1783`): `headingDeg = atan2(-dir.z, dir.x)` → heading H = world direction `(cos H, 0, −sin H)`; the plugin maps payload `dx,dy` → `Vector3(dx, 0, dy)`, so heading 360 = `dx=1, dy=0`.

**Build-verified deltas (2026-08-03, plugin `mods/AC27Appoarch/` compiles against the interop).** The code above was written from the raw dump, which resolves unqualified `Route` inside `AirwayRouteService` to the **nested `Runway.Route`** (not `ContextCross.Route`): `GetRoute(...)`/`RouteDict` work with `Runway.Route` = `AirwayNode[] AirwayNodes` + `string Name` (+ `EAirwayRouteType RouteType`). Path points come from `AirwayNode.Position` (a plain `UnityEngine.Vector3` — no float3 cast needed). Other interop deltas: R3's `ReadOnlyReactiveProperty<T>` exposes **`CurrentValue`** (not `Value`); VContainer `IObjectResolver` has **no `CanResolve`** — use `TryResolve(Type, out object)` (instance) or `TryResolve(out T)` (extension); the csproj must reference **`Il2Cppmscorlib.dll`** (the interop stubs compile against it — without it you get CS0012 floods); game `List<T>` fields surface as `Il2CppSystem.Collections.Generic.List<T>` (namespace `Il2CppSystem`, assembly Il2Cppmscorlib). Everything else in §6.4 (`ApproachDynamicsParams` fields, `AircraftDynamicsData.DynamicsState = R3.ReactiveProperty<State>`, `_stateMachine` = `Stateless.StateMachine<EAircraftState, EAircraftTrigger>`, Traverse field names) compiled as written.

**Guaranteed-verbatim alternative (heavier).** If the readback in step 6 shows the game rebuilt the params and you need byte-exact ACL parity: `Aircraft.ConfigureRuntimeData(FlightPlan, EAircraftState, AircraftSpecification, EFlightDirection, Vector3 position, Vector3 direction, RadioChannel radioChannel, string route, AircraftDynamicsData)` — public, and *the* function the level loader calls when materializing an ACL state block. It consumes the params verbatim. Cost: it re-initializes the whole aircraft (flight plan, radio, position, direction), so you must supply every argument — the flight plan via reflection on `_flightPlan` (or `GameStateRegistry.GetEntity("flight-plan:" + registration)`), the tower `RadioChannel` via `RadioChannelManager`, and `EFlightDirection.Arrival`.

**Numbering caveat.** The editor's `src/utils/constants/aviation.js` `CMD_*` numbers (22–47) do **not** match the game's `ECommand` enum (1–30; `ContinueApproach=21`, `PermitLanding=22`, `ContactTower=13`). The ACL's `WaitingForCommands` arrays store the game enum (`[22]` = `PermitLanding`), so the patch must use `ContextCross.Enums.ECommand` — never the editor constants.

### 6.5 Input surface

**IMGUI overlay (F8)** — add to the window from section 5.1:

```csharp
GUILayout.Label("Approach name (optional, e.g. RNAV ILS Z Rwy 19)");
_apprName = GUILayout.TextField(_apprName);
if (GUILayout.Button("Clear for Approach"))
    _status = OverrideController.PatchAircraft("clear_for_appr", _callsign, default, 0f, _apprName.Trim())
        ? $"On approach: {_callsign}"
        : $"Failed: {_callsign} (state != 30, or no APP route)";
```

**HTTP** — extend the routes from section 5.3:

```
POST /command  { "command": "clear_for_appr", "callsign": "UAL223" }
POST /command  { "command": "clear_for_appr", "callsign": "UAL223", "appr": "RNAV ILS Z Rwy 19" }
```

**UDP (recommended)** — the game's own port-20267 command channel from section 5.4, via the new `send-patch-command` IPC:

```js
electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign: 'CQH8672' });
electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign: 'CQH8672', appr: 'RNAV ILS Z RWY 01' });
// heading-only override — no speed field (the aircraft keeps the game's speed)
electronAPI.sendPatchCommand({ type: 'update_heading', callSign: 'CQH8672', dx: 12.5, dy: -3.2 });
```

The flight-strip bar and voice parser already resolve callsigns — route their confirmed matches here and the UDP channel becomes the primary input path (no F8 overlay needed in-game).

### 6.6 What this command does — and the behavior notes

After a successful `clear_for_appr`:

- The planted path starts **at the aircraft** (its position prepended as the join leg, PR=0) and runs through its OWN assigned procedure — `FlyApproachDynamicsParams.AppPointList` (the same list the game's transition builds its `ApproachState` from; `GetRoute` `AirwayNodes` is the logged fallback), not the nearest-first-fix GetRoute variant (gotcha #12). The join leg is what makes the approach RUN: the approach state holds PR=0 and does not steer until the aircraft captures `PathPointList[0]` — the pre-join-leg plant (live log 2026-08-03: CES5578/CSN2197) put that point 300–700 units from mid-STAR aircraft, so the approach sat inert for minutes of dead cruise (CSN2197 hit the 60 s phase-2 bound with the tangent never having swept >2°). Glideslope Y computed by the game from remaining path distance, exactly as it does for ACL state-5 aircraft.
- **The approach speed is ALWAYS written (2026-08-04).** `TaxiSpeed`/`TargetTaxiSpeed`/`DynamicsTargetTaxiSpeed` = the frame's `kts` or the ACL default 240 (`ApproachSpeedKts`) — log `cfa: <CS> speed: ts=… tts=… dtts=… fwd=True accel 1/-2`. The pre-v3 kts-only behavior left the fields untouched and the approach path-following crawled at ~1–4 u/s instead of ~123 u/s at 240 kt (live log 2026-08-03: `stPr` advanced 0.005/s — the aircraft crept along the STAR tail for minutes, the "did not override the path" report). The tracer now shows the channel values (`chTs=`/`chTts=`/`chDTts=`/`chFwd=`) in every dump — the crawl diagnostic; the aircraft-level `spd` read does NOT reflect them.
- It **descends, touches down at `TouchDownPosition`, and the normal rollout/taxi/stand flow resumes** — `TouchDownCondition` → `RollOut` → taxi — because the aircraft-level state is genuinely `Approach` and the dynamics state is genuinely `Approaching`.
- It **waits for the landing clearance** (`WaitingForCommands = [PermitLanding]`, ACL parity) — issue it through the normal radio UI and the flight completes like any arrival. (Remove step 8 of the code if you want it to auto-continue.)
- **Radio handoff (v2, 2026-08-04):** the patch resolves the airport's tower channel — `RadioChannelManager.GetResolvedChannel(EChannel.Tower)` via the VContainer `LifetimeScope` scan, `RadioSystem._radioChannelBindings` (PK → binding) as fallback — and writes **BOTH** `_radioChannel` and `_jurisdictionRadioChannel` to it (step 6d; logs `cfa: <CS> radio: radio <pk> → TWR(<pk>)` and `cfa: <CS> radio: jurisdiction <pk> → TWR(<pk>)`; trace fields `rc=`/`jrc=` = channel Type/PK, the re-assert detector across the tracer/watch dumps). v1 wrote only the jurisdiction slot and the aircraft stayed on the approach frequency — the tower seat still could not own it (verified live) — v2 flips both, so the strip/telemetry move to the tower seat at command time (ACL parity stores the tower channel in both slots; the real-world handoff is `ECommand.ContactTower`). No radio audio by design (the silent handoff). Resolution failure is a logged skip — the aircraft stays on approach and the game's own auto-handoff conditions (`ArrivalAircraftAutoContactTowerCondition`) self-heal on touchdown, exactly as before.
- A pending `update_heading` override on the same aircraft is **replaced by the smooth handoff turn** (step 1 removes it; step 9 plants the cfa-turn entry — the nose rotates from where it actually points onto the approach course instead of snapping).
- **The handoff turn is smooth (2026-08-03).** The state transition + path overwrite makes the game write the approach path-tangent heading verbatim the tick it lands — the one-frame snap. `clearForApproach` now plants a `FollowGameHeading` entry: the rotation TARGET is the game's OWN intended heading, stashed by the channel-lock prefixes (`SetDirectionPrefix` sees the true path-tangent heading — the only place it is visible; our own write-back through the same setter is filtered by an exact-match rule or it would stall the rotation). The lock is **phase-gated**: Phase 1 = pass-through (the nose flies the STAR freely until the handoff actually lands — native mode's deferred `CommandContinueApproach` flow takes ~3 s; locking early would fight the STAR's own turns), Phase 2 = rotate onto the approach course at the rate once the aircraft leaves `Fly` state. **The drop is SWEEP-GATED (v2, 2026-08-03):** the game's own approach turn is ALSO deferred — for ~3 s after the lock the path-tangent heading is still the STAR heading sitting on the nose, and the original "converged" drop fired against it within ~2 ticks; the game's real turn (observed live on CJX2697: `hdg 110→117→124→131→135→137` across watch steps 10–60, ~42°/s easing) then snapped the nose onto the final course. A drop now requires the tangent to have swept >2° from the lock-time snapshot (proof the deferred turn ran) and the nose to have caught it — the nose chases the game's live tangent at the rate and releases seamlessly once the tangent settles (the settled final course is the game's own intercept computation — not derivable from the planted path). Release also on the restore-revert back to `Fly`, after 10 s with no transition, or the 60 s phase-2 bound (backstop, residual gap logged). Rate comes from the frame's keyed `rate=N` field (the editor's composer sends its `TURN_RATE_DEG_S` = 3) or the plugin's `ClearForApprTurnRateDeg` default (same 3°/s). Log lines: `override: <CS> cfa-turn: nose …° → smooth turn armed …` / `… approach transition landed — rotating …` / `… game's approach turn running — tangent swept …° — nose chasing …` / `… cfa-turn converged … (tangent swept …°) … — override dropped` / `… back on the STAR (handoff reverted) — override dropped` / `… no approach transition within 10 s — override dropped` / `… 60 s phase-2 bound — override dropped`.

---

## 7. What to expect, and the gotchas

| # | Gotcha | Handling |
|---|---|---|
| 1 | **Game logic still runs.** State machine, radio, runway/stand coordination keep operating during the override; since the 2026-08-03 decouple, **only the heading is yours** — position and speed are the game's, so the aircraft keeps flying its own route (pointing at the commanded heading) and can still "land"/"reach stand" normally. | Accepted as intended. For total takeover combine with Design B or set `KinematicMode.Value = Forward` (public, unused by game code). |
| 2 | **Physics fight.** `Aircraft3D` carries a `Rigidbody` + colliders. | Obsolete since the decouple: no position is written and collisions are never deactivated — physics and route handling run untouched. (Record: the kinematic-override build used `DeactivateCollisions()`/`ActivateCollisions()` and froze the view rigidbody.) |
| 3 | **dt while paused / alt-tabbed.** Game pause sets time scale 0; `Time.fixedDeltaTime` is not real time. | Obsolete: there is no position integrator anymore (heading-only) — the game's own motion follows its own clock rules. |
| 4 | **Snap-back on clear.** The aircraft resumes the ATC path from its current position; the internal spline progress (`GetProgressRatio`, path-based) does not match the new position. | Obsolete: the override never moved the aircraft, so there is nothing to snap back — on clear the game simply resumes writing the heading itself on the next tick. |
| 5 | **Units.** Speed contract is **knots** (game projections expose `AirSpeedKnots`/`GroundSpeedKnots`). | Only a display read remains (the diagnostics' `spd` field); the plugin never writes or integrates speed. |
| 6 | **Callsign matching.** `Aircraft.CallSign` is exact ("DAL123"). Callsigns can repeat only in rare setups; first match wins. The overlay lists live callsigns so there's no guessing. | — |
| 7 | **`FindObjectsOfType` cost.** Fine per command; don't call per frame. | Cache the `Aircraft` once found; refresh on miss or when the level reloads. |
| 8 | **IL2CPP interop.** All game types (`Aircraft`, `Aircraft3D`, `Vector3` as `UnityEngine.Vector3`) come from the `interop\` stubs. Harmony patches the managed wrapper of `Aircraft.Step`; this works on IL2CPP (BepInEx 6 ships HarmonyX + Il2CppInterop precisely for this). | If a patch ever fails to apply, confirm you referenced `GroundATC.Core.dll` (interop) — not the Cpp2IL diffable sources — and that the plugin's assembly is loaded before any aircraft exists (it is: plugins load at startup). |
| 9 | **Levels without aircraft.** `Aircraft.Step` isn't reached, dict is empty — no-op. Overrides don't survive level switches (dictionary keyed by instance). | Re-apply after load; the overlay re-lists callsigns automatically. |
| 10 | **`clear_for_appr` requires state 30 (Fly).** It no-ops on aircraft already on final approach, taxiing, or parked. | The command checks `IsInState(EAircraftState.Fly)` and returns false. |
| 11 | **No teleport, no dead cruise.** The planted path starts AT the aircraft (join leg, PR=0) — the aircraft never jumps, the approach activates in place, and the steering flies it onto the procedure. (Pre-2026-08-04: the path started at the IAF 300–700 units away and the approach state held PR=0 until capture — minutes of silent cruise.) | Resolved by the join leg (step 4b). |
| 12 | **Approach route variants.** A runway can have several APP procedures (same name, different first fixes); nearest-aircraft selection may pick a different variant than the flight plan's STAR intends. | Since 2026-08-04 the planted path comes from the aircraft's OWN `AppPointList` (the variant its flight plan intends — provably the same list the game's own transition builds its `ApproachState` from); the nearest-fix `GetRoute` pick only names the route label and backs the fallback when AppPointList is unavailable. `apprName` still forces a specific procedure. |
| 13 | **`ECommand` numbering.** The editor's `CMD_*` constants (22–47) are not the game enum (1–30). | Use `ContextCross.Enums.ECommand` in the patch (`PermitLanding = 22`). |
| 14 | **12-byte callsign budget (Mechanism A).** The standard SelectAircraft frame caps at 12 B — even the heading-only `update_heading` frame (command + callsign + two floats) does not fit. | Use Mechanism B (command id `0x00E7`, extended frames) for heading commands; keep A for `clear_for_appr` and future single-arg commands. |
| 15 | **`!` prefix is reserved for patch frames.** Real callsigns never start with `!` today, but `select-aircraft-in-map` must never be used to send them — it would also set the editor's selection state and broadcast it. | Route patch frames only through `send-udp-command` / `send-patch-command`; the `Execute` prefix skips the game's selection path entirely. |
| 16 | **Harmony vs ref structs.** `UdpCommandParser.TryParse` takes `ReadOnlySpan<byte>`; if the bundled 0Harmony rejects the byref-like patch signature, Mechanism B can't apply. | Verify patch-apply in the BepInEx log; fall back to Mechanism A (`Execute` prefix) for `clear_for_appr` and keep `update_position` on overlay/HTTP. |

## 8. Verification checklist

1. Plugin loads: BepInEx log shows `AC25 Aircraft Override loaded`, no Harmony patch errors.
2. In a level, F8 → callsign list populates.
3. Apply `heading 90` to an aircraft → the nose/readouts hold 090 (property, reactive, Rotation, visible view) while the aircraft keeps flying its own route at the game's own speed — the diag shows `spd` = the game's kt and `view3D-pos` advancing along the original path.
4. Strip/UI speed readout (`AircraftProjection.AirSpeedKnots`) shows the game's own speed — unchanged by the override.
5. There is no clear command anymore (heading-only): the override ends on a level switch or `clear_for_appr`; the game resumes writing the heading itself on the next tick — nothing to restore.
6. Optional: pause the game → override keeps flying (realtime dt); resume → still correct.
7. `clear_for_appr` on a state-30 arrival → the approach activates **in place** (join leg — no teleport, no dead cruise); `ac.IsInState(EAircraftState.Approach)` is true; `DynamicsData.DynamicsState.Value == State.Approaching`; `DynamicsData.DynamicsParams is ApproachDynamicsParams` with a non-empty `PathPointList` starting at the aircraft's position (readback after one tick).
8. The aircraft descends along the path, touches down at `TouchDownPosition`, rollout + taxi resume; after the landing clearance (radio UI) it reaches its stand and docks.
9. Failure modes: a taxiing/parked aircraft or a missing APP route → command returns false and nothing changes.
10. `apprName` parity: forcing the ACL name (`RNAV ILS Z Rwy 19`) yields the identical `Route` label on the aircraft.
11. UDP Mechanism A: send a plain SelectAircraft frame with callsign `!5:CQH8672` (12 B) → the aircraft transitions to approach exactly as the overlay button would; the game's selection state is unchanged (no aircraft was selected).
12. UDP Mechanism B: send `update_heading|CQH8672|12.5|-3.2` on command id `0x00E7` → the heading override applies; a legacy `update_position|CQH8672|12.5|-3.2|180` frame applies the same way (kts ignored, one-time deprecation note); normal select frames still work; BepInEx log shows no `UnknownCommand`/bad-datagram spam (the postfix consumed the frame).
13. **Smooth turn (2026-08-03):** send `update_heading|CS|dx|dy|3` → the diag lines' `propHdg` drifts toward the commanded heading at ~0.05°/tick (3°/s ÷ 60 TPS) while `spd`/`view3D-pos`/`dynVel` keep advancing (the aircraft flies its own route during the turn); the map's nose triangle rotates through intermediate headings — no one-frame jump. At ×2 game speed the turn completes in the same GAME time (half the wall-clock time); while paused the rotation freezes with the game and resumes from where it stopped. A mid-turn re-command continues rotating from the intermediate heading (no snap back). Omitted rate → instant, exactly as before.
14. **Smooth clear_for_appr (2026-08-03):** `clear_for_appr|CS|rate=3` (or the composer's Clear for Approach, which always sends it) → the log shows `override: <CS> cfa-turn: nose …° → smooth turn armed (3°/s …)`; the aircraft keeps flying the STAR (Phase 1 pass-through — the diag/watch lines show the nose following the STAR's own turns); when the handoff lands, `… approach transition landed — rotating onto the approach course at 3°/s` and the tracer's `propHdg` drifts from the STAR heading onto the approach course at ~0.05°/tick — no one-frame jump. **Sweep gate (v2):** the drop does NOT fire against the still-STAR tangent in the ~3 s radio-chatter window (the v1 bug — converged within ~2 ticks, then the game's own ~42°/s turn snapped the nose onto the final course); expect `… game's approach turn running — tangent swept …° — nose chasing at 3°/s` once the deferred turn begins, then `cfa-turn converged … (tangent swept …°) … — override dropped` ~10 game-seconds later when the nose catches the settled course — the game's own writes resume seamlessly. Watch for `… 60 s phase-2 bound — override dropped` only if the tangent never settles (hold pattern). The same game-time/pause rules apply (×2 halves the wall-clock turn, pause freezes it). A cfa without a rate field still smooths at the plugin default (3°/s). Backward-compat guard: a bare numeric field on a cfa frame is still the kts approach speed — `rate=3` bare would be misread as 3 kt, hence the keyed form.
15. Rollback: with the plugin disabled, both frame types are inert (select miss / one `UnknownCommand` log line) — nothing crashes.
16. **Radio handoff (2026-08-04, v2):** `clear_for_appr` on a state-30 arrival → the log shows `cfa: <CS> radio: radio <apprPk> → TWR(<twrPk>)` AND `cfa: <CS> radio: jurisdiction <apprPk> → TWR(<twrPk>)`; the AFTER dump and ALL watch lines keep `rc=Tower/<twrPk> jrc=Tower/<twrPk>` (the re-assert detector — a flip back names the culprit flow via the line before it). The editor map's strip shows BOTH seats flip to TWR within a telemetry tick. Resolution failure path: log `cfa: … radio: tower channel NOT resolved …`, aircraft behaves exactly as before (self-heals on touchdown).
17. **Approach speed (2026-08-04):** `clear_for_appr|CS` WITHOUT a kts field → the log shows `cfa: <CS> speed: ts=240 tts=240 dtts=240 fwd=True accel 1/-2`, and the watch lines show the position advancing ~2 u/step (123 u/s ÷ 60 TPS) with `stPr` ~0.01/step and `chTs=240.0 … chFwd=True` in every dump — no crawl. With `kts=200` the speed log and `chTs`/`chTts`/`chDTts` show 200. If the crawl persists WITH `chTs=240.0` visible, the flight-plan metrics (`afm` / `_appRouteTime` in `ApproachState`) are the next suspect.

---

## Appendix — source of truth

All class/member references verified against the 2026-08-03 Cpp2IL dump (`%TEMP%\cpp2il\out\DiffableCs\`):

- `ContextCross\Aircrafts\Aircraft.cs` — `Step()`, `Position`/`Direction` props, `_dynamics` field, `DeactivateCollisions`, `KinematicMode`
- `ContextCross\Aircrafts\Aircraft3D.cs` — `ManagedBehaviour` view, `Source`, `_rigidbody`
- `ContextCross\Dynamics\Dynamics.cs` — `Update(AircraftDynamicsInput, float)`, speed knobs
- `ContextCross\Dynamics\AircraftDynamicsData.cs` / `AircraftDynamicsInput.cs` / `AircraftDynamicsOutput.cs`
- `ContextCross\States\GameStateRegistry.cs` / `IGameStateRegistry.cs` — `GetEntities<T>()`, PK = `"aircraft:" + registration`
- `ContextCross\Managers\GameManager.cs` — holds `_gameStateRegistry`; `ContextCross\Managers\TickManager.cs` — 60 TPS
- `ContextCross\Api\Endpoints\Aircraft\List\AircraftListEndpoint.cs` — how the game enumerates aircraft
- `ContextCross\Api\Models\AircraftProjection.cs` — `AirSpeedKnots`, `GroundSpeedKnots`, `Position`, `Direction` (knots!)
- `ContextCross\ManagedBehaviour.cs` — `FixedUpdate` → `Step` view loop

State-30/5 machinery (section 6):

- `ContextCross\Aircrafts\Enums\EAircraftState.cs` — `Fly = 30`, `Approach = 5`; `EAircraftTrigger.cs` — `Approach = 12`
- `ContextCross\Dynamics\Enums\State.cs` — `FlyApproaching = 1`, `Approaching = 2`
- `ContextCross\Dynamics\States\ApproachDynamicsParams.cs` — `ProgressRatio`, `TouchDownPosition`, `ApproachDirection`, `CommandedGoAround`, `InitialPosition`, `PathPointList`; `FlyApproachDynamicsParams.cs`; `ApproachState.cs` — `Init(IDynamicsParams)`, `GetApproachDynamicsByProgressRatio(float)`
- `ContextCross\Dynamics\Dynamics.cs` — `FlyApproach2Approach()`, `CurrentState`, `RestoreRuntimeData()`, `_triggerApproachWithParams`
- `ContextCross\Dynamics\AircraftDynamicsData.cs` — `DynamicsState`, `DynamicsParams`, taxi constants
- `ContextCross\Services\AirwayRouteService.cs` — `RouteDict`, `GetRoute(Vector3, Runway, RouteType)`, `RouteType { STAR=0, APP=1, SID=2, MissedApch=3 }`, `ApproachSpeedKts = 240`
- `ContextCross\Route.cs` — `Names`, `Locations`; `AnyPath\AnyPath\Location.cs` — `Position` (float3)
- `ContextCross\Models\Runway.cs` — `TouchDownPosition`, `Direction`, `Routes`; `FlightPlan.cs` — `GetRunway(EFlightDirection)`, `GetStar()`
- `ContextCross\Aircrafts\Aircraft.cs` — `RunwayReactive`, `CommandContinueApproach()`, `ConfigureRuntimeData(...)`, private `_stateMachine` / `_state` / `_route` / `_waitingForCommands` / `_flightPlan` / `_radioChannel` / `_jurisdictionRadioChannel` (ReactiveProperty<RadioChannel>, [Serialize]) / `SetRadioChannel` / `SetJurisdictionRadioChannel` (private — the game's only channel-write entries besides load)
- `ContextCross\Enums\ECommand.cs` — `ContinueApproach = 21`, `PermitLanding = 22`, `ContactTower = 13`
- `ContextCross\Managers\RadioChannelManager.cs` — `GetResolvedChannel(EChannel)`; `ContextCross\Models\RadioChannel.cs` — `PK`, `Type : EChannel`, `ShortCode`, `RadioName`, `Frequency`; `ContextCross\Enums\EChannel.cs` — `Tower = 3`, `Approach = 5`; `ContextCross\Radio\RadioSystem.cs` — `_radioChannelBindings : Dictionary<string, RadioChannelBinding>` (jurisdiction-handoff resolution, step 6d)

UDP command channel (section 5.4):

- `ContextCross\Telemetry\AircraftUdpCommandService.cs` — port 20267, `ReceiveBufferSize = 512`, `MaxCommandsPerTick = 64`, `Execute(in UdpCommand)`, `ExecuteSelectAircraft(string)`; `AircraftUdpTelemetryService.cs` — outbound telemetry on 20266 (the editor's 10 Hz state feed)
- `ContextCross\Telemetry\UdpCommandParser.cs` — `Magic = 1129595207` ("GATC" LE), `Version = 1`, `HeaderSize = 8`, `CallSignLength = 12`, `SelectAircraftDatagramSize = 20`, `TryParse(ReadOnlySpan<byte>, out UdpCommand)`; `UdpCommand.cs`; `UdpCommandType.cs` (`SelectAircraft = 1`); `UdpCommandParseResult.cs` (`Ok/Malformed/UnsupportedVersion/UnknownCommand`)
- Editor side: `electron/udp_listener.js` — `MAGIC = 0x43544147`, `sendCommand(commandId, payloadBuf)`; `electron/main.js` — `send-udp-command` / `send-patch-command` IPC

Editor ACL reference (section 6.1): `src/acl/approach.js` — `buildState5AircraftBlock` (state=5 block), `resolveApproachProcedureData` (SceneryData → path/touchdown), `extractState5Data` / `buildState5ParamsMap` (route|runway cache); `src/acl/constants.js` / `src/utils/constants/aviation.js` — `STATE5_OUTPUT_PROGRESS_RATIO`, `TAN_3_DEG`.

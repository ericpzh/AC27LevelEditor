# AC27Appoarch

BepInEx 6 IL2CPP plugin for Airport Control 25 (Playtest) that live-patches aircraft in-game, driven entirely through the game's **native UDP command channel** (no overlay, no hotkeys). Implements the design in `docs/bepinex-aircraft-override-report.md` (sections 4–5.4, 6, 8).

- **Plugin ID**: `com.ac27.appoarch` v1.0.0
- **Input**: UDP only — the game's own `AircraftUdpCommandService` on `127.0.0.1:20267`
- **Two commands**:
  - `update_heading` — **heading-only** override (2026-08-03, decoupled): forces the aircraft's nose to a heading each tick; position and speed stay 100% the game's — the aircraft keeps flying its own route at the game's own speed. Speed is never read for control and never written. (`update_position` is tolerated as a legacy alias with its kts field ignored.)
  - `clear_for_appr` — hand a STAR (state 30) aircraft onto the final approach (state 5) with fully populated approach geometry, mirroring an ACL pre-spawned state=5 aircraft

## Requirements

- Airport Control 25 Playtest with BepInEx 6 IL2CPP installed (the editor's "BepInEx Debug Mode" tab can install it)
- The game must be running (the UDP server binds `127.0.0.1:20267` only while the game is up)
- Optional: the AC27 Level Editor for the `send-patch-command` bridge

## Install

The csproj deploys automatically on every build:

```
dotnet build mods/AC27Appoarch
```

copies `AC27Appoarch.dll` to:

```
<GameDir>\BepInEx\plugins\AC27Appoarch\AC27Appoarch.dll
```

Manual install = same thing: drop the DLL (with the rest of `BepInEx\plugins` untouched) and start the game. BepInEx 6 IL2CPP loads plugins from `BepInEx\plugins\<folder>\` at startup — **fully restart the game** (not just a level reload) after dropping or replacing the plugin.

Verify load in `BepInEx\LogOutput.log`:

```
AC27Appoarch loaded
[AC27Appoarch] Aircraft.Step (postfix): applied
[AC27Appoarch] UDP Mechanism A (AircraftUdpCommandService.ExecuteSelectAircraft): applied
[AC27Appoarch] UDP Mechanism B (AircraftUdpCommandService.FixedTick postfix): applied
[AC27Appoarch] UDP Mechanism B (Socket.Receive capture, 4-arg): applied
[AC27Appoarch] UDP Mechanism B (Socket.Receive capture, 1-arg): applied
[AC27Appoarch] UDP log suppression (AircraftUdpCommandService.LogBadDatagramOnce): applied
[AC27Appoarch] Dynamics.RestoreRuntimeData (trace): applied
[AC27Appoarch] Dynamics.SetCurrentState (trace): applied
```

(`AircraftDynamicsData.DynamicsParams` is deliberately NOT in this list — its setter is an IL2CPP **field accessor**: the IL2CPP detour backend refuses it and the managed fallback fails ("Parameter 'value' not found"), and the game's native C++ writes the field directly, never through the managed stub. Re-plant detection is a per-step pointer diff in the plugin's tick instead: `params-replant: <CS> DynamicsParams ← <class>`.)

These are the **runtime-verified** hook points (2026-08-03). The two obvious candidates are deliberately NOT patched — they apply cleanly at load but crash per-frame at runtime in this IL2CPP context:

- `Execute(in UdpCommand)` — the `in`-byref binding NREs inside the Harmony trampoline (`NullReferenceException` in the prefix)
- `TryParse(ReadOnlySpan<byte>, out UdpCommand)` — ref-struct param makes the Harmony DMD invalid IL (`InvalidProgramException` on **every** frame, including plain selects — it breaks the game's own UDP parsing)

Mechanism A hooks `ExecuteSelectAircraft(string)` (plain string param — called for every parsed SelectAircraft command). Mechanism B reads the datagram back from the service's `_receiveBuffer` in a `FixedTick()` postfix, with a `Socket.Receive` postfix as an alternative capture (shared dedup — whichever sees the frame first dispatches it). **Interop gotcha:** Il2CppInterop stubs expose private fields as public *properties* with the same name — `Traverse.Field("_receiveBuffer")` resolves nothing and silently no-ops; the plugin reads `svc._receiveBuffer` directly. Each dispatched command also logs a confirmation line, e.g. `[AC27Appoarch] patch: update_heading → CSN9355 (1,0): applied (Mechanism B)`.

## Usage

### Mechanism A — hijacked SelectAircraft frame (always available)

Standard SelectAircraft frame (CommandId `1`) whose callsign field starts with `!`. The game's own server parses it; the plugin intercepts it before selection happens, so **no aircraft gets selected**.

```
!5:<callsign>        → clear_for_appr (callsign field is 12 bytes — fits any callsign)
```

From the editor devtools:

```js
await electronAPI.sendUdpCommand(1, '!5:' + callSign);
```

### Mechanism B — extended frame (full command set)

Custom CommandId `0x00E7` + pipe-delimited ASCII payload:

| Command | Payload | Notes |
|---|---|---|
| `update_heading` | `update_heading\|CS\|dx\|dy` | **Heading-only**: (dx, dy) = world direction components — heading H → (dx, dy) = (sin H, cos H), +Z = north, +X = east (180 = `0,-1`, 270 = `-1,0`, 360 = `0,1`). No speed field: the plugin never touches speed, position, or route — the aircraft points at the heading while the game's dynamics keeps flying it. Legacy `update_position\|CS\|dx\|dy[\|kts]` parses the same way (kts validated but ignored, one-time deprecation note). Zero direction = no heading command (the game's own heading passes through) — it does NOT clear an override (there is no clear path; the override ends via `clear_for_appr` or a level switch) |
| `clear_for_appr` | `clear_for_appr\|CS[\|kts][\|appr][\|native=0]` | `kts` optional — approach speed in raw knots (omitted/0 = the aircraft's speed is left untouched); `appr` optional — named approach procedure (field 4 when `kts` present; omitted = nearest APP route to the aircraft); `native=0` (field 5) skips `CommandContinueApproach` (its deferred radio flow ~3 s is the suspected post-patch actor — the direct fires alone produce the same transition). A numeric field 2 is always `kts` |
| `track` | `track\|CS` | Toggle the 1 s parameter trace for one callsign (diagnostics): every second the plugin dumps the aircraft's full params — aircraft state (Fly/Approach), dynamics state, the `DynamicsParams` object (whichever class, with path lists summarized), the **active state machine state with ITS OWN path copies** (`st=ApproachState stPath=… stPr=…` — the list the game's path-following actually reads, which the data channel does NOT reflect after an `Init`-capture) — plus position/heading/speed/route/waiting commands. `clear_for_appr` **auto-tracks the callsign for 30 s** and arms a ~1.7 s per-step watch (10 `watch: …` lines at step resolution) so the post-patch seconds always land in the log even if `track` was never sent |

The game's own parse cannot be stopped from running first (the postfix reads the buffer *after* it), so a stock game logs one `Aircraft UDP command ... dropped (UnknownCommand)` warning per frame — the plugin suppresses that specific warning via a `LogBadDatagramOnce` prefix; other bad-datagram reasons still surface.

From the editor devtools:

```js
// hand a STAR aircraft onto the final approach
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign });

// same, but the approach speed is commanded at 200 kt (kts omitted = speed untouched)
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign, kts: 200 });

// heading-only override: point the nose at 180° (the aircraft keeps flying
// its own route at the game's own speed — speed/position are never touched)
await electronAPI.sendPatchCommand({ type: 'update_heading', callSign, dx: 0, dy: -1 });

// diagnostics: dump CSC6918's params every 1 s (toggle; send again to stop)
await electronAPI.sendPatchCommand({ type: 'track', callSign: 'CSC6918' });
```

### Frame format (both mechanisms)

```
offset 0   uint32 LE  magic    0x43544147 "GATC" (1129595207)
offset 4   ushort    version   1
offset 6   ushort    commandId 1 (Mechanism A) | 0x00E7 (Mechanism B)
offset 8   payload   Mechanism A: 12-byte NUL-padded ASCII callsign
                     Mechanism B: ASCII, pipe-delimited, NUL-padded to
                     exactly 64 bytes (frame = 72 bytes total)
```

The 64-byte NUL-padded payload field is a hard contract: the plugin reads the datagram back out of the game's receive buffer after the tick, so it finds the payload by scanning for the first NUL at offset 8 — variable-length frames would get stale buffer bytes appended. The editor already speaks the header byte-for-byte (`electron/udp_listener.js`); `send-patch-command` builds the 0x00E7 variant with the padded field. Never route `!` frames through `select-aircraft-in-map` (selection side-effects).

## Notes

- `clear_for_appr` semantics: only STAR aircraft (`EAircraftState.Fly`) can be handed off; a heading override is dropped first (it would fight the approach); `_waitingForCommands` is set to `[PermitLanding]` — the aircraft awaits landing clearance, exactly like an ACL state-5 spawn. The handoff also overwrites the aircraft's runtime `FlyApproachPathPointList` with the full approach procedure (IAF→threshold — the same list that goes into the state-5 `PathPointList`), so the game's path-following continues onto the ILS rather than the STAR's tail. **Interop gotcha (live-verified 2026-08-03):** `DynamicsData.DynamicsParams` is typed `IDynamicsParams`, and Il2CppInterop wraps the interface-typed getter's return in the interface's interop class — `GetType().Name` is literally `IDynamicsParams` and `is FlyApproachDynamicsParams` **never matches** (the original fly-path overwrite silently no-oped). The concrete class is identified by its native class pointer (`Il2CppObjectBase.ObjectClass` vs `Il2CppClassPointerStore<T>.NativeClassPtr`) and the object re-wrapped via `Pointer`. The transition fires the game's own `CommandContinueApproach()` first (the canonical "continue approach" handoff, which respects the `FlyToApproachCondition` gate on the aircraft machine's Fly→Approach transition), then the direct `Fire(EAircraftTrigger.Approach)` and `FlyApproach2Approach()` as logged fallbacks. Live test (2026-08-03): all three fire, the game plays the `AtcContinueApproach` ATC audio, and the AFTER dump shows `Appr(5)`/`Approaching` with `route=RNAV ILS Z Rwy 19` `wait=[22]` — the state update now triggers. The first `Dynamics.RestoreRuntimeData()` call was traced to a LEVEL LOAD (native caller, before the patch — the managed stack showed only the postfix, so the caller is C++); no restore call fired after the patch in the logged window. **The remaining suspect (live data, 2026-08-03):** the state machine's ACTIVE state holds its own captured copies — `ApproachState._runtimeData` / `_pathPointList` (and `FlyApproachState._flyApproachPathPointList` / `_appPointList`), `Init`-copied when the state was activated at level load. The game's path-following (`ApproachState.Update`) reads THOSE, not the aircraft's data channel — so even with the data channel showing our planted `ApproachDynamicsParams`, the aircraft may keep flying the STAR's captured path. The tracer now exposes the active state's own list (`st=… stPath=… stPr=…`), the trace line includes `dataSame=1|0` (is `ac.DynamicsData` the same object the dynamics' state machine reads?), `Dynamics.SetCurrentState(IDynamicState, IDynamicsParams)` is hooked (every transition incl. a revert, with WHICH params object is activated), and the plugin's per-step tick diffs the data channel's `DynamicsParams` pointer against the one it planted (`params-replant: …` — catches the game re-planting the STAR params; the setter itself is an IL2CPP field accessor that neither Harmony backend can patch, and native writes bypass the managed stub anyway). The patch also REWRITES the state's own copies when they mismatch our path (step 6b state check: `cfa: … state check: ApproachState stPath=… — MISMATCH — rewriting`), plus the active `FlyApproachState._flyApproachPathPointList` (step 4b) so a revert also continues onto the ILS path. Every attempt is logged (`cfa: …`) and the patch emits `trace: … [BEFORE]` / `[AFTER]` param dumps at command time, auto-tracks the callsign for 30 s, and arms the ~1.7 s per-step `watch:` — the state that actually stuck is visible in the log. **Live test 2 (2026-08-03):** the replant check's first kill — `params-replant: … DynamicsParams ← FlyApproachDynamicsParams` at watch step 0, a FRESH object (new pointer, `pr=0.682` — the state's own progress) replacing our planted `ApproachDynamicsParams` within one step: the ACTIVE state owns the channel's params and snapshots its own state each step, so the class on the channel always follows the active state. The transition had NOT taken at the state-object level — `state check: STILL FlyApproachState` and `st=FlyApproachState` through all 90 watch steps — while the ENUM flipped (`dyn=Approaching`): a half-transition. Root cause: the `FlyToApproachCondition` gate (the aircraft was mid-STAR at pr≈0.68, and step 4b's path overwrite removed the STAR tail the gate's position check anchors to, so the gate could never pass; the fires' transition was dropped upstream of `SetCurrentState`; the aircraft then flew a degenerate FlyApproachState — stall, then south-east drift). Fix (step 6b fallback): when the state check still finds `FlyApproachState`, the patch bypasses the gate via the game's canonical entry — `dyn.SetCurrentState(_approachState, plantedParams)` using the dynamics' pre-created `ApproachState` instance (nothing minted; wrapped in the `IDynamicState` interop class — the same interface-proxy gotcha), re-verifies the active state, rewrites its captured copies on mismatch, and if `SetCurrentState` itself refuses, force-writes `_currentState` directly (last resort, logged). The `DynamicsState` enum write moved AFTER the transition attempts (step 6c) — the pre-set enum produced the half-transition readback (AFTER dump showed `Appr(5)`/`Approaching` while the state object was still `FlyApproachState`). No `restore:` call fired post-patch in this window — `RestoreRuntimeData` did not act this time. An optional `kts` field commands the approach speed in raw knots (the game's own `ApproachSpeedKts` scale); omitted (or 0) leaves the aircraft's speed fields untouched — the pre-kts build wrote a constant 240.
- `update_heading` (heading-only, 2026-08-03): the game keeps full control of position, speed, route, and collisions — the plugin writes ONLY the heading channels (`Direction`, `DirectionReactive`, `Rotation`) each fixed tick, and the `set_Direction` channel lock re-points the game's own per-tick direction write (the dynamics' path-tangent heading). Speed channels are never written and never read for control (a display-only read appears in the diagnostics). Each apply logs a before/after line: `override: <CS> before hdg …° spd … kt → after hdg …°` (heading in the game UI's convention, `atan2(dir.x, dir.z)`; +Z = north, +X = east). The aircraft points at the commanded heading but continues flying its original route — that is the intended behavior.
- Aids used at runtime are `FindObjectsOfType<Aircraft3D>` (lookup by `Source.CallSign`) and a cached VContainer `LifetimeScope` scan for `AirwayRouteService`.

## Rollback

Delete `BepInEx\plugins\AC27Appoarch\` and restart the game. Without the plugin both frame types are inert: a `!` SelectAircraft frame is a normal select miss, and a `0x00E7` frame is one `UnknownCommand` log line.

## Build

- SDK: net6.0 (built with SDK 7.0.410+), `LangVersion 10`, references pinned to `<GameDir>\BepInEx\core\` and `BepInEx\interop\` (see `AC27Appoarch.csproj` — `GameDir` property points at the Playtest install).
- Interop gotchas fixed at build time are documented in `docs/bepinex-aircraft-override-report.md` §6.4 ("Build-verified deltas").
- Design: `docs/bepinex-aircraft-override-report.md` (input surfaces §5, API design §4, verification checklist §8).

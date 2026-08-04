---
name: ac27-appoarch
description: AC27Appoarch — the BepInEx 6 IL2CPP plugin for Airport Control 25 (Playtest) that live-patches in-game aircraft (heading override, STAR→final-approach handoff) through the game's native UDP command channel. Use this skill whenever working in mods/AC27Appoarch (building, editing the Harmony patches, debugging a patch that isn't sticking in-game), when the editor's FlightPatchCommandBar or send-patch-command bridge is involved, when handling clear_for_appr / update_heading / track frames, or when diagnosing BepInEx/IL2CPP interop issues against the game's Aircraft/Dynamics classes. The plugin's deep documentation lives in its own README — read it before making changes.
---

# AC27Appoarch — Plugin Skill

## What This Is

A BepInEx 6 IL2CPP plugin (`com.ac27.appoarch` v1.0.0) that live-patches aircraft in Airport Control 25 (Playtest) **while the game runs**. No overlay, no hotkeys — driven entirely through the game's own UDP command service (`127.0.0.1:20267`). Two commands:

| Command | What it does |
|---|---|
| `update_heading` | **Heading-only** override (2026-08-03, decoupled): forces the aircraft's nose to a heading each fixed tick. Position/speed/route stay 100% the game's — the aircraft keeps flying its own route. Speed is never read for control, never written. `update_position` is a legacy alias whose kts field is ignored |
| `clear_for_appr` | Hands a STAR (state 30) aircraft onto final approach (state 5) with fully populated approach geometry — mirroring an ACL pre-spawned state=5 aircraft, including `_waitingForCommands = [PermitLanding]` and the full IAF→threshold path list |

Design document: `mods/docs/bepinex-aircraft-override-report.md` (API design §4, input surfaces §5, verification checklist §8). Class dumps: `mods/docs/aircraft-classes-report.md` + `aircraft-classes-inventory.md` (Cpp2IL dumps of GameAssembly.dll). **Read the plugin's `mods/AC27Appoarch/README.md` before making changes — it records every runtime-verified fact and every failed attempt.**

## Layout

```
mods/AC27Appoarch/
├── Plugin.cs               # BepInEx plugin entry, patch application, UDP dispatch
├── Patches.cs              # Harmony postfixes/prefixes (Aircraft.Step, UDP service, dynamics)
├── OverrideController.cs   # Per-tick heading override + params-replant detection
├── ParamTrace.cs           # 1 s parameter trace (track command) + cfa watch lines
├── AC27Appoarch.csproj     # net6.0, LangVersion 10, refs pinned to <GameDir>\BepInEx\{core,interop}
└── README.md               # THE deep reference — read before changing anything
```

## Build & Install

```bash
dotnet build mods/AC27Appoarch
```

The csproj auto-copies `AC27Appoarch.dll` to `<GameDir>\BepInEx\plugins\AC27Appoarch\`. BepInEx 6 IL2CPP loads plugins from `BepInEx\plugins\<folder>\` at startup — **fully restart the game** (not just a level reload) after dropping/replacing the plugin DLL. `bin/` and `obj/` are gitignored — never commit build artifacts.

Verify load in `<GameDir>\BepInEx\LogOutput.log`:

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

`AircraftDynamicsData.DynamicsParams` setter is deliberately NOT patched — IL2CPP field accessor, both Harmony backends refuse it, and native C++ writes bypass the managed stub. Re-plant detection is a per-step pointer diff instead (`params-replant: <CS> DynamicsParams ← <class>`).

## Sending Patch Frames

### Mechanism B — extended frame 0x00E7 (full command set)

From the editor devtools (`sendPatchCommand` preload → `send-patch-command` IPC):

```js
// heading-only override: point the nose at 180° (speed/position untouched)
await electronAPI.sendPatchCommand({ type: 'update_heading', callSign, dx: 0, dy: -1 });
// hand a STAR aircraft onto final approach
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign });
// same, commanding 200 kt approach speed (kts omitted = speed untouched)
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign, kts: 200 });
// diagnostics: dump the aircraft's full params every 1 s (send again to stop)
await electronAPI.sendPatchCommand({ type: 'track', callSign: 'CSC6918' });
```

Heading → (dx, dy) = `(sin H, cos H)`, **+Z = north, +X = east** (030 → `0.5, 0.8660`; 180 → `0, -1`; 360 → `0, 1`). Zero direction = no heading command (the game's own heading passes through) — it does NOT clear an override (there is no clear path; the override ends via `clear_for_appr` or a level switch).

### Mechanism A — hijacked SelectAircraft frame (always available)

`sendUdpCommand(1, '!5:' + callSign)` — the game parses it as a normal select, the plugin intercepts before selection happens, so no aircraft gets selected. Only `clear_for_appr` (the 12-byte callsign field fits any callsign). Never route `!` frames through `select-aircraft-in-map` (selection side-effects).

### Frame contract (both mechanisms)

```
offset 0   uint32 LE  magic    0x43544147 "GATC" (1129595207)
offset 4   ushort    version   1
offset 6   ushort    commandId 1 (Mechanism A) | 0x00E7 (Mechanism B)
offset 8   payload   Mechanism A: 12-byte NUL-padded ASCII callsign
                     Mechanism B: ASCII, pipe-delimited, NUL-padded to
                     exactly 64 bytes (frame = 72 bytes total)
```

The 64-byte NUL-padded payload is a **hard contract**: Mechanism B reads the datagram back from the game's receive buffer after the tick and finds the payload by scanning for the first NUL at offset 8 — variable-length frames get stale buffer bytes appended. The stock game logs one `UnknownCommand` warning per 0x00E7 frame; the plugin suppresses that exact warning via a `LogBadDatagramOnce` prefix (other bad-datagram reasons still surface).

Payload table (pipe-delimited ASCII): `update_heading|CS|dx|dy` · `clear_for_appr|CS[|kts][|appr][|native=0]` (a numeric field 2 is always kts; `native=0` skips `CommandContinueApproach`) · `track|CS`.

## Editor Integration

- **`FlightPatchCommandBar.jsx`** (Flight Strips window): click-driven composer for approach-channel aircraft (`controlSeat=5`) — `Fly Heading` (heading-only `update_heading`) or `Clear for Approach` (`clear_for_appr`, supersedes any composed heading). Sends exactly ONE frame then dismisses. See the `ac27-editor` skill's map-windows reference.
- **`electron/main.js` `send-patch-command`** builds the 0x00E7 frame (parts joined with `|`, NUL-padded to 64 B) → `sendUdpCommand(0x00E7, field)`.

## Verified Hook Points & Interop Gotchas

These are the runtime-verified hooks (2026-08-03). Two obvious candidates are deliberately NOT patched (they apply cleanly at load but crash per-frame at runtime): `Execute(in UdpCommand)` (in-byref NRE inside the Harmony trampoline) and `TryParse(ReadOnlySpan<byte>, out UdpCommand)` (ref-struct param → invalid DMD IL on every frame, breaks the game's own parsing).

- **Mechanism A** hooks `ExecuteSelectAircraft(string)` (plain string param). **Mechanism B** reads the datagram back from `svc._receiveBuffer` in a `FixedTick()` postfix, with a `Socket.Receive` postfix as alternative capture (shared dedup — whichever sees the frame first dispatches it).
- **Interop gotcha — Traverse is a trap:** Il2CppInterop stubs expose private fields as public *properties* with the same name — `Traverse.Field("_receiveBuffer")` silently no-ops; read `svc._receiveBuffer` directly.
- **Interop gotcha — interface-wrapped types:** `DynamicsData.DynamicsParams` is typed `IDynamicsParams`, and Il2CppInterop wraps the interface-typed getter's return in the interface's interop class — `GetType().Name` is literally `IDynamicsParams` and `is FlyApproachDynamicsParams` never matches. Identify the concrete class by native class pointer (`Il2CppObjectBase.ObjectClass` vs `Il2CppClassPointerStore<T>.NativeClassPtr`) and re-wrap via `Pointer`. Same proxy gotcha for `IDynamicState` (`_approachState`).
- **The active state machine state owns its own captured copies:** `ApproachState._runtimeData` / `_pathPointList` (and `FlyApproachState._flyApproachPathPointList` / `_appPointList`) are `Init`-copied at state activation (level load) and the game's path-following reads THOSE, not the aircraft's data channel. The patch rewrites them on mismatch (`cfa: … state check: … MISMATCH — rewriting`) — the tracer exposes them as `st=… stPath=… stPr=…` plus `dataSame=1|0`.
- **`FlyToApproachCondition` gate:** the canonical `CommandContinueApproach()` respects it; a mid-STAR aircraft (pr ≈ 0.68+) can fail the gate (step 4b's path overwrite removed the STAR tail the gate's position check anchors to) → half-transition (enum flipped, state object not). Fallback (step 6b): bypass via `dyn.SetCurrentState(_approachState, plantedParams)` with the dynamics' pre-created `ApproachState` (nothing minted), re-verify, force-write `_currentState` as last resort. The `DynamicsState` enum write is moved AFTER the transition attempts (step 6c) — a pre-set enum produces misleading half-transition readbacks.
- **`clear_for_appr` semantics:** only STAR aircraft (`EAircraftState.Fly`) can be handed off; a heading override is dropped first; `_waitingForCommands` set to `[PermitLanding]`; `FlyApproachPathPointList` overwritten with the full approach (IAF→threshold).
- Runtime lookups use `FindObjectsOfType<Aircraft3D>` (by `Source.CallSign`) and a cached VContainer `LifetimeScope` scan for `AirwayRouteService`.

## Debugging a Patch That Doesn't Stick

1. **Always check `LogOutput.log` first** — every dispatch logs `[AC27Appoarch] patch: <type> → <CS> … applied (Mechanism B)`; every apply logs `override: <CS> before hdg …° spd … kt → after hdg …°`; every cfa step logs `cfa: …`.
2. `clear_for_appr` **auto-tracks the callsign for 30 s** and arms a ~1.7 s per-step watch (10 `watch: …` lines) so the post-patch seconds land in the log even if `track` was never sent. `track|CS` toggles the 1 s full param dump manually.
3. The AFTER dump shows state + `route=` + `wait=[…]`; the per-step watch shows whether the transition stuck at the state-object level (`st=FlyApproachState` with `dyn=Approaching` = half-transition). `params-replant:` lines catch the game re-planting the STAR's params — when you see it, the ACTIVE state owns the channel's params (snapshots each step), not the reverse.
4. Before/after frames from the game's own UDP service are logged (the game plays `AtcContinueApproach` audio on a successful handoff — a quick audible check).

## Key Rules

- **Read `mods/AC27Appoarch/README.md` before changing the plugin** — it is the authoritative record of verified behavior and dead ends. Keep it in sync with any behavioral change (the editor skill's rule 21 applies here too).
- **Never hardcode or mint type ids** in the plugin's dynamics work (same policy as the editor): everything is resolved from the game's runtime objects or the Cpp2IL dump — see `mods/docs/aircraft-classes-inventory.md`.
- **Never commit `bin/` / `obj/`** (gitignored). Commit source + `docs/` only.
- **The game must be running** for the UDP server to exist (binds `127.0.0.1:20267` only while the game is up).
- **Editor-side frame sends** must use `sendPatchCommand` / the documented frame contract — never craft raw datagrams in renderer code, and never route `!` frames through `select-aircraft-in-map`.

# AC27Appoarch

BepInEx 6 IL2CPP plugin for Airport Control 25 (Playtest) that live-patches aircraft in-game, driven entirely through the game's **native UDP command channel** (no overlay, no hotkeys). Implements the design in `docs/bepinex-aircraft-override-report.md` (sections 4–5.4, 6, 8).

- **Plugin ID**: `com.ac27.appoarch` v1.0.0
- **Input**: UDP only — the game's own `AircraftUdpCommandService` on `127.0.0.1:20267`
- **Two commands**:
  - `update_heading` — **heading-only** override (2026-08-03, decoupled): forces the aircraft's nose to a heading each tick; position and speed stay 100% the game's — the aircraft keeps flying its own route at the game's own speed. Speed is never read for control and never written. An optional rate field (`update_heading|CS|dx|dy|rate`) rotates the nose **smoothly** at that many °/s of GAME time (scaled with the game's speed multiplier, frozen while paused); omitted/≤0 = instant snap. (`update_position` is tolerated as a legacy alias with its kts field ignored.)
  - `clear_for_appr` — hand a STAR (state 30) aircraft onto the final approach (state 5) with fully populated approach geometry, mirroring an ACL pre-spawned state=5 aircraft (v2, 2026-08-04: also hands over BOTH radio slots — active + jurisdiction — to the tower channel)

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
| `update_heading` | `update_heading\|CS\|dx\|dy[\|rate]` | **Heading-only**: (dx, dy) = world direction components — heading H → (dx, dy) = (sin H, cos H), +Z = north, +X = east (180 = `0,-1`, 270 = `-1,0`, 360 = `0,1`). No speed field: the plugin never touches speed, position, or route — the aircraft points at the heading while the game's dynamics keeps flying it. Optional 5th field `rate` = smooth-turn rate in °/s of GAME time (2026-08-03): the nose rotates toward the heading at that rate, scaled by the game's speed multiplier (`Time.timeScale`) and frozen while paused; omitted or ≤0 = INSTANT (pre-smoothing behavior). Legacy `update_position\|CS\|dx\|dy[\|kts]` parses the same way (kts validated but ignored, one-time deprecation note — it is never a rate). Zero direction = no heading command (the game's own heading passes through) — it does NOT clear an override (there is no clear path; the override ends via `clear_for_appr` or a level switch) |
| `clear_for_appr` | `clear_for_appr\|CS[\|kts][\|appr][\|native=0][\|rate=N]` | `kts` optional — approach speed in raw knots (omitted/0 = the aircraft's speed is left untouched); `appr` optional — named approach procedure (omitted = nearest APP route to the aircraft); `native=0` skips `CommandContinueApproach` (its deferred radio flow ~3 s is the suspected post-patch actor — the direct fires alone produce the same transition); `rate=N` optional — smooth-turn °/GAME-second for the handoff (2026-08-03: the nose rotates onto the approach course instead of snapping when the transition lands; omitted = the plugin's standard-rate default 3°/s). Keyed scan (not positional): a numeric field is always `kts`, the first other field is the procedure name, `native=0`/`rate=N` are flags in any position — `rate=3` as a bare field would be misread as a 3 kt approach speed |
| `track` | `track\|CS` | Toggle the 1 s parameter trace for one callsign (diagnostics): every second the plugin dumps the aircraft's full params — aircraft state (Fly/Approach), dynamics state, the `DynamicsParams` object (whichever class, with path lists summarized), the **active state machine state with ITS OWN path copies** (`st=ApproachState stPath=… stPr=…` — the list the game's path-following actually reads, which the data channel does NOT reflect after an `Init`-capture) — plus position/heading/speed/route/waiting commands. `clear_for_appr` arms a ~3.3 s per-step watch (20 `watch: …` lines at step resolution — 200 steps, one line per 10 steps) so the post-patch seconds land in the log without the auto-trace stream (the 30 s auto-track was removed 2026-08-03 v2 — `track|CS` is the deliberate 1 s dump path) |

The game's own parse cannot be stopped from running first (the postfix reads the buffer *after* it), so a stock game logs one `Aircraft UDP command ... dropped (UnknownCommand)` warning per frame — the plugin suppresses that specific warning via a `LogBadDatagramOnce` prefix; other bad-datagram reasons still surface.

From the editor devtools:

```js
// hand a STAR aircraft onto the final approach — the nose rotates smoothly
// onto the approach course at rate °/s of game time (rate omitted = plugin's
// standard-rate default; the editor's composer always sends rate: 3)
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign, rate: 3 });

// same, but the approach speed is commanded at 200 kt (kts omitted = the ACL default 240 — always written)
await electronAPI.sendPatchCommand({ type: 'clear_for_appr', callSign, kts: 200 });

// heading-only override: point the nose at 180° (the aircraft keeps flying
// its own route at the game's own speed — speed/position are never touched).
// rate = smooth turn at 3°/s of game time (omitted = instant snap)
await electronAPI.sendPatchCommand({ type: 'update_heading', callSign, dx: 0, dy: -1, rate: 3 });

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

- `clear_for_appr` semantics: only STAR aircraft (`EAircraftState.Fly`) can be handed off; a heading override is replaced by the smooth handoff turn (it would fight the approach — see the cfa smooth-turn note); `_waitingForCommands` is set to `[PermitLanding]` — the aircraft awaits landing clearance, exactly like an ACL state-5 spawn. The handoff also overwrites the aircraft's runtime `FlyApproachPathPointList` with the planted approach path — the aircraft's OWN procedure (`FlyApproachDynamicsParams.AppPointList`, the same list the game's transition builds its `ApproachState` from) with the aircraft's position PREPENDED as the join leg (`cfa: <CS> path from aircraft AppPointList (len=N)`; `GetRoute` `AirwayNodes` is the logged fallback when AppPointList is unavailable). **The join leg kills the dead cruise (2026-08-04):** the approach state holds `pr` at 0 until the aircraft captures path[0], and the pre-join-leg plant put path[0] 300-700 units from mid-STAR aircraft (GetRoute's nearest-first-fix variant pick) — minutes of silent cruise (live log 2026-08-03: CES5578/CSN2197 `stPr=0.000` frozen through the watch; CSN2197's 60 s phase-2 bound with the tangent never swept). Starting the path AT the aircraft makes the approach activate immediately, so the game's path-following continues onto the ILS rather than the STAR's tail. **Join-leg v2 (2026-08-04, live log CSN2197):** the game's own `ApproachState.Init` (run synchronously during the transition fires) re-derives its approach path from `AppPointList` and mutated the planted params' `PathPointList` IN PLACE back to the plain 5-pt APP list (path[0] 890 units away; pointer unchanged, so the replant diff stays silent) — re-stalling the capture gate (the ~10 s dead hold, `stPr=0.000`, tangent never sweeping → cfa-turn's 60 s phase-2 bound) and producing the 180° turn-back to the stale join point once the game's steering finally engaged. Three fixes: (1) step 4d plants the join leg into `AppPointList` (channel + fly-state copies) BEFORE the fires, so Init derives join-leg geometry natively (`cfa: <CS> AppPointList overwritten (join leg, N pts)`; a re-command strips the previous join leg by pointer identity — `previous join leg stripped`); (2) the 6b state check builds a FRESH `ApproachDynamicsParams` (never reuses the in-place-mutated object) and re-plants channel + `_runtimeData`, plus rewrites the Init-derived fields `_initialPosition`/`_approachDirection`/`_touchDownPosition`/`startingProgress` (log: `… ApproachState path + Init fields rewritten`, `… ApproachState._runtimeData → fresh join-leg params`, `… params-replant: DynamicsParams ← fresh ApproachDynamicsParams`); (3) per-tick join-leg tracking (`TrackJoinLeg` in `OnAircraftStep`) keeps path[0] + `_initialPosition` + runtime/channel path[0] under the aircraft while the approach holds (watch armed or `stPr < 0.01`) — the aircraft drifts off a command-time path[0] during the deferred activation, and a stale path[0] is exactly what the game steers BACK to. New trace fields: `stInit=`, `stSP=` (`startingProgress`), `stA0=<2D>/<3D>`, `rtA0=<2D>/<3D>` (aircraft→path[0] distance, 2-D and 3-D — the gate-target discriminator: stA0 near 0/15 with rtA0 large = the gate reads the stale runtime-data path), `afmRem=`/`afmAppT=` (diagnostic only — `AircraftFlightMetrics` is Init-built from the flight plan, not rebuildable from the plugin). **Interop gotcha (live-verified 2026-08-03):** `DynamicsData.DynamicsParams` is typed `IDynamicsParams`, and Il2CppInterop wraps the interface-typed getter's return in the interface's interop class — `GetType().Name` is literally `IDynamicsParams` and `is FlyApproachDynamicsParams` **never matches** (the original fly-path overwrite silently no-oped). The concrete class is identified by its native class pointer (`Il2CppObjectBase.ObjectClass` vs `Il2CppClassPointerStore<T>.NativeClassPtr`) and the object re-wrapped via `Pointer`. The transition fires the game's own `CommandContinueApproach()` first (the canonical "continue approach" handoff, which respects the `FlyToApproachCondition` gate on the aircraft machine's Fly→Approach transition), then the direct `Fire(EAircraftTrigger.Approach)` and `FlyApproach2Approach()` as logged fallbacks. Live test (2026-08-03): all three fire, the game plays the `AtcContinueApproach` ATC audio, and the AFTER dump shows `Appr(5)`/`Approaching` with `route=RNAV ILS Z Rwy 19` `wait=[22]` — the state update now triggers. The first `Dynamics.RestoreRuntimeData()` call was traced to a LEVEL LOAD (native caller, before the patch — the managed stack showed only the postfix, so the caller is C++); no restore call fired after the patch in the logged window. **The remaining suspect (live data, 2026-08-03):** the state machine's ACTIVE state holds its own captured copies — `ApproachState._runtimeData` / `_pathPointList` (and `FlyApproachState._flyApproachPathPointList` / `_appPointList`), `Init`-copied when the state was activated at level load. The game's path-following (`ApproachState.Update`) reads THOSE, not the aircraft's data channel — so even with the data channel showing our planted `ApproachDynamicsParams`, the aircraft may keep flying the STAR's captured path. The tracer now exposes the active state's own list (`st=… stPath=… stPr=…`), the trace line includes `dataSame=1|0` (is `ac.DynamicsData` the same object the dynamics' state machine reads?), `Dynamics.SetCurrentState(IDynamicState, IDynamicsParams)` is hooked (every transition incl. a revert, with WHICH params object is activated), and the plugin's per-step tick diffs the data channel's `DynamicsParams` pointer against the one it planted (`params-replant: …` — catches the game re-planting the STAR params; the setter itself is an IL2CPP field accessor that neither Harmony backend can patch, and native writes bypass the managed stub anyway). The patch also REWRITES the state's own copies when they mismatch our path (step 6b state check: `cfa: … state check: ApproachState stPath=… — MISMATCH — rewriting`), plus the active `FlyApproachState._flyApproachPathPointList` (step 4b) so a revert also continues onto the ILS path. Every attempt is logged (`cfa: …`) and the patch emits `trace: … [BEFORE]` / `[AFTER]` param dumps at command time and arms the ~3.3 s per-step `watch:` — the state that actually stuck is visible in the log. (The 30 s auto-track was removed 2026-08-03 v2 — it flooded the log with 30 `trace:` lines per handoff; `track|CS` remains for deliberate 1 s dumps.) **Live test 2 (2026-08-03):** the replant check's first kill — `params-replant: … DynamicsParams ← FlyApproachDynamicsParams` at watch step 0, a FRESH object (new pointer, `pr=0.682` — the state's own progress) replacing our planted `ApproachDynamicsParams` within one step: the ACTIVE state owns the channel's params and snapshots its own state each step, so the class on the channel always follows the active state. The transition had NOT taken at the state-object level — `state check: STILL FlyApproachState` and `st=FlyApproachState` through all 90 watch steps — while the ENUM flipped (`dyn=Approaching`): a half-transition. Root cause: the `FlyToApproachCondition` gate (the aircraft was mid-STAR at pr≈0.68, and the step 4c fly-path overwrite removed the STAR tail the gate's position check anchors to, so the gate could never pass; the fires' transition was dropped upstream of `SetCurrentState`; the aircraft then flew a degenerate FlyApproachState — stall, then south-east drift). Fix (step 6b fallback): when the state check still finds `FlyApproachState`, the patch bypasses the gate via the game's canonical entry — `dyn.SetCurrentState(_approachState, plantedParams)` using the dynamics' pre-created `ApproachState` instance (nothing minted; wrapped in the `IDynamicState` interop class — the same interface-proxy gotcha), re-verifies the active state, rewrites its captured copies on mismatch, and if `SetCurrentState` itself refuses, force-writes `_currentState` directly (last resort, logged). The `DynamicsState` enum write moved AFTER the transition attempts (step 6c) — the pre-set enum produced the half-transition readback (AFTER dump showed `Appr(5)`/`Approaching` while the state object was still `FlyApproachState`). No `restore:` call fired post-patch in this window — `RestoreRuntimeData` did not act this time. An optional `kts` field commands the approach speed in raw knots (the game's own `ApproachSpeedKts` scale); **the patch ALWAYS writes the approach speed now (v3, 2026-08-04)** — `TaxiSpeed`/`TargetTaxiSpeed`/`DynamicsTargetTaxiSpeed` = kts or the ACL default 240 (log `cfa: <CS> speed: ts=… tts=… dtts=… fwd=True accel 1/-2`). The pre-v3 kts-only behavior left the fields untouched and the approach path-following crawled at ~1-4 u/s instead of ~123 u/s at 240 kt (live log 2026-08-03: `stPr` advanced 0.005/s — the aircraft crept along the STAR tail for minutes). The tracer's `chTs=`/`chTts=`/`chDTts=`/`chFwd=` fields show the channel values in every dump — the crawl diagnostic. **Radio handoff (v2, 2026-08-04):** the patch also resolves the airport's tower channel — `RadioChannelManager.GetResolvedChannel(EChannel.Tower)` via the VContainer `LifetimeScope` scan, with the `RadioSystem._radioChannelBindings` dictionary (PK → binding; the private-field-as-public-property gotcha) as fallback — and writes **BOTH** `_radioChannel` and `_jurisdictionRadioChannel` to it (`cfa: <CS> radio: radio <pk> → TWR(<pk>)` and `cfa: <CS> radio: jurisdiction <pk> → TWR(<pk>)`). v1 wrote only the jurisdiction slot and the aircraft stayed on the approach frequency — the tower seat still could not own it — v2 flips both, so the strip/telemetry move to the tower seat at command time (ACL parity stores the tower channel in BOTH slots). The tracer's `rc=`/`jrc=` fields (channel Type/PK) show both slots in every dump (BEFORE/AFTER, watch, manual `track|CS`) — the re-assert detector: a `rc`/`jrc` flip back names the culprit flow via the log line before it. Resolution failure is a logged skip (`cfa: … radio: tower channel NOT resolved …`) — the aircraft stays on approach and the game's touchdown auto-handoff (`ArrivalAircraftAutoContactTowerCondition`) self-heals as before.
- `update_heading` (heading-only, 2026-08-03): the game keeps full control of position, speed, route, and collisions — the plugin writes ONLY the heading channels (`Direction`, `DirectionReactive`, `Rotation`) each fixed tick, and the `set_Direction` channel lock re-points the game's own per-tick direction write (the dynamics' path-tangent heading). Speed channels are never written and never read for control (a display-only read appears in the diagnostics). Each apply logs a before/after line: `override: <CS> before hdg …° spd … kt → after hdg …° rate …°/s` (heading in the game UI's convention, `atan2(dir.x, dir.z)`; +Z = north, +X = east). The aircraft points at the commanded heading but continues flying its original route — that is the intended behavior.
- **Smooth turn (2026-08-03):** with `rate > 0` the nose no longer snaps — each Entry carries a `Current` (smoothed intermediate heading) stepped toward the command with `Vector3.RotateTowards` at `rate × Time.fixedDeltaTime × Time.timeScale` per tick. `Time.timeScale` is the game's speed multiplier (pause = 0 — "Game pause sets time scale 0"): at ×2 the per-tick rotation doubles so the turn completes in the same GAME time, and while paused `dt = 0` freezes the rotation with the game. `rate <= 0` (or omitted) = instant — `Current` is seeded at the command so the instant path is the pre-smoothing write verbatim. `Current` seeds from the aircraft's REAL heading at patch time (the turn starts where the nose points); a mid-turn re-command keeps `Current` and re-targets `Direction` (rotation continues from the intermediate heading). `CommandedDirection` returns `Current` so both direction-lock prefixes feed the smoothed value — otherwise the game's own path-tangent write would snap the nose back to the full command every tick. Note: if live testing at ×2 ever shows the turn finishing in HALF the game time (the game ticking 2×/wall-s at 1/60 each), drop the `timeScale` factor in `OnAircraftStep` — per-tick stepping is then automatically game-time-correct; keep the `timeScale <= 0` pause gate either way.
- **Clear-for-approach is smooth too (2026-08-03, v2 2026-08-03):** the handoff's one-frame snap — the state transition + path overwrite makes the game write the approach path-tangent heading verbatim — is smoothed the same way. `clearForApproach` plants a `FollowGameHeading` entry instead of removing the override: the rotation TARGET is the game's OWN intended heading, stashed by the channel-lock prefixes (`SetDirectionPrefix` is the only place the true path-tangent heading is visible — the postfix's own write-back through the same setter is filtered by an exact-match rule, or it would stall the rotation). The lock is PHASE-GATED: Phase 1 = pass-through (the nose flies the STAR freely until the handoff ACTUALLY lands — the deferred `CommandContinueApproach` flow takes ~3 s; locking early would fight the STAR's own turns), Phase 2 = rotate onto the approach course at the rate once the aircraft leaves `Fly` state. **The drop is SWEEP-GATED (v2):** the game's own approach turn is also deferred — for ~3 s after the lock the tangent is still the STAR heading sitting ON the nose, and the original "converged" drop fired against it within ~2 ticks; the game's real turn (observed ~42°/s easing) then snapped the nose onto the final course. A drop now requires the tangent to have SWEPT > 2° from the lock-time snapshot (proof the deferred turn ran) AND the nose to have caught it — the nose chases the game's live tangent at the rate and releases seamlessly once the tangent settles on the final course (whose heading the game computes itself — it is not derivable from the planted path). Release also on the restore-revert back to `Fly`, after 10 s with no transition, or the 60 s phase-2 bound (backstop — residual gap logs). New log lines: `override: <CS> cfa-turn: nose …° → smooth turn armed …`, `… approach transition landed — rotating …`, `… game's approach turn running — tangent swept …° — nose chasing …`, `… cfa-turn converged … (tangent swept …°) … — override dropped`, `… back on the STAR (handoff reverted) — override dropped`, `… no approach transition within 10 s — override dropped`, `… 60 s phase-2 bound — override dropped`. The editor's composer sends the same `TURN_RATE_DEG_S` (3) on the cfa frame as a KEYED field (`rate=3`) — a bare numeric would be misread as the kts approach speed; frames without a rate use the plugin's `ClearForApprTurnRateDeg` default (same 3°/s).
- **Runway resolution (2026-08-03):** the assigned runway (`Aircraft.RunwayReactive.CurrentValue`) is NOT guaranteed to be a key in `AirwayRouteService.RouteDict` — that dictionary keys only runways with routes registered, and a mid-STAR aircraft can hold a runway that isn't one (live: `clear_for_appr` on CDG8288 threw `KeyNotFoundException` from `GetRoute`'s raw `RouteDict[runway]` access, surfacing as `patch: clear_for_appr → CDG8288 FAILED: Il2CppException`). `GetArrivalRunway` now resolves every runway against `RouteDict.Keys` (identity or `Name`/`PhysicalName` match via `FindKeyedRunway`) so the service always receives one of its own instances, and the `GetRoute` call is wrapped in a try/catch that logs `cfa: <CS> GetRoute FAILED (runway <Name>/<PhysicalName>): …` and bails cleanly instead of letting the exception escape into the game tick.
- Aids used at runtime are `FindObjectsOfType<Aircraft3D>` (lookup by `Source.CallSign`), a cached VContainer `LifetimeScope` scan for `AirwayRouteService`, and a per-command VContainer scan for `RadioChannelManager` / `RadioSystem` (the jurisdiction handoff's tower-channel resolution).

## Rollback

Delete `BepInEx\plugins\AC27Appoarch\` and restart the game. Without the plugin both frame types are inert: a `!` SelectAircraft frame is a normal select miss, and a `0x00E7` frame is one `UnknownCommand` log line.

## Build

- SDK: net6.0 (built with SDK 7.0.410+), `LangVersion 10`, references pinned to `<GameDir>\BepInEx\core\` and `BepInEx\interop\` (see `AC27Appoarch.csproj` — `GameDir` property points at the Playtest install).
- Interop gotchas fixed at build time are documented in `docs/bepinex-aircraft-override-report.md` §6.4 ("Build-verified deltas").
- Design: `docs/bepinex-aircraft-override-report.md` (input surfaces §5, API design §4, verification checklist §8).

---
name: ac27-editor-mcp
description: Control the AC27 Editor from Claude Code via MCP tools. Create, read, modify, and delete flights in the currently-open .acl schedule file. Supports English and Chinese (中文) interaction.
---

# AC27 Editor MCP — Skill

## 1. What This Skill Enables

Control the AC27 Editor from Claude Code. Create, read, modify, and delete flights in the currently-open .acl schedule file. The user is responsible for opening and saving files via the editor UI — the MCP operates on whatever level is currently open.

## 2. Prerequisites

- Editor must be running (`npm start` or double-click the app). The API server auto-starts on `127.0.0.1:31415`.
- A level must be open in the editor (user loads it manually via the UI).
- **This skill file** must be installed so Claude Code understands the domain. Download from [GitHub](https://github.com/ericpzh/AC27LevelEditor/blob/master/.claude/skills/ac27-editor-mcp/SKILL.md) and place at `~/.claude/skills/ac27-editor-mcp/SKILL.md`.
- **`mcp/bridge.js`** must be accessible on disk. Clone the repo or download from [GitHub](https://github.com/ericpzh/AC27LevelEditor/blob/master/mcp/bridge.js).
- **Node.js 18+** required to run the bridge.
- Claude Code configured (see below).

**Dev setup** (`.mcp.json` at project root — auto-detected):
```json
{
  "mcpServers": {
    "ac27-editor": {
      "command": "node",
      "args": ["mcp/bridge.js"]
    }
  }
}
```

**Packaged app setup** (`.mcp.json` next to the `.exe`, with `mcp/bridge.js` in the same folder):
```json
{
  "mcpServers": {
    "ac27-editor": {
      "command": "node",
      "args": ["./mcp/bridge.js"]
    }
  }
}
```

## 3. Chinese Language Support (中文支持)

Users may interact in Chinese. The editor has full bilingual data — this skill teaches you how to use it.

### Airline Name Resolution (航空公司名称映射)

When a user says "国航" or "Air China", resolve to the 3-letter ICAO code.

#### Chinese Domestic Airlines (中国国内航司)

| Chinese Name | English Name | ICAO | Common Aliases / Short Names |
|-------------|-------------|------|------------------------------|
| 中国国际航空 | Air China | CCA | 国航 |
| 中国东方航空 | China Eastern Airlines | CES | 东航 |
| 中国南方航空 | China Southern Airlines | CSN | 南航 |
| 海南航空 | Hainan Airlines | CHH | 海航 |
| 国泰航空 | Cathay Pacific | CPA | 国泰 |
| 厦门航空 | Xiamen Airlines | CXA | 厦航 |
| 四川航空 | Sichuan Airlines | CSC | 川航 |
| 深圳航空 | Shenzhen Airlines | CSZ | 深航 |
| 山东航空 | Shandong Airlines | CDG | 山航 |
| 春秋航空 | Spring Airlines | CQH | 春秋 |
| 吉祥航空 | Juneyao Air | DKH | 吉祥 |

#### Major International Airlines (主要国际航司)

| Chinese Name | English Name | ICAO | Common Chinese Short Names |
|-------------|-------------|------|---------------------------|
| 美国航空 | American Airlines | AAL | 美航 |
| 联合航空 | United Airlines | UAL | 美联航 |
| 达美航空 | Delta Air Lines | DAL | 达美 |
| 英国航空 | British Airways | BAW | 英航 |
| 法国航空 | Air France | AFR | 法航 |
| 汉莎航空 | Lufthansa | DLH | 汉莎 / 德航 |
| 阿联酋航空 | Emirates | UAE | 阿联酋 / 土豪航 |
| 全日本空输 | All Nippon Airways | ANA | 全日空 |
| 日本航空 | Japan Airlines | JAL | 日航 |
| 新加坡航空 | Singapore Airlines | SIA | 新航 / 星航 |
| 大韩航空 | Korean Air | KAL | 大韩 |
| 长荣航空 | EVA Air | EVA | 长荣 |
| 中华航空 | China Airlines | CAL | 华航 |
| 卡塔尔航空 | Qatar Airways | QTR | 卡航 |
| 土耳其航空 | Turkish Airlines | THY | 土航 |
| 加拿大航空 | Air Canada | ACA | 加航 |
| 澳洲航空 | Qantas | QFA | 澳航 |
| 荷兰皇家航空 | KLM | KLM | 荷航 |
| 瑞士航空 | Swiss | SWR | 瑞航 |

**How to resolve:** Call `get_airport_info` → check `constraints.airlineCode` (codes known for this airport) and `constraints.flatLists.AirlineName` (full names in Chinese + English). Match user intent to a code: "国航" → "Air China" → "CCA". If the user uses a short name not listed above, try matching against `AirlineName` from `get_airport_info`.

### Chinese Field Name Mapping (中文字段名映射)

When a user uses Chinese field names, translate to the API field key:

| Chinese | API Field | | Chinese | API Field |
|---------|-----------|-|---------|-----------|
| 呼号 | CallSign | | 航司 | AirlineName |
| 出发 | DepartureAirport | | 机型 | AircraftType |
| 到达 | ArrivalAirport | | 进场程序 | Airway |
| 停机位 | Stand | | 注册号 | Registration |
| 跑道 | Runway | | 语音 | Voice |
| 推出 | OffBlockTime | | 语言 | Language |
| 起飞 | TakeoffTime | | 航司代码 | AirlineCode |
| 落地 | LandingTime | | 航班号 | FlightNum |
| 入位 | InBlockTime | | | |

### Chinese Phrase Translation Rules

- "把所有国航的航班改成01跑道" → `modify_flights({match:{airline:"CCA"}, updates:{Runway:"01"}})`
- "创建5个东航的出发航班" → build 5 flight objects with CallSign prefix "CES", type=departure
- "把停机位G5的航班注册号改成B-1234" → `modify_flights({match:{stand:"G5"}, updates:{Registration:"B-1234"}})`
- "删除所有14:00前的国泰到达" → `get_flights({airline:"CPA", type:"arrival", timeBefore:"14:00"})` then `delete_flights`
- "出发" / "离港" = departure (has OffBlockTime + TakeoffTime)
- "到达" / "进港" = arrival (has LandingTime + InBlockTime)
- Time: "10点" → "10:00", "10点30分" → "10:30", "下午2点" → "14:00"

## 4. Flight Anatomy

- **Arrival vs Departure**: Arrivals have LandingTime + InBlockTime + DepartureAirport. Departures have OffBlockTime + TakeoffTime + ArrivalAirport.
- **Callsign format**: 3-letter ICAO airline code + flight number (e.g., `CCA1234`).
- **The 15 fields**: CallSign, DepartureAirport, ArrivalAirport, Stand, Runway, OffBlockTime, TakeoffTime, LandingTime, InBlockTime, AirlineName, AircraftType, Airway, Registration, Voice, Language.
- **Time format**: HH:MM:SS (or HH:MM shorthand). Times are wall-clock times within the scenario config range.
- **Cascade rules** (applied server-side on modify): Changing AirlineCode rebuilds CallSign and resets AircraftType/Registration to first valid. Changing FlightNum rebuilds CallSign. Changing Runway resets Airway to first valid STAR.
- **Registration format**: Country prefix + hyphen + alphanumeric (e.g., `B-1234`, `N123AB`).

## 5. Validation Rules — How to Create Valid Flights

The server WILL reject invalid requests with a 422 error containing `error.details`. Follow these rules to avoid rejection.

**Rule 1: Airline code must be known.** Check `constraints.airlineCode` from `get_airport_info`. If the code isn't listed, the flight is rejected.

**Rule 2: Flight number must be canonical (if known).** Check `constraints.flightNumbers[airlineCode]`. If the airline has a list, use a number from it. If no list, any numeric string is accepted.

**Rule 3: Aircraft type must be compatible with airline.** Check `constraints.airlineAircraftCompat[airlineCode]`. If the airline has a compat list, the aircraft MUST be from it. This is the most important nested constraint.

**Rule 4: Airway/STAR must be compatible with runway (arrivals only).** Check `constraints.runwayStarCompat[runway]`. If the runway has a list, the airway MUST be from it.

**Rule 5: Registration must be valid for (airline, aircraft) pair.** Check `constraints.registrationsByPair['AAL|A320']`. If the pair has a list, the registration MUST be from it. Also: same registration on 2+ departures OR 2+ arrivals = rejected.

**Rule 6: Times must be within config range.** Check `configTimeRange`. All times must fall within this window. LandingTime < InBlockTime. OffBlockTime < TakeoffTime.

**Rule 7: Stand conflicts are checked.** Two departures on the same stand always conflict. A departure and arrival on the same stand conflict when OffBlockTime >= LandingTime.

**Rule 8: How to construct valid flight objects (14-step procedure):**
1. Call `get_airport_info`. Check `cacheReady` — if false, warn user.
2. Choose an airline code from `constraints.airlineCode`.
3. Choose a flight number from `constraints.flightNumbers[airlineCode]`. Combine into `CallSign = airlineCode + flightNumber`.
4. Choose an aircraft type from `constraints.airlineAircraftCompat[airlineCode]`.
5. Choose a runway from `constraints.flatLists.Runway`.
6. Choose a stand from `constraints.flatLists.Stand`.
7. For arrivals: choose an airway from `constraints.runwayStarCompat[runway]`. For departures: leave Airway empty.
8. Choose a registration from `constraints.registrationsByPair['airlineCode|aircraftType']`.
9. Look up AirlineName (reverse lookup: "CCA" → "Air China" / "中国国航").
10. Set times within `configTimeRange`. Arrivals: LandingTime < InBlockTime. Departures: OffBlockTime < TakeoffTime.
11. Set DepartureAirport (arrivals) or ArrivalAirport (departures) to the current airport ICAO.
12. Set Voice and Language from `constraints.flatLists`.
13. Build the complete 15-field object and pass to `create_flights({flights: [obj, ...]})`.
14. If 422: read `error.details`, fix the specific fields, retry.

**Rule 9: Server-side validation is the backstop.** If you miss a constraint, the server rejects with `error.details` containing the valid options for the rejected fields. You don't need to re-fetch `get_airport_info` to recover.

## 6. Tool Reference

### `get_editor_status`
No parameters. Returns: `editorReady`, `currentPath`, `currentAirport`, `flightCount`, `arrivalCount`, `departureCount`, `configStartTime`, `configEndTime`, `isDemo`, `modified`, `hasTimelines`.

### `get_airport_info`
No parameters. Returns: `cacheReady`, `currentAirport`, `configTimeRange`, and `constraints` with all validation maps (flatLists, airlineCode, flightNumbers, aircraftTypes, airlineAircraftCompat, runwayStarCompat, registrationsByPair, timeRules, standRules, registrationRules). **Call this before any create/modify.**

### `create_flights`
`{flights: [{CallSign, DepartureAirport, ArrivalAirport, Stand, Runway, OffBlockTime, TakeoffTime, LandingTime, InBlockTime, AirlineName, AircraftType, Airway, Registration, Voice, Language}]}`. All 15 fields required per flight. Returns `{success, created}` or 422 with `error.details`.

### `get_flights`
`{type?, airline?, callsign?, stand?, runway?, aircraftType?, timeAfter?, timeBefore?, limit?, offset?}`. Returns `{success, flights, total}`.

### `modify_flights`
`{match: {callsigns?, callsign?, airline?, type?, stand?, runway?, aircraftType?}, updates: {Stand?, Runway?, OffBlockTime?, ...}}`. Server applies cascade logic. Returns `{success, matched, modified}` or 422.

### `delete_flights`
`{match: {callsigns?, callsign?, airline?, type?, stand?, runway?, aircraftType?}}`. Returns `{success, deleted}`.

### `get_validation_issues`
No parameters. Returns `{success, issues, duplicateCallsigns, standConflicts, duplicateRegistrations}`.

## 7. Workflow Rules

- **Always check status first** — call `get_editor_status` at the start of any task. If `editorReady` is false, tell the user to open a level.
- **Get airport info before creating/modifying** — call `get_airport_info`. Follow the 14-step procedure in Rule 8.
- **Verify after modifying** — call `get_flights` after changes to confirm the result.
- **Validate after changes** — call `get_validation_issues` so the user knows about issues before saving.
- **Handle 422 errors gracefully** — read `error.details`, fix fields, retry. The error tells you exactly what to fix.
- **Remind user to save** — the MCP cannot save files. Remind the user to click Save in the editor UI.
- **Handle missing data** — if `cacheReady` is false or constraint maps are empty, warn the user that validation may be limited.

## 8. Composition Examples

### English Examples

**Example A: "Create 10 AAL departures, 1 min apart, randomize aircraft"**
```
1. get_editor_status → confirm level loaded, note currentAirport
2. get_airport_info → get constraint map (compat lists, flight numbers, registrations)
3. Construct 10 flight objects (LLM internally):
   Flight 1: { CallSign:"AAL1001", DepartureAirport:"", ArrivalAirport:"KJFK",
     Stand:"G1", Runway:"04L", OffBlockTime:"10:00:00", TakeoffTime:"10:05:00",
     LandingTime:"", InBlockTime:"", AirlineName:"American Airlines",
     AircraftType:"A320", Airway:"", Registration:"N123AB",
     Voice:"en-US-1", Language:"en" }
   ... (10 flights, incrementing times, varying aircraft/reg from compat lists)
4. create_flights({flights: [f1, f2, ..., f10]})
   → If 422: read error.details, fix, retry
5. get_flights({airline:"AAL", type:"departure", limit:20}) → show user
6. get_validation_issues → report issues
7. Remind user: "10 flights created. Click Save when ready."
```

**Example B: "Change all CCA flights to use runway 01"**
```
1. get_editor_status
2. get_airport_info → check runwayStarCompat["01"]
3. modify_flights({match:{airline:"CCA"}, updates:{Runway:"01"}})
   → server cascades Airway to first valid STAR for runway 01
4. get_flights({airline:"CCA", limit:200}) → verify
5. Remind user to save
```

**Example C: "Delete all JBU arrivals before 14:00"**
```
1. get_editor_status
2. get_flights({airline:"JBU", type:"arrival", timeBefore:"14:00"})
   → show user, confirm
3. delete_flights({match:{callsigns:[...]}})
4. get_editor_status → confirm new count, remind to save
```

### Chinese Examples (中文示例)

**示例 D: "创建10个国航出发航班，10点开始每隔1分钟一个，机型随机"**
```
1. get_editor_status → 确认已加载 level，currentAirport = "ZSJN"
2. get_airport_info → 获取约束：
   - airlineCode 包含 "CCA"
   - flightNumbers["CCA"] = ["1501", "1502", ...]
   - airlineAircraftCompat["CCA"] = ["A320", "B738", "B772"]
   - configTimeRange = { start: "06:00", end: "22:00" }
3. 构造10个完整 flight 对象：
   Flight 1: { CallSign:"CCA1501", DepartureAirport:"", ArrivalAirport:"ZSJN",
     Stand:"G1", Runway:"01", OffBlockTime:"10:00:00", TakeoffTime:"10:05:00",
     LandingTime:"", InBlockTime:"", AirlineName:"中国国航",
     AircraftType:"A320", Airway:"", Registration:"B-1234",
     Voice:"zh-CN-1", Language:"zh" }
   ... (LLM 生成10个)
4. create_flights({flights: [f1, f2, ..., f10]})
5. get_flights({airline:"CCA", type:"departure", limit:20})
6. get_validation_issues
7. 提醒用户："已创建10个航班，请在编辑器中点击保存"
```

**示例 E: "把所有国航航班改成01跑道"**
```
1. get_editor_status
2. get_airport_info → runwayStarCompat["01"]
3. modify_flights({match:{airline:"CCA"}, updates:{Runway:"01"}})
4. get_flights({airline:"CCA"}) → 验证
5. 提醒保存
```

**示例 F: "删除14:00前所有日航到达"**
```
1. get_editor_status
2. get_flights({airline:"JAL", type:"arrival", timeBefore:"14:00"}) → 展示并确认
3. delete_flights({match:{callsigns:[...]}})
4. get_editor_status → 确认
```

## 9. Error Recovery

- `get_editor_status` returns `editorReady: false` → tell user to open a level in the editor first (use Chinese if the user is speaking Chinese)
- `get_airport_info` returns `cacheReady: false` → warn user the airport cache may not be ready
- `create_flights` or `modify_flights` returns 422 with `error.details` → read each detail, fix the specific fields, retry. **Report the error in the user's language.**
- Airport constraint maps are empty → validation is best-effort; warn user but proceed
- `get_airport_info` fails entirely → MCP cannot reach the editor; check `npm start -- --api-port=31415`
- **User speaks Chinese but error uses English keys** → translate field names for the user (e.g., "Stand 'G99' is not valid" → "停机位 'G99' 无效")
- **User uses a Chinese airline name not in the mapping** → try calling `get_airport_info` and checking `constraints.flatLists.AirlineName` for a match; if unsure, ask the user for the 3-letter code

---
status: active
owner: team
last_reviewed: 2026-06-11
tags: [spec, data-format, telemetry, udp, playtest]
---

# 飞机状态 UDP 遥测报文格式

## 概述

Playtest 构建（及 Unity Editor）中，`AircraftUdpTelemetryService` 以 **10 Hz**（每 6 个 60 Hz 模拟 tick）向 `127.0.0.1:20266` 发送 UDP 单播报文，内容为全部已绑定航班计划的飞机快照，外加机场 ICAO 与模拟时间。反向控制通道见[飞机远程控制 UDP 命令格式](udp_remote_control.md)（入站，20267）。

- 实现：`Assets/Scripts/ContextCross/Telemetry/AircraftTelemetryPacketWriter.cs`、`AircraftUdpTelemetryService.cs`
- 门控：`#if ARTIFACT_PLAYTEST || UNITY_EDITOR`，Demo/Main 构建不包含该功能
- 传输契约：UDP fire-and-forget，无重传、无确认；接收端必须容忍丢包
- socket 初始化失败时遥测在启动时禁用并记一条警告日志，不影响游戏运行
- 仅在游戏状态为 `Running` 时发送；没有飞机时仍发送 header-only 报文，可当作携带模拟时间的心跳

## 编码约定

- 字节序：**小端（little-endian）**
- 字符串：定长 ASCII，右侧零填充；超长截断；非 ASCII 字符替换为 `?`；空值为全零
- 浮点：IEEE 754 single（f32）

## Header（40 字节）

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | u32 | magic | `0x43544147`，按字节读为 ASCII `"GATC"` |
| 4 | u16 | version | 当前为 `1`，布局语义变化时递增 |
| 6 | u16 | headerSize | 当前为 `40`，记录区起始偏移 |
| 8 | u16 | recordSize | 当前为 `112`，单条记录跨步 |
| 10 | u16 | recordCount | 本报文记录条数 |
| 12 | 4B | airportIcao | 机场 ICAO 四字码，ASCII 大写 |
| 16 | u64 | simTick | 模拟 tick（60 Hz） |
| 24 | i64 | simTimeUnixMs | 模拟时间，自 1970-01-01T00:00:00 起的毫秒数（游戏内本地时间，无时区概念） |
| 32 | 8B | reserved | 置零 |

## Record（每条 112 字节，自 `headerSize + i * recordSize` 起）

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | 12B | callSign | 当前激活航段的呼号 |
| 12 | 8B | aircraftType | ICAO 机型代码（`Specification.Designator`，如 `B77W`/`A320`）；机型缺规格档案时为全零（伴随一条警告日志） |
| 20 | u8 | flightDirection | `0` = Departure，`1` = Arrival（与 `EFlightDirection` 一致） |
| 21 | 3B | reserved | 置零（对齐） |
| 24 | 3×f32 | position | Unity 世界坐标 (x, y, z) |
| 36 | 3×f32 | noseDirection | 机头朝向单位向量（Unity 世界坐标），地面与空中均有效，绘制朝向用本字段 |
| 48 | f32 | taxiSpeed | 地面滑行速度（模拟内部值） |
| 52 | f32 | airSpeedKnot | 空速，单位节（knot） |
| 56 | 16B | star | 进场 STAR 程序名；离场航段为全零 |
| 72 | 4B | runway | 当前航段使用的跑道名 |
| 76 | 8B | stand | 当前航段使用的机位名 |
| 84 | 16B | route | 当前激活航路名（`AircraftState.Route`，地面阶段可能为滑行道序列） |
| 100 | 12B | reserved | 置零 |

未绑定航班计划的飞机不会出现在报文中。

报文不含速度向量：地面运动用 `noseDirection × taxiSpeed`，空中用 `noseDirection × airSpeedKnot` 或位置差分。

## 拆包规则

单个 UDP 报文最大 65507 字节，最多容纳 `(65507 - 40) / 112 = 584` 条记录。超出时拆分为多个报文，每个报文带完整 Header（`simTick`/`simTimeUnixMs` 相同），`recordCount` 为各自实际条数。接收端不应假设一个 tick 的全部飞机在同一报文内。

## 版本与向后兼容

- **只加不减**：已发布字段的偏移、类型、语义永不变更或删除。
- 新增字段优先占用 reserved 区；不够时在 Header 或 Record 尾部追加并增大 `headerSize` / `recordSize`。
- 接收端必须以 Header 中的 `headerSize` 定位记录区起点、以 `recordSize` 作为记录跨步，而不是硬编码常量；这样旧接收端可以自动跳过新版本追加的字段。
- 任何字段语义变化（含 reserved 区启用）都必须递增 `version` 并更新本文档。

## 接收端解析示例（Python）

```python
import socket
import struct

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("127.0.0.1", 20266))

while True:
    buf, _ = sock.recvfrom(65535)
    magic, version, header_size, record_size, count, icao, tick, sim_ms = \
        struct.unpack_from("<IHHHH4sQq", buf, 0)
    assert magic == 0x43544147
    for i in range(count):
        off = header_size + i * record_size
        callsign, actype, direction = struct.unpack_from("<12s8sB", buf, off)
        px, py, pz, nx, ny, nz, taxi, ias = struct.unpack_from("<8f", buf, off + 24)
        star, runway, stand, route = struct.unpack_from("<16s4s8s16s", buf, off + 56)
```

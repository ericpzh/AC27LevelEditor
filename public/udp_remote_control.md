---
status: active
owner: team
last_reviewed: 2026-06-11
tags: [spec, data-format, telemetry, udp, playtest, remote-control]
---

# 飞机远程控制 UDP 命令格式

## 概述

Playtest 构建（及 Unity Editor）中，`AircraftUdpCommandService` 监听 `127.0.0.1:20267`，接收外部进程发来的控制命令。与[飞机状态 UDP 遥测](udp_aircraft_telemetry.md)（出站，20266）互为反向通道。

- 实现：`Assets/Scripts/ContextCross/Telemetry/UdpCommandParser.cs`、`AircraftUdpCommandService.cs`
- 门控：`#if ARTIFACT_PLAYTEST || UNITY_EDITOR`，Demo/Main 构建不包含该功能
- 仅绑定回环地址，外部机器无法直连
- 命令在主线程每个模拟 tick（60 Hz）排空执行，延迟 ≤ 1 tick；每 tick 最多处理 64 条，超出部分留在 socket 缓冲区下一 tick 继续；无应答报文（fire-and-forget），执行效果可通过遥测流观察
- 模拟暂停（FixedUpdate 停转）期间命令会积压在 socket 缓冲区，恢复后按序执行
- 端口 20267 被其他进程占用时，通道在启动时禁用并记一条警告日志，不影响游戏运行

## 编码约定

与遥测一致：小端、定长 ASCII 零填充。**每个 UDP datagram 恰好一条命令**，无需分帧。

## Header（8 字节）

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | u32 | magic | `0x43544147`，按字节读为 ASCII `"GATC"` |
| 4 | u16 | version | 当前为 `1` |
| 6 | u16 | commandId | 见下表 |

Header 之后（偏移 8 起）紧跟该命令的 payload；**报文总长必须恰好等于 Header + payload**，带尾部冗余字节的报文按非法丢弃。

## 命令表

| commandId | 命令 | payload | 总长 |
|---|---|---|---|
| 1 | SelectAircraft | callSign 12B ASCII 零填充（与遥测 record 的 callSign 字段同宽，可原样回传） | 20B |

### SelectAircraft 语义

行为与玩家点击飞机完全一致：

1. 按呼号查找当前关卡内的飞机（大小写不敏感，自动 Trim）；找不到则丢弃并记日志。
2. 走 `IAircraftSelectionService.RequestSelect()` 统一入口——受教程等操作限制约束，发布 `OnSelect<Aircraft>`（UI 高亮、镜头自动跟随等既有订阅者全部生效）。
3. 选中生效后发布 `PlayerAircraftFocusEvent`（`Method = Remote`），教程任务与玩家行为统计按真实点击处理。

## 错误处理

非法报文（magic/version 错误、总长不符、未知 commandId、空呼号）直接丢弃，不影响模拟；首个坏包记一条警告日志。

## 版本与向后兼容

- 已发布 commandId 的 payload 布局与语义永不变更；新能力一律新增 commandId。
- payload 布局变化必须递增 `version` 并更新本文档。

## 发送示例（Python）

```python
import socket
import struct

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def select_aircraft(callsign: str):
    payload = struct.pack("<IHH12s", 0x43544147, 1, 1, callsign.encode("ascii"))
    sock.sendto(payload, ("127.0.0.1", 20267))

select_aircraft("CES2104")
```

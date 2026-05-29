"""
ACL File Parser - handles Newtonsoft.Json serialization with $type + $rcontent.
Parses FlightSchedule.$rcontent entries, preserving all other data untouched.
"""

import re
import os
import random
from datetime import datetime, timedelta

# .NET DateTime epoch: 1/1/0001
NET_EPOCH = datetime(1, 1, 1)
TICKS_PER_SECOND = 10_000_000


def ticks_to_time(ticks):
    if ticks == 0:
        return ""
    delta = timedelta(microseconds=ticks / 10)
    dt = NET_EPOCH + delta
    return dt.strftime("%H:%M:%S")


def time_to_ticks(time_str):
    if not time_str or time_str.strip() == "":
        return 0
    try:
        h, m, s = map(int, time_str.strip().split(":"))
        delta = timedelta(hours=h, minutes=m, seconds=s)
        return int(delta.total_seconds() * TICKS_PER_SECOND)
    except (ValueError, AttributeError):
        return 0


FIELDS = [
    ("CallSign", "string"),
    ("DepartureAirport", "string"),
    ("ArrivalAirport", "string"),
    ("Stand", "string"),
    ("Runway", "string"),
    ("OffBlockTime", "time"),
    ("TakeoffTime", "time"),
    ("LandingTime", "time"),
    ("InBlockTime", "time"),
    ("AirlineName", "string"),
    ("AircraftType", "string"),
    ("Voice", "string"),
    ("Language", "string"),
]

FIELD_LABELS = {
    "CallSign": "呼号",
    "DepartureAirport": "出发",
    "ArrivalAirport": "到达",
    "Stand": "停机位",
    "Runway": "跑道",
    "OffBlockTime": "推出",
    "TakeoffTime": "起飞",
    "LandingTime": "落地",
    "InBlockTime": "入位",
    "AirlineName": "航司",
    "AircraftType": "机型",
    "Voice": "语音",
    "Language": "语言",
}


def load_flights(acl_path):
    """
    Load FlightSchedule entries from .acl file.
    Structure: "FlightSchedule": { ... "$rcontent": [ {FlightPlanState}, ... ] }
    Returns (list_of_dicts, before, after, array_content, original_blocks).
    """
    with open(acl_path, 'r', encoding='utf-8') as f:
        text = f.read()

    # First find "FlightSchedule" key
    fs_match = re.search(r'"FlightSchedule"\s*:\s*\{', text)
    if not fs_match:
        raise ValueError("FlightSchedule not found in .acl file")

    # Then find $rcontent array AFTER "FlightSchedule"
    rc_pattern = r'"\$rcontent"\s*:\s*\['
    m = re.search(rc_pattern, text[fs_match.start():])
    if not m:
        raise ValueError("$rcontent not found in FlightSchedule")

    # Position after the opening '[' (absolute)
    pos = fs_match.start() + m.end()

    # Find matching ']' by tracking nested {} depth
    depth = 0
    end_pos = None
    for i in range(pos, len(text)):
        c = text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                # Check if next char is ']'
                j = i + 1
                while j < len(text) and text[j] in ' \t\n\r':
                    j += 1
                if j < len(text) and text[j] == ']':
                    end_pos = i + 1  # include the last '}'
                    break
        elif c == ']' and depth == 0:
            end_pos = i
            break

    if end_pos is None:
        raise ValueError("Could not find end of $rcontent array")

    before = text[:pos]
    after = text[end_pos:]
    array_content = text[pos:end_pos]

    # Parse each FlightPlanState entry (each is a {...} block)
    flights = []
    original_blocks = []
    depth = 0
    entry_start = -1
    for i, ch in enumerate(array_content):
        if ch == '{':
            if depth == 0:
                entry_start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and entry_start >= 0:
                block = array_content[entry_start:i+1]
                original_blocks.append(block)
                flight = _parse_flight_block(block)
                if flight:
                    flights.append(flight)
                entry_start = -1

    return flights, before, after, array_content, original_blocks


def _parse_flight_block(block):
    """Parse a single FlightPlanState JSON block into a dict."""
    flight = {}

    for field_name, field_type in FIELDS:
        if field_type == "string":
            m = re.search(rf'"{field_name}"\s*:\s*"([^"]*)"', block)
            if m:
                flight[field_name] = m.group(1)
            else:
                flight[field_name] = ""
        elif field_type == "time":
            m = re.search(rf'"{field_name}"\s*:\s*\{{\s*"\$type"\s*:\s*3\s*,\s*(-?\d+)\s*\}}', block)
            if m:
                flight[field_name] = ticks_to_time(int(m.group(1)))
            else:
                flight[field_name] = ""

    return flight


def save_flights(acl_path, flights, before, after, array_content, original_blocks):
    """
    Write modified flights back. Uses regex replacement on original blocks
    to preserve $id, $type, null handling, formatting, etc.
    """
    new_blocks = []
    for i, flight in enumerate(flights):
        if i < len(original_blocks):
            block = _apply_changes(original_blocks[i], flight)
        else:
            # New flight - build from the last original block as template
            template = original_blocks[-1] if original_blocks else None
            block = _build_new_block(flight, template)
        new_blocks.append(block)

    new_array = ",\n            ".join(new_blocks)
    new_text = before + new_array + after

    with open(acl_path, 'w', encoding='utf-8') as f:
        f.write(new_text)


def _apply_changes(block, flight):
    """Modify an existing FlightPlanState block with new values using regex replacement."""
    for field_name, field_type in FIELDS:
        if field_type == "string":
            val = flight.get(field_name, "")
            if val:
                # Try replacing existing string value
                m = re.search(rf'("{field_name}"\s*:\s*)"(?:[^"\\]|\\.)*"', block)
                if m:
                    block = block[:m.start()] + m.group(1) + '"' + val + '"' + block[m.end():]
                else:
                    # Try replacing null
                    m_null = re.search(rf'("{field_name}"\s*:\s*)null', block)
                    if m_null:
                        block = block[:m_null.start()] + m_null.group(1) + '"' + val + '"' + block[m_null.end():]
            else:
                # Empty value -> set to null
                m = re.search(rf'("{field_name}"\s*:\s*)"(?:[^"\\]|\\.)*"', block)
                if m:
                    block = block[:m.start()] + m.group(1) + 'null' + block[m.end():]
        elif field_type == "time":
            time_str = flight.get(field_name, "")
            ticks = time_to_ticks(time_str)
            m = re.search(
                rf'("{field_name}"\s*:\s*\{{\s*"\$type"\s*:\s*3\s*,\s*)(-?\d+)(\s*\}})',
                block
            )
            if m:
                block = block[:m.start(2)] + str(ticks) + block[m.end(2):]
    return block


def _build_new_block(flight, template_block=None):
    """Build a new FlightPlanState block from scratch."""
    if template_block:
        # Use template but override all values
        block = template_block
        # Generate new $id
        new_id = random.randint(90000, 99999)
        block = re.sub(r'"\$id"\s*:\s*\d+', f'"$id": {new_id}', block)
        return _apply_changes(block, flight)

    # Fallback: build from scratch
    lines = ['{']
    lines.append('                "$id": 90000,')
    lines.append('                "$type": 34,')
    for field_name, field_type in FIELDS:
        if field_type == "string":
            val = flight.get(field_name, "")
            if val:
                lines.append(f'                "{field_name}": "{val}",')
            else:
                lines.append(f'                "{field_name}": null,')
        elif field_type == "time":
            ticks = time_to_ticks(flight.get(field_name, ""))
            lines.append(f'                "{field_name}": {{')
            lines.append(f'                    "$type": 3,')
            lines.append(f'                    {ticks}')
            lines.append(f'                }},')
    lines[-1] = lines[-1].rstrip(',')
    lines.append('            }')
    return '\n'.join(lines)


def export_csv(flights, csv_path):
    """Export flights to CSV matching flight_schedule_*.csv format."""
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        headers = [
            "callSign", "departure", "arrival", "stand", "runway",
            "offBlockTime", "takeOffTime", "landingTime", "inBlockTime",
            "airline", "aircraftType", "voice", "language"
        ]
        f.write(','.join(headers) + '\n')
        for fl in flights:
            row = [
                fl.get("CallSign", ""),
                fl.get("DepartureAirport", ""),
                fl.get("ArrivalAirport", ""),
                fl.get("Stand", ""),
                fl.get("Runway", ""),
                fl.get("OffBlockTime", ""),
                fl.get("TakeoffTime", ""),
                fl.get("LandingTime", ""),
                fl.get("InBlockTime", ""),
                fl.get("AirlineName", ""),
                fl.get("AircraftType", ""),
                fl.get("Voice", ""),
                fl.get("Language", ""),
            ]
            f.write(','.join(str(v) for v in row) + '\n')


def import_csv(csv_path):
    """Import flights from CSV. Returns list of dicts."""
    flights = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    if not lines:
        return flights

    header = lines[0].strip().lower().split(',')
    col_map = {col.strip(): i for i, col in enumerate(header)}

    field_map = {
        "callsign": "CallSign",
        "departure": "DepartureAirport",
        "arrival": "ArrivalAirport",
        "stand": "Stand",
        "runway": "Runway",
        "offblocktime": "OffBlockTime",
        "takeofftime": "TakeoffTime",
        "landingtime": "LandingTime",
        "inblocktime": "InBlockTime",
        "airline": "AirlineName",
        "aircrafttype": "AircraftType",
        "voice": "Voice",
        "language": "Language",
        "pushbacktime": "OffBlockTime",
        "departuretime": "TakeoffTime",
        "arrivaltime": "InBlockTime",
    }

    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(',')]
        flight = {}
        for csv_col, i in col_map.items():
            csv_lower = csv_col.lower()
            if csv_lower in field_map:
                if i < len(parts):
                    flight[field_map[csv_lower]] = parts[i]
        for fn, _ in FIELDS:
            if fn not in flight:
                flight[fn] = ""
        if flight.get("CallSign", ""):
            flights.append(flight)
    return flights


def count_stats(flights):
    """Count arrivals and departures."""
    arrivals = 0
    departures = 0
    for fl in flights:
        if fl.get("LandingTime", "").strip():
            arrivals += 1
        if fl.get("OffBlockTime", "").strip():
            departures += 1
    return arrivals, departures

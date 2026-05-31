"""
Extract arrival STAR approach coordinates from all ACL files.

Flow:
  CallSign → FlightPlans UUID → Aircrafts[] → FlightPlanGuid match
    → DynamicInternalState → DynamicsParams → InitialPosition, ApproachDirection

ACL format: Unity Tolerant JSON (UNPARSEABLE by stdlib json — positional values in objects).
Strategy: line-by-line state-machine extraction.
"""

import json
import re
import os
import sys
from pathlib import Path
from collections import defaultdict

AIRPORTS_ROOT = Path(r"D:\SteamLibrary\steamapps\common\Airport Control 25 Playtest\GroundATC_Data\StreamingAssets\Airports")
OUTPUT_PATH = AIRPORTS_ROOT.parent / "star_approach_coords.json"

SKIP_SUFFIXES = (".demo.acl", "-bak.acl", "_backup_", ".bak")


def extract_flight_plans(lines: list) -> dict:
    """
    Find the FlightPlans section and extract for each arrival:
    { uuid: { callSign, star, runway } }
    """
    result = {}
    
    # Find the FlightPlans section
    i = 0
    while i < len(lines):
        if '"FlightPlans"' in lines[i]:
            break
        i += 1
    
    if i >= len(lines):
        return result
    
    # Now scan inside FlightPlans for "$k": "<uuid>" entries
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        
        # "$k": "uuid"
        m_k = re.match(r'"\$k"\s*:\s*"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})"', stripped)
        if m_k:
            fp_uuid = m_k.group(1)
            # Scan forward for "Arrival" block
            j = i + 1
            arrival_data = {"callSign": "", "star": "", "runway": ""}
            in_arrival = False
            while j < len(lines) and j < i + 80:
                s = lines[j].strip()
                
                if '"Arrival"' in s:
                    in_arrival = True
                    j += 1
                    continue
                
                if in_arrival:
                    m_cs = re.match(r'"CallSign"\s*:\s*"(.+?)"', s)
                    if m_cs:
                        arrival_data["callSign"] = m_cs.group(1)
                    
                    m_star = re.match(r'"STAR"\s*:\s*"(.+?)"', s)
                    if m_star:
                        arrival_data["star"] = m_star.group(1)
                    
                    m_rwy = re.match(r'"Runway"\s*:\s*"(.+?)"', s)
                    if m_rwy:
                        arrival_data["runway"] = m_rwy.group(1)
                    
                    # Arrival block ends at "Stand" or closing brace of Arrival
                    if '"Stand"' in s and in_arrival:
                        # Arrival ends after Stand (or next key)
                        pass
                    
                    if '"OriginAirport"' in s and not arrival_data["callSign"]:
                        pass  # continue
                    
                    # If we see "Departure" or another top-level key, stop
                    if s.startswith('"Departure"') or s.startswith('"Guid"') or s.startswith('"Registration"'):
                        break
                
                j += 1
            
            if arrival_data["callSign"] and arrival_data["star"] and arrival_data["runway"]:
                result[fp_uuid] = arrival_data
        
        i += 1
    
    return result


def extract_aircraft_coords(lines: list, fp_uuids: set) -> dict:
    """
    Find Aircrafts section, match FlightPlanGuid to uuids,
    extract InitialPosition + ApproachDirection from nearby lines.
    Returns: { fp_uuid: { initialPosition: [x,y,z], approachDirection: [x,y,z] } }
    """
    result = {}
    remaining = set(fp_uuids)
    if not remaining:
        return result
    
    # Find Aircrafts section
    i = 0
    while i < len(lines):
        if '"Aircrafts"' in lines[i]:
            break
        i += 1
    
    if i >= len(lines):
        return result
    
    # Scan for "FlightPlanGuid": "uuid"
    while i < len(lines) and remaining:
        line = lines[i]
        stripped = line.strip()
        
        m_fp = re.match(r'"FlightPlanGuid"\s*:\s*"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})"', stripped)
        if m_fp:
            fp_uuid = m_fp.group(1)
            if fp_uuid in remaining:
                # Found an aircraft for this flight plan.
                # Now scan nearby for InitialPosition and ApproachDirection
                init_pos = _find_vec3_nearby(lines, i, "InitialPosition")
                app_dir = _find_vec3_nearby(lines, i, "ApproachDirection")
                
                if init_pos and app_dir:
                    result[fp_uuid] = {
                        "initialPosition": init_pos,
                        "approachDirection": app_dir,
                    }
                    remaining.discard(fp_uuid)
        
        i += 1
    
    return result


def _find_vec3_nearby(lines: list, center_idx: int, key_name: str) -> list | None:
    """Search within 150 lines of center_idx for key_name's Vector3 values."""
    for offset in range(-150, 151):
        j = center_idx + offset
        if j < 0 or j >= len(lines):
            continue
        stripped = lines[j].strip()
        if stripped.startswith(f'"{key_name}"'):
            # Scan forward for 3 float values
            floats = []
            for k in range(j + 1, min(len(lines), j + 8)):
                s = lines[k].strip()
                if s in ('{', '}', '', ','):
                    continue
                if s.startswith('"$type"'):
                    continue
                if s.startswith('"$id"'):
                    continue
                # Try to parse as float
                val = s.rstrip(',')
                try:
                    floats.append(float(val))
                except ValueError:
                    break
                if len(floats) >= 3:
                    return floats[:3]
    return None


def extract_level_name(filepath: Path) -> str:
    """Try to get the level name embedded in the ACL (Config.name)."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            for line in f:
                m = re.match(r'\s*"name"\s*:\s*"(.+?)"', line)
                if m:
                    return m.group(1)
                if line.strip().startswith('"Config"'):
                    continue
                if line.strip().startswith('"WorldState"'):
                    break
    except Exception:
        pass
    return filepath.stem


def main():
    all_results = []
    stats = defaultdict(int)

    for airport_dir in sorted(AIRPORTS_ROOT.iterdir()):
        if not airport_dir.is_dir():
            continue

        airport_code = airport_dir.name.upper()
        levels_dir = airport_dir / "Levels"
        if not levels_dir.is_dir():
            continue

        acl_files = sorted(
            f for f in levels_dir.iterdir()
            if f.suffix == '.acl'
            and f.is_file()
            and not any(s in f.name for s in SKIP_SUFFIXES)
        )

        if not acl_files:
            continue

        print(f"\n[{airport_code}] {len(acl_files)} ACL files")

        for acl_file in acl_files:
            with open(acl_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()

            # Step 1: Extract FlightPlans → arrival info
            flight_plans = extract_flight_plans(lines)
            if not flight_plans:
                print(f"  {acl_file.name}: 0 FlightPlans")
                stats['no_flightplans'] += 1
                continue

            fp_uuids = set(flight_plans.keys())

            # Step 2: Match with Aircrafts section → coordinates
            aircraft_coords = extract_aircraft_coords(lines, fp_uuids)

            # Step 3: Join and produce results
            count = 0
            for fp_uuid, fp_data in flight_plans.items():
                ac = aircraft_coords.get(fp_uuid)
                if ac:
                    all_results.append({
                        "airport": airport_code,
                        "arrivalRunway": fp_data["runway"],
                        "arrivalSTAR": fp_data["star"],
                        "initialPosition": [round(v, 4) for v in ac["initialPosition"]],
                        "approachDirection": [round(v, 4) for v in ac["approachDirection"]],
                    })
                    count += 1

            print(f"  {acl_file.name}: {len(flight_plans)} arrivals, {count} matched")
            stats['total_arrivals'] += len(flight_plans)
            stats['matched'] += count
            stats['files'] += 1

    # Deduplicate by (airport, arrivalRunway, arrivalSTAR) — keep first seen
    seen = set()
    deduped = []
    for r in all_results:
        key = (r["airport"], r["arrivalRunway"], r["arrivalSTAR"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)

    print(f"\n{'='*60}")
    print(f"Files processed:  {stats['files']}")
    print(f"Total arrivals:   {stats['total_arrivals']}")
    print(f"Matched (coords): {stats['matched']}")
    print(f"Unique STAR+Runway: {len(deduped)}")

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(deduped, f, indent=2, ensure_ascii=False)

    print(f"\nOutput: {OUTPUT_PATH}")

    # Print summary
    if deduped:
        print()
        for r in deduped:
            print(f"  {r['airport']} RWY{r['arrivalRunway']} {r['arrivalSTAR']} → IP({r['initialPosition'][0]:.2f},{r['initialPosition'][1]:.2f},{r['initialPosition'][2]:.2f}) AD({r['approachDirection'][0]:.4f},{r['approachDirection'][1]:.4f},{r['approachDirection'][2]:.4f})")


if __name__ == "__main__":
    main()

import re
from pathlib import Path

from extract_star_coords import extract_flight_plans, extract_aircraft_coords, _find_vec3_nearby

fp = Path(r"D:/SteamLibrary/steamapps/common/Airport Control 25 Playtest/GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_07-09.acl")
with open(fp, 'r', encoding='utf-8') as f:
    lines = f.readlines()

flight_plans = extract_flight_plans(lines)
print(f"FlightPlans (arrivals): {len(flight_plans)}")
for uuid, data in list(flight_plans.items())[:3]:
    print(f"  {uuid}: {data}")

fp_uuids = set(flight_plans.keys())
aircraft_coords = extract_aircraft_coords(lines, fp_uuids)
print(f"\nAircraft coords matched: {len(aircraft_coords)}")
for uuid, data in list(aircraft_coords.items())[:3]:
    print(f"  {uuid}: {data}")

# Test specific UUID
test_uuid = "8eba7a02-a0a5-4702-820d-715b9d9e4302"
print(f"\nTesting JBU2039 uuid {test_uuid}")
print(f"  In flight_plans: {test_uuid in flight_plans}")
print(f"  In aircraft_coords: {test_uuid in aircraft_coords}")

# Manually find FlightPlanGuid line
for i, line in enumerate(lines):
    if test_uuid in line and 'FlightPlanGuid' in line:
        print(f"  FlightPlanGuid line: {i}")
        ip = _find_vec3_nearby(lines, i, "InitialPosition")
        ad = _find_vec3_nearby(lines, i, "ApproachDirection")
        print(f"  InitialPosition: {ip}")
        print(f"  ApproachDirection: {ad}")
        break

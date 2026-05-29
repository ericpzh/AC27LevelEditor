from acl_parser import load_flights, count_stats, save_flights
import os

path = r'../GroundATC_Data/StreamingAssets/Airports/KJFK/Levels/KJFK_07-09.acl'

# Test load
flights, before, after, arr_content, orig = load_flights(path)
print(f'Loaded {len(flights)} flights, {len(orig)} blocks')
a, d = count_stats(flights)
print(f'Arrivals: {a}, Departures: {d}')
print(f'First call: {flights[0]["CallSign"]}')
print(f'Last call:  {flights[-1]["CallSign"]}')
print(f'Keys: {list(flights[0].keys())}')

# Test modify and save
old_cs = flights[0]["CallSign"]
flights[0]["CallSign"] = "TEST7777"
print(f'\nChanged call: {old_cs} -> TEST7777')

save_flights(path, flights, before, after, arr_content, orig)
print('Saved!')

# Reload and verify
flights2, b2, a2, ac2, o2 = load_flights(path)
print(f'Reloaded first: {flights2[0]["CallSign"]}')
assert flights2[0]["CallSign"] == "TEST7777", f"MODIFY FAILED! Got {flights2[0]['CallSign']}"
print('Modify verified!')

# Test time field
print(f'Reloaded LandingTime[0]: "{flights2[0]["LandingTime"]}"')
assert flights2[0]["LandingTime"] == flights[0]["LandingTime"], "Time field mismatch!"

# Restore
flights2[0]["CallSign"] = old_cs
save_flights(path, flights2, b2, a2, ac2, o2)
flights3, _, _, _, _ = load_flights(path)
print(f'Restored: {flights3[0]["CallSign"]}')
assert flights3[0]["CallSign"] == old_cs, f"RESTORE FAILED! Got {flights3[0]['CallSign']}"
print('Restore verified!')

# File size sanity
size = os.path.getsize(path)
print(f'\nFile size: {size:,} bytes')
assert 10_000_000 < size < 15_000_000, f"Bad file size: {size}"

print('\n=== ALL TESTS PASSED ===')

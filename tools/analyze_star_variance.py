"""
Analyze whether InitialPosition and ApproachDirection vary across flights/files
for the same (airport, runway, STAR) combination.
Reuses extraction functions from extract_star_coords but outputs a variance report.
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

# Import from the sibling script
sys.path.insert(0, str(Path(__file__).parent))
from extract_star_coords import (
    AIRPORTS_ROOT, SKIP_SUFFIXES,
    extract_flight_plans, extract_aircraft_coords,
)

OUTPUT_PATH = AIRPORTS_ROOT.parent / "star_coords_variance.json"


def main():
    # { (airport, runway, star): [ {file, callSign, ip, ad} ] }
    grouped = defaultdict(list)
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
            if f.suffix == '.acl' and f.is_file()
            and not any(s in f.name for s in SKIP_SUFFIXES)
        )
        if not acl_files:
            continue

        for acl_file in acl_files:
            lines = acl_file.read_text('utf-8').splitlines()
            flight_plans = extract_flight_plans(lines)
            if not flight_plans:
                stats['no_flightplans'] += 1
                continue

            fp_uuids = set(flight_plans.keys())
            aircraft_coords = extract_aircraft_coords(lines, fp_uuids)

            for fp_uuid, fp_data in flight_plans.items():
                ac = aircraft_coords.get(fp_uuid)
                if not ac:
                    continue
                key = (airport_code, fp_data["runway"], fp_data["star"])
                grouped[key].append({
                    "file": acl_file.name,
                    "callSign": fp_data["callSign"],
                    "initialPosition": [round(v, 6) for v in ac["initialPosition"]],
                    "approachDirection": [round(v, 6) for v in ac["approachDirection"]],
                })
                stats['matched'] += 1
            stats['files'] += 1

    # Analyze variance per group
    results = []
    for key, entries in sorted(grouped.items()):
        airport, runway, star = key
        ips = [tuple(e["initialPosition"]) for e in entries]
        ads = [tuple(e["approachDirection"]) for e in entries]

        ip_unique = list(set(ips))
        ad_unique = list(set(ads))

        ip_max_diff = calc_max_diff(ips)
        ad_max_diff = calc_max_diff(ads)

        source_files = sorted(set(e["file"] for e in entries))

        results.append({
            "airport": airport,
            "runway": runway,
            "STAR": star,
            "sampleCount": len(entries),
            "totalFiles": len(source_files),
            "sourceFiles": source_files,
            "initialPosition": {
                "uniqueValues": ip_unique,
                "allSame": len(ip_unique) == 1,
                "maxDifference": round(ip_max_diff, 8) if ip_max_diff is not None else None,
            },
            "approachDirection": {
                "uniqueValues": ad_unique,
                "allSame": len(ad_unique) == 1,
                "maxDifference": round(ad_max_diff, 8) if ad_max_diff is not None else None,
            },
        })

    out = {
        "summary": {
            "files": stats['files'],
            "totalMatched": stats['matched'],
            "uniqueSTAR_Runway": len(results),
            "allIPidentical": all(r["initialPosition"]["allSame"] for r in results),
            "allADidentical": all(r["approachDirection"]["allSame"] for r in results),
        },
        "details": results,
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    # Pretty print
    print(f"\n{'='*60}")
    print(f"Files: {stats['files']}  Matched flights: {stats['matched']}  Unique STARs: {len(results)}")
    print(f"All InitialPositions identical across same STAR+Runway: {out['summary']['allIPidentical']}")
    print(f"All ApproachDirections identical across same STAR+Runway: {out['summary']['allADidentical']}")
    print(f"\nOutput: {OUTPUT_PATH}")
    print(f"\n{'='*60}")

    for r in results:
        print(f"\n{r['airport']} RWY{r['runway']} {r['STAR']}  ({r['sampleCount']} flights from {r['totalFiles']} files)")
        ip = r["initialPosition"]
        ad = r["approachDirection"]
        if ip["allSame"]:
            v = ip["uniqueValues"][0]
            print(f"  InitialPosition:    SAME → ({v[0]:.6f}, {v[1]:.6f}, {v[2]:.6f})")
        else:
            print(f"  InitialPosition:    {len(ip['uniqueValues'])} DIFFERENT values, maxDelta={ip['maxDifference']:.8f}")
            for v in ip["uniqueValues"]:
                print(f"    ({v[0]:.6f}, {v[1]:.6f}, {v[2]:.6f})")
        if ad["allSame"]:
            v = ad["uniqueValues"][0]
            print(f"  ApproachDirection:  SAME → ({v[0]:.6f}, {v[1]:.6f}, {v[2]:.6f})")
        else:
            print(f"  ApproachDirection:  {len(ad['uniqueValues'])} DIFFERENT values, maxDelta={ad['maxDifference']:.8f}")
            for v in ad["uniqueValues"]:
                print(f"    ({v[0]:.6f}, {v[1]:.6f}, {v[2]:.6f})")


def calc_max_diff(values: list) -> float | None:
    if not values or len(values) < 2:
        return None
    from itertools import combinations
    max_d = 0.0
    for a, b in combinations(values, 2):
        d = sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5
        if d > max_d:
            max_d = d
    return max_d


if __name__ == "__main__":
    main()

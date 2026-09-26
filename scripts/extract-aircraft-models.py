#!/usr/bin/env python3
"""
extract-aircraft-models.py — build the AC27 Editor's 3D livery-preview pack.

Reads the aircraft meshes out of the installed game's
`GroundATC_Data/resources.assets` and writes a compact per-aircraft binary
geometry pack (+ manifest.json) that the editor renders the live livery on.

Why a script instead of shipping the meshes: the geometry is the game's
copyrighted content, so it is extracted from the user's own install on demand
and cached (then deleted) by `electron/aircraftModels.js`.

Requires:  pip install UnityPy   (tested with 1.25.3)

Usage:
  python extract-aircraft-models.py --assets <.../resources.assets> --out <dir>
                                    [--planes "AIRBUS A-350-900,..."]
                                    [--debug-obj <dir>]

Output:
  <dir>/manifest.json   per-plane { bin, parts:[{name,livery,vertexCount,indexCount,bbox}] }
  <dir>/<safe>.bin      concatenated part arrays: f32 positions[3n], f32 uv[2n], u32 indices[m]

The mesh world transform is baked into the positions, so every aircraft comes
out in Unity world space (X = right/span, Y = up, Z = forward).
"""

import argparse
import json
import os
import re
import struct
import sys

try:
    import UnityPy
except ImportError:
    sys.stderr.write("UnityPy is not installed. Run: pip install UnityPy\n")
    sys.exit(3)

try:
    import numpy as np
except ImportError:
    sys.stderr.write("numpy is required (pip install numpy)\n")
    sys.exit(3)


# ---------------------------------------------------------------------------
# Per-aircraft mesh map.
#
# parts:      ordered livery panels — the SAME order/names the painter shows.
#             Each maps to a list of (meshName, groups) where groups is a
#             submesh-index list or "all".
# staticMesh: non-livery meshes/groups (engines/fans) rendered in flat grey.
#
# Derived from resources.assets (see aircraft_report.json in the research):
#  - "*_a" is the airframe and "*_b" the engine pod for the two-mesh types;
#  - the trailing submesh of A20N/A321/A359/B738/B748 is the engine fan;
#  - A388 is a=Fuselage, b=Wing, c=engine fans;
#  - B38M is the only other two-part type: `Fuselage` = body submesh 0,
#    `Wingtip` = body submesh 1 (the game's Wingtip slot binds the engine
#    material); the fan is a separate mesh.
# ---------------------------------------------------------------------------
PLANES = {
    "AIRBUS A-319ceo": {
        "parts": [{"name": "Body", "meshes": [("A319FCFM_a", "all")]}],
        "static": [("A319FCFM_b", "all")],
    },
    "AIRBUS A-319neo": {
        "parts": [{"name": "Body", "meshes": [("A19NCFM_a", "all")]}],
        "static": [("A19NCFM_b", "all")],
    },
    "AIRBUS A-320ceo": {
        "parts": [{"name": "Body", "meshes": [("A320CEO_A01_Body", "all")]}],
        "static": [],
    },
    "AIRBUS A-320neo": {
        "parts": [{"name": "Body", "meshes": [("A20N_A01_Body", [0, 1])]}],
        "static": [("A20N_A01_Body", [2])],
    },
    "AIRBUS A-321neo": {
        "parts": [{"name": "Body", "meshes": [("A321_A01_Body", [0, 1])]}],
        "static": [("A321_A01_Body", [2])],
    },
    "AIRBUS A-330-300": {
        "parts": [{"name": "Body", "meshes": [("A333_A01_Body", "all")]}],
        "static": [],
    },
    "AIRBUS A-350-900": {
        "parts": [{"name": "Body", "meshes": [("A359_A01_Body", [0, 1])]}],
        "static": [
            ("A359_A01_Body", [2]),
            ("A359_A01_Fan_High", "all"),
            ("A359_A01_Fan_Low", "all"),
        ],
    },
    "AIRBUS A-380-800": {
        "parts": [
            {"name": "Fuselage", "meshes": [("A380_a", "all")]},
            {"name": "Wing", "meshes": [("A380_b", "all")]},
        ],
        "static": [("A380_c", "all")],
    },
    "BOEING 737 MAX 8": {
        # Two livery parts: the game binds `Wingtip` to the engine material,
        # which is submesh 1 of the body mesh (submeshes: 0 = fuselage,
        # 1 = wing/engine); the fan is a separate mesh.
        "parts": [
            {"name": "Fuselage", "meshes": [("B737Max_A01_Body", [0])]},
            {"name": "Wingtip", "meshes": [("B737Max_A01_Body", [1])]},
        ],
        "static": [("B737Max_A01_Fan", "all")],
    },
    "BOEING 737-800": {
        "parts": [{"name": "Body", "meshes": [("B738_A01_Body_UVFix", [0, 1, 2])]}],
        "static": [("B738_A01_Body_UVFix", [3])],
    },
    "BOEING 747-8I": {
        "parts": [{"name": "Body", "meshes": [("B748_A01_Body", [0, 1])]}],
        "static": [
            ("B748_A01_Body", [2]),
            ("B748_A01_Fan_High", "all"),
            ("B748_A01_Fan_Low", "all"),
        ],
    },
    "BOEING 777-300ER": {
        "parts": [{"name": "Body", "meshes": [("777-300ER_a", "all")]}],
        "static": [("777-300ER_b", "all")],
    },
    "BOEING 787-9": {
        "parts": [{"name": "Body", "meshes": [("B789_a", "all")]}],
        "static": [("B789_b", "all")],
    },
    "BOMBARDIER CRJ700": {
        "parts": [{"name": "Body", "meshes": [("CRJ700_a", "all")]}],
        "static": [("CRJ700_b", "all")],
    },
    "BOMBARDIER CRJ900": {
        "parts": [{"name": "Body", "meshes": [("CRJ900_a", "all")]}],
        "static": [("CRJ900_b", "all")],
    },
    "COMAC C-919": {
        "parts": [{"name": "Body", "meshes": [("C919_a", "all")]}],
        "static": [("C919_b", "all")],
    },
    "EMBRAER E-JET 170": {
        "parts": [{"name": "Body", "meshes": [("E170M_a", "all")]}],
        "static": [("E170M_b", "all")],
    },
    "EMBRAER E-JET 190": {
        "parts": [{"name": "Body", "meshes": [("E190M_a", "all")]}],
        "static": [("E190M_b", "all")],
    },
    "GULFSTREAM 650": {
        "parts": [{"name": "Body", "meshes": [("GS650_a", "all")]}],
        "static": [("GS650_b", "all")],
    },
}


def safe_name(plane_id):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", plane_id)


# ---------------------------------------------------------------------------
# Transform math (no external deps beyond numpy)
# ---------------------------------------------------------------------------
def quat_to_matrix(x, y, z, w):
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return np.array([
        [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
        [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
        [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
    ], dtype=np.float64)


def _xyz(v):
    # UnityPy math vectors/quaternions expose .X/.Y/.Z/.W (fall back to lowercase)
    if v is None:
        return (0.0, 0.0, 0.0)
    get = lambda a, b: getattr(v, a, None) if getattr(v, a, None) is not None else getattr(v, b)
    return (float(get("X", "x")), float(get("Y", "y")), float(get("Z", "z")))


def _quat(q):
    if q is None:
        return (0.0, 0.0, 0.0, 1.0)
    get = lambda a, b: getattr(q, a, None) if getattr(q, a, None) is not None else getattr(q, b)
    return (float(get("X", "x")), float(get("Y", "y")), float(get("Z", "z")), float(get("W", "w")))


def local_matrix(tr):
    px, py, pz = _xyz(getattr(tr, "m_LocalPosition", None))
    qx, qy, qz, qw = _quat(getattr(tr, "m_LocalRotation", None))
    sx, sy, sz = _xyz(getattr(tr, "m_LocalScale", None))
    if sx == 0 and sy == 0 and sz == 0:
        sx = sy = sz = 1.0
    m = np.eye(4)
    m[:3, :3] = quat_to_matrix(qx, qy, qz, qw) @ np.diag([sx, sy, sz])
    m[:3, 3] = [px, py, pz]
    return m


def world_matrix(ptr, cache):
    """`ptr` is a PPtr<Transform> (path_id + .read()); composes the parent chain."""
    key = getattr(ptr, "path_id", None)
    if key is not None and key in cache:
        return cache[key]
    tr = ptr.read()
    m = local_matrix(tr)
    try:
        parent_ptr = getattr(tr, "m_Father", None)
        if parent_ptr and getattr(parent_ptr, "path_id", 0):
            m = world_matrix(parent_ptr, cache) @ m
    except Exception:
        pass
    if key is not None:
        cache[key] = m
    return m


# ---------------------------------------------------------------------------
# OBJ parsing (UnityPy's Mesh.export gives vertex/normal/uv/faces as text)
# ---------------------------------------------------------------------------
def parse_obj_groups(text):
    """Return list of groups: {indices:[vertexIdx], uv:[uvIdx], faces:[[(v,t),...]]}."""
    verts = []
    uvs = []
    groups = []
    cur = None
    for ln in text.splitlines():
        if ln.startswith("v "):
            p = ln.split()
            verts.append((float(p[1]), float(p[2]), float(p[3])))
        elif ln.startswith("vt "):
            p = ln.split()
            uvs.append((float(p[1]), float(p[2])))
        elif ln.startswith("g "):
            cur = {"name": ln[2:].strip(), "faces": []}
            groups.append(cur)
        elif ln.startswith("f ") and cur is not None:
            face = []
            for tok in ln.split()[1:]:
                parts = tok.split("/")
                vi = int(parts[0]) - 1
                ti = int(parts[1]) - 1 if len(parts) > 1 and parts[1] else vi
                face.append((vi, ti))
            if len(face) >= 3:
                cur["faces"].append(face)
    return verts, uvs, groups


def build_group_geometry(verts, uvs, groups, wanted):
    """Merge the wanted submesh groups into indexed arrays (local space).

    `groups` is the parsed OBJ group list, whose element 0 is the empty
    `g <meshName>` header the exporter emits before the per-submesh groups —
    so submesh `i` is OBJ group `i + 1`.
    """
    wanted = set(wanted)
    remap = {}
    positions = []
    uv_out = []
    indices = []
    for gi, g in enumerate(groups):
        if gi not in wanted:
            continue
        for face in g["faces"]:
            for (vi, ti) in face:
                key = (vi, ti)
                idx = remap.get(key)
                if idx is None:
                    idx = len(positions)
                    remap[key] = idx
                    positions.append(verts[vi])
                    uv_out.append(uvs[ti] if ti < len(uvs) else (0.0, 0.0))
                indices.append(idx)
    return np.array(positions, dtype=np.float64), np.array(uv_out, dtype=np.float64), indices


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--planes", default="")
    ap.add_argument("--debug-obj", default="")
    args = ap.parse_args()

    only = [s.strip() for s in args.planes.split(",") if s.strip()]
    os.makedirs(args.out, exist_ok=True)
    if args.debug_obj:
        os.makedirs(args.debug_obj, exist_ok=True)

    sys.stderr.write("loading %s ...\n" % args.assets)
    sys.stderr.flush()
    env = UnityPy.load(args.assets)

    # Collect the renderers + their world matrices, and the Mesh objects by name.
    meshes = {}
    renderer_by_mesh = {}
    tr_cache = {}
    for o in env.objects:
        tn = o.type.name
        if tn == "Mesh":
            try:
                d = o.read()
                meshes[str(getattr(d, "m_Name", ""))] = d
            except Exception:
                pass
        elif tn == "SkinnedMeshRenderer":
            try:
                d = o.read()
                mesh_name = d.m_Mesh.read().m_Name
                go = d.m_GameObject.read()
                renderer_by_mesh[str(mesh_name)] = world_matrix(go.m_Transform, tr_cache)
            except Exception as e:
                sys.stderr.write("renderer transform failed: %s\n" % e)

    # Keep in sync with PACK_VERSION in electron/unity/aircraftPack.js.
    manifest = {"version": 2, "planes": {}}
    wanted_planes = [p for p in PLANES if (not only or p in only)]

    for plane_id in wanted_planes:
        cfg = PLANES[plane_id]
        parts_out = []
        bin_chunks = []

        def add_part(name, livery, mesh_name, groups):
            if mesh_name not in meshes:
                return
            m = meshes[mesh_name]
            text = m.export()
            verts, uvs, groups_parsed = parse_obj_groups(text)
            # Submesh i is OBJ group i + 1 (group 0 is the `g <meshName>` header).
            sub = list(range(len(groups_parsed))) if groups == "all" else [g + 1 for g in groups]
            sub = [g for g in sub if g < len(groups_parsed)]
            pos, uvv, idx = build_group_geometry(verts, uvs, groups_parsed, sub)
            if len(pos) == 0:
                return
            M = renderer_by_mesh.get(mesh_name)
            if M is not None:
                hom = np.hstack([pos, np.ones((len(pos), 1))])
                pos = (M @ hom.T).T[:, :3]
            bbox = [float(pos[:, 0].min()), float(pos[:, 1].min()), float(pos[:, 2].min()),
                    float(pos[:, 0].max()), float(pos[:, 1].max()), float(pos[:, 2].max())]
            parts_out.append({
                "name": name, "livery": livery,
                "vertexCount": int(len(pos)), "indexCount": int(len(idx)),
                "bbox": bbox,
            })
            bin_chunks.append(pos.astype("<f4").tobytes())
            bin_chunks.append(uvv.astype("<f4").tobytes())
            bin_chunks.append(np.asarray(idx, dtype="<u4").tobytes())
            if args.debug_obj:
                with open(os.path.join(args.debug_obj, "%s_%s.obj" % (safe_name(plane_id), safe_name(name))), "w") as fh:
                    fh.write("# %s / %s\n" % (plane_id, name))
                    for p in pos:
                        fh.write("v %f %f %f\n" % (p[0], p[1], p[2]))
                    for u in uvv:
                        fh.write("vt %f %f\n" % (u[0], u[1]))
                    off = 0
                    for i, _ in enumerate(pos):
                        pass
                    # faces (triangles) reference v/vt 1:1 since we dedup per (vi,ti)
                    for t in range(0, len(idx), 3):
                        a, b, c = idx[t] + 1, idx[t + 1] + 1, idx[t + 2] + 1
                        fh.write("f %d/%d %d/%d %d/%d\n" % (a, a, b, b, c, c))

        for part in cfg["parts"]:
            for (mesh_name, groups) in part["meshes"]:
                add_part(part["name"], True, mesh_name, groups)
        for (mesh_name, groups) in cfg.get("static", []):
            add_part("_static", False, mesh_name, groups)

        if not parts_out:
            sys.stderr.write("no geometry for %s\n" % plane_id)
            continue

        fname = safe_name(plane_id) + ".bin"
        with open(os.path.join(args.out, fname), "wb") as fh:
            for chunk in bin_chunks:
                fh.write(chunk)
        manifest["planes"][plane_id] = {"bin": fname, "parts": parts_out}
        sys.stderr.write("  %-22s %d part(s), %d KB\n" % (
            plane_id, len(parts_out), sum(len(c) for c in bin_chunks) // 1024))
        sys.stderr.flush()

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    sys.stderr.write("wrote %d plane(s) to %s\n" % (len(manifest["planes"]), args.out))


if __name__ == "__main__":
    main()

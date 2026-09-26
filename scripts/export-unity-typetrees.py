#!/usr/bin/env python3
"""Dev-time helper: export the Unity type-tree node lists for the handful of
classes the pure-JS asset reader needs, as a compact JSON file.

The AC27 build strips type trees from its serialized files, so the JS reader
falls back to this schema (the same release type trees UnityPy ships in its TPK
package / AssetRipper's TypeTreeDumps). Regenerate when targeting a new Unity
version.

Usage:  python scripts/export-unity-typetrees.py --version 6000.3.12f1 \
          --out electron/unity/typetrees.json
"""

import argparse
import json
import sys

from UnityPy.helpers.Tpk import get_typetree_node
from UnityPy.helpers.UnityVersion import UnityVersion

# ClassIDType → name (only the classes the aircraft extractor touches).
CLASSES = {
    1: "GameObject",
    4: "Transform",
    21: "Material",
    23: "MeshRenderer",
    33: "MeshFilter",
    43: "Mesh",
    137: "SkinnedMeshRenderer",
}


def flatten(node):
    """Flat, pre-order DFS node list (matches get_typetree_node's build order)."""
    out = []
    stack = [node]
    while stack:
        n = stack.pop()
        out.append({
            "level": n.m_Level,
            "type": n.m_Type,
            "name": n.m_Name,
            "byteSize": n.m_ByteSize,
            "version": n.m_Version,
            "metaFlag": n.m_MetaFlag,
            "typeFlags": n.m_TypeFlags,
        })
        for child in reversed(n.m_Children):
            stack.append(child)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    uv = UnityVersion.from_str(args.version)
    out = {"unityVersion": args.version, "classes": {}}
    for cid, name in CLASSES.items():
        try:
            node = get_typetree_node(cid, uv)
        except Exception as err:  # noqa: BLE001
            sys.stderr.write("skip %s (%d): %s\n" % (name, cid, err))
            continue
        out["classes"][str(cid)] = {"name": name, "nodes": flatten(node)}
        sys.stderr.write("%-20s %d nodes\n" % (name, len(out["classes"][str(cid)]["nodes"])))

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    sys.stderr.write("wrote %s\n" % args.out)


if __name__ == "__main__":
    main()

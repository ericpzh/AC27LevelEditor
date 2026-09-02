/**
 * Runway entrance/exit access for a taxiway segment (Ground Painter).
 *
 * A "physical runway" is drawn not only as a `runway:*` pair but also as a set of
 * `taxiway-segment` pavement strips whose `name` equals the runway's physical name
 * (ZSJN pattern: runway `01/19` ↔ a strip chain named `"01/19"` running the full
 * runway length). `meta.runwayPavement[rwIdx]` was computed at LOAD as that chain's
 * graph-node list, but it is a SNAPSHOT: when a taxiway is drawn onto the interior
 * of a pavement strip, the strip is split at the junction and a NEW node is created.
 * That node is absent from the snapshot, so a physical-connection test that reads
 * only `meta.runwayPavement` would miss the very connection the user just drew.
 *
 * Therefore the connection test derives the pavement node set from the LIVE graph:
 * any current segment whose `name` === the runway's physical name is a pavement
 * strip, and splitting preserves that name on both pieces (see the TOOL_LINE
 * auto-slice and `runwayPavement()`'s live fallback). `meta` is only a fallback
 * when the live name-match yields nothing.
 *
 * The runner MUST list only the runway(s) a taxiway is PHYSICALLY connected to:
 * the taxiway shares at least one graph node with a runway's pavement-strip chain.
 * A name match against an existing entry/exit is NOT a physical connection, so it
 * must not surface an unrelated runway (or a stale leftover entry) the taxiway
 * isn't actually joined to.
 */

// Taxiway-segment `Flags` bitmask for a runway's coupled pavement strip (4 =
// special; the same value the game uses for runway pavement). See GroundPainter.jsx.
export const RUNWAY_PAVEMENT_FLAGS = 4;

/**
 * The graph-node index set of runway `rwIdx`'s coupled pavement-strip chain.
 *
 * Prefers the LIVE graph: segments whose `name` === the runway's physical name
 * (split pieces preserve the name, so this includes any junction node created when
 * a taxiway was drawn onto the pavement). Falls back to the load-time
 * `meta.runwayPavement[rwIdx]` snapshot only when the live match is empty.
 */
export function getRunwayPavementNodes(graph, meta, rwIdx) {
  if (!graph || !graph.runways || !graph.runways[rwIdx]) return [];
  const phys = graph.runways[rwIdx].physicalName;
  if (!phys) return (meta && meta.runwayPavement && meta.runwayPavement[rwIdx]) || [];
  const seen = new Set();
  const live = [];
  for (const s of graph.segments || []) {
    if (s.name !== phys) continue;
    for (const ni of (s.nodeIdxs || [s.aIdx, s.bIdx])) {
      if (ni == null || seen.has(ni)) continue;
      seen.add(ni);
      live.push(ni);
    }
  }
  if (live.length) return live;
  return (meta && meta.runwayPavement && meta.runwayPavement[rwIdx]) || [];
}

/**
 * Whether a taxiway segment is eligible to configure runway entrance/exit.
 *
 * The ONLY criteria are (a) the segment is not itself a runway pavement strip,
 * and (b) it shares at least one node with ANY runway's coupled pavement-strip
 * chain (a physical connection). The segment name is deliberately NOT a gate:
 * a freshly-drawn taxiway is created without a name (see the TOOL_LINE commit in
 * GroundPainter.jsx), yet a taxiway joined to the runway's pavement should still
 * surface its entrance/exit panel so the user can see the connection and then
 * name it. Toggling still requires a name (enforced in `toggleRunwayAccess`).
 */
export function isSegmentEligibleForRunwayAccess(graph, meta, segIdx) {
  if (!graph || !graph.segments[segIdx]) return false;
  const seg = graph.segments[segIdx];
  if (!seg || seg.flags === RUNWAY_PAVEMENT_FLAGS) return false;
  const pavSet = new Set();
  for (let r = 0; r < (graph.runways || []).length; r++) {
    for (const ni of getRunwayPavementNodes(graph, meta, r)) pavSet.add(ni);
  }
  if (pavSet.size === 0) return false;
  const segNodes = seg.nodeIdxs || [seg.aIdx, seg.bIdx];
  for (const ni of segNodes) if (pavSet.has(ni)) return true;
  return false;
}

/**
 * List the runway directions (per physical runway + directional name) this taxiway
 * is PHYSICALLY connected to, with the current entrance/exit checked-state. A runway
 * is only included when the taxiway shares at least one node with that runway's
 * coupled pavement-strip chain.
 */
export function getSegmentRunwayAccess(graph, meta, segIdx) {
  if (!graph || !graph.segments[segIdx]) return [];
  const seg = graph.segments[segIdx];
  const segName = seg.name || '';
  const segNodes = seg.nodeIdxs || [seg.aIdx, seg.bIdx];
  const segNodesSet = new Set(segNodes);
  const out = [];
  for (let pIdx = 0; pIdx < (graph.runways || []).length; pIdx++) {
    const rw = graph.runways[pIdx];
    // PHYSICAL connection only: share a node with THIS runway's pavement chain.
    const pavSet = new Set(getRunwayPavementNodes(graph, meta, pIdx));
    let connectedToThisRunway = false;
    for (const ni of segNodes) if (pavSet.has(ni)) { connectedToThisRunway = true; break; }
    if (!connectedToThisRunway) continue;
    for (const dirName of rw.names || []) {
      let entrance = (rw.entries || []).some((e) => e.name === segName && e.runwayName === dirName);
      let exit = (rw.exits || []).some((e) => e.name === segName && e.runwayName === dirName);
      if (!segName) {
        for (const en of rw.entries || []) if (en.runwayName === dirName && (segNodesSet.has(en.holdingIdx) || segNodesSet.has(en.defineIdx) || segNodesSet.has(en.lineUpIdx))) entrance = true;
        for (const ex of rw.exits || []) if (ex.runwayName === dirName && (segNodesSet.has(ex.exitIdx) || segNodesSet.has(ex.holdingIdx) || segNodesSet.has(ex.defineIdx))) exit = true;
      }
      out.push({ physIdx: pIdx, physName: rw.physicalName, dirName, entrance, exit });
    }
  }
  return out;
}

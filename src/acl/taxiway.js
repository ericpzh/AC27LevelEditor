/**
 * Taxiway path parser — extracts taxiway centerline segments from the v4
 * PKStaticEntities index (taxiway-segment:* entries).
 *
 * Each entry's Nodes.$rcontent holds $irefs of TaxiwayNode endpoints forming a
 * single line segment, plus an optional Name for the taxiway segment.
 *
 * Stand-access segments (nodes touching stand positions) are marked with
 * isStandAccess: true so the renderer can style them differently.
 */

// ─── Main parser ────────────────────────────────────────────────

/**
 * Parse taxiway centerline segments from PKStaticEntities taxiway-segment:* entries.
 *
 * Each entry contains:
 *   Name:   string (may be empty)
 *   Nodes:  { $rcontent: [$iref, $iref] }
 *   Flags:  integer (1=standard, 2=wider, 4=special)
 *
 * Stand-access segments (touching stand-position nodes) are marked with
 * isStandAccess: true for differentiated rendering (thicker lines).
 *
 * @param {string} aclText - raw ACL file content
 * @returns {{ paths: Array<{ name: string, flags: number, isStandAccess?: boolean, points: Array<{x: number, z: number}> }> }}
 */
function parseTaxiwayPaths(aclText) {
  const paths = [];

  // v4: iterate taxiway-segment:* entries from PKStaticEntities
  const { buildPkIndex, getPkEntriesByType, resolveIref, extractVector3FromV4, extractStringFromV4, extractIrefArray, extractIntFromV4, extractSingleIref } = require('./v4_pk_index');
  const pkIndex = buildPkIndex(aclText);

  // Build set of stand-associated node $ids for marking stand-access segments
  const standNodeIds = new Set();
  const stands = getPkEntriesByType(pkIndex, 'stand');
  for (const st of stands) {
    // TailPosition and NosePosition are $iref references — structural, no regex
    const tailIref = extractSingleIref(st.block, 'TailPosition');
    const noseIref = extractSingleIref(st.block, 'NosePosition');
    if (tailIref !== null) standNodeIds.add(tailIref);
    if (noseIref !== null) standNodeIds.add(noseIref);
  }

  // Iterate taxiway segments
  const segments = getPkEntriesByType(pkIndex, 'taxiway-segment');
  for (const seg of segments) {
    const name = extractStringFromV4(seg.block, 'Name') || '';
    const flags = extractIntFromV4(seg.block, 'Flags') || 1;
    const nodeIrefs = extractIrefArray(seg.block, 'Nodes');

    if (nodeIrefs.length >= 2) {
      const segPoints = [];
      for (const iref of nodeIrefs) {
        const resolved = resolveIref(pkIndex, iref);
        if (resolved) {
          const pos = extractVector3FromV4(resolved.block);
          if (pos) segPoints.push({ x: pos.x, z: pos.z });
        }
      }
      if (segPoints.length >= 2) {
        const isStandAccess = nodeIrefs.some(id => standNodeIds.has(id));
        paths.push({ name, flags, points: segPoints, ...(isStandAccess && { isStandAccess: true }) });
      }
    }
  }

  return { paths };
}

module.exports = { parseTaxiwayPaths };

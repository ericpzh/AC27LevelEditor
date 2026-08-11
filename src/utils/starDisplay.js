// ─── STAR display dedup ─────────────────────────────────────────
// Some airports name each runway-specific STAR variant separately by
// appending a runway suffix, e.g. ZGSZ: "SAREX4.34L", "SAREX4.34R",
// "SAREX4.33", "SAREX4.16L", … — all mostly the same STAR base path.
// These helpers group them under a single base STAR name for map
// rendering/labels WITHOUT touching the underlying per-runway cache
// keys (which the aircraft-STAR lookup and game save flow depend on).

/**
 * Strip a trailing runway suffix from a STAR name.
 * Matches patterns like ".15", ".33", ".34L", ".34R", ".16L".
 * Only strips when the suffix is a genuine runway designator so plain
 * STAR names (e.g. "ABTU6W", "WFG91A") are left untouched.
 * @param {string} name
 * @returns {string}
 */
export function stripStarRunwaySuffix(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/\.\d{1,2}[LRC]?$/i, '');
}

/**
 * Test whether a STAR name carries a runway suffix.
 * @param {string} name
 * @returns {boolean}
 */
export function hasStarRunwaySuffix(name) {
  return typeof name === 'string' && /\.\d{1,2}[LRC]?$/i.test(name);
}

/**
 * Group a starPaths object ({ starName: [{runway, points}] }) for display.
 * Entries whose suffixed names share the same base STAR name are merged
 * into one display group containing:
 *   - groupName  : base STAR name (used for the label)
 *   - runways    : all runways the base STAR serves
 *   - points     : the longest variant's path (representative full route)
 * The returned object maps baseName → [single group entry] so it is
 * consumable by renderRoutePaths/renderRouteLabels.
 *
 * Groups WITHOUT runway suffixes (e.g. ZSJN "ABTU6W" / "WFG91A") are
 * returned unchanged, keeping their per-runway variants untouched.
 *
 * @param {Object<string, Array<{runway:string, points:Array}>>} starPaths
 * @returns {Object<string, Array<{name:string, runways:string[], points:Array}>>}
 */
export function dedupeStarPathsForDisplay(starPaths) {
  if (!starPaths) return {};
  const groups = new Map();

  for (const [name, variants] of Object.entries(starPaths)) {
    const base = stripStarRunwaySuffix(name);
    let group = groups.get(base);
    if (!group) {
      group = { name: base, suffixed: false, variants: [] };
      groups.set(base, group);
    }
    if (hasStarRunwaySuffix(name)) group.suffixed = true;
    group.variants.push(...(variants || []));
  }

  const out = {};
  for (const { name, suffixed, variants } of groups.values()) {
    if (variants.length === 0) continue;
    // Non-suffixed groups are real distinct STARs (e.g. "ABTU6W", "WFG91A");
    // preserve their original per-runway variants — no dedup.
    if (!suffixed) {
      out[name] = variants.map((v) => ({ ...v }));
      continue;
    }
    // Merge suffixed group (ZGSZ-style, e.g. SAREX4.34L/34R/33/…): one
    // representative route (longest variant) + all runways the base serves.
    let best = null;
    const runways = new Set();
    for (const v of variants) {
      if (v.runway) runways.add(v.runway);
      const pts = v.points || [];
      if (pts.length >= 2 && (!best || pts.length > best.points.length)) {
        best = { points: pts, runway: v.runway };
      }
    }
    if (!best) continue;
    out[name] = [{
      name,
      runways: [...runways],
      points: best.points,
    }];
  }
  return out;
}

/**
 * Filter a display-deduped starPaths object by active runways.
 * Keeps a group when any of its runways is active. Handles both merged
 * entries (carrying `runways` array) and preserved per-runway variants
 * (carrying a singular `runway`).
 * @param {Object<string, Array<{runways?:string[], runway?:string, points:Array}>>} pathsObj
 * @param {Set<string>} activeRunways
 * @returns {Object<string, Array>}
 */
export function filterDedupedStarPathsByRunway(pathsObj, activeRunways) {
  if (!pathsObj || !activeRunways) return pathsObj;
  const out = {};
  for (const [name, variants] of Object.entries(pathsObj)) {
    const kept = (variants || []).filter((v) => {
      if (v.runways && v.runways.length > 0) {
        return v.runways.some((r) => activeRunways.has(r));
      }
      return v.runway && activeRunways.has(v.runway);
    });
    if (kept.length > 0) out[name] = kept;
  }
  return out;
}
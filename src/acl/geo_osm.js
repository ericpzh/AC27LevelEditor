/**
 * geo_osm.js — sync the editor's taxiway geometry into the airport's `geo_data.osm`.
 *
 * The game renders the airport ground from `geo_data.osm` (the file the level
 * `Config.geoDataFile` points at), NOT from the ACL's `PKStaticEntities`. The
 * Ground Painter only writes the `.acl`, so painter-created taxiways never reach
 * the file the game actually renders. This module bridges that gap: given the
 * decoded ACL text it reconciles `geo_data.osm`'s taxiway nodes + `aeroway=taxiway`
 * ways to match — adding missing ones and replacing (in place) the ones whose
 * coordinates/order changed — while preserving every other OSM element
 * byte-for-byte. It is a *surgical* edit: it never re-serializes the document, so
 * block-form nodes, relations, ordering and formatting are untouched.
 *
 * Coordinate model: ACL taxiway nodes carry `OsmId` = geo_data node id, and a
 * `ReactivePosition` (x, z in game units). geo_data nodes carry (lat, lon). The
 * transform is LINEAR (translate + two scale terms), fit exactly from the ACL
 * nodes that already exist in geo_data.osm: lat = a + b·z, lon = c + d·x.
 */

const { buildPkIndex, getPkEntriesByType, extractIrefArray, extractIntFromV4, extractVector3FromV4 } = require('./v4_pk_index');
const fs = require('fs');
const path = require('path');

/** Derive the airport's geo_data.osm path from a level ACL file path + its Config. */
function deriveGeoDataPath(aclText, aclFilePath) {
  const m = aclText.match(/"geoDataFile":\s*"([^"]+)"/);
  const base = m ? m[1] : 'geo_data';
  const levelDir = path.dirname(aclFilePath);
  const airportDir = path.dirname(levelDir); // <Airports>/<ICAO>/Levels -> <Airports>/<ICAO>
  return path.join(airportDir, base + '.osm');
}

// ─── ACL → taxiway model ─────────────────────────────────────────

function buildTaxiwayModel(aclText) {
  const idx = buildPkIndex(aclText);
  const nodes = new Map();
  const osmByIref = new Map();
  for (const n of getPkEntriesByType(idx, 'taxiway-node')) {
    const osm = extractIntFromV4(n.block, 'OsmId');
    const p = extractVector3FromV4(n.block);
    if (osm != null && p) {
      nodes.set(osm, { x: p.x, z: p.z });
      if (n.id != null) osmByIref.set(n.id, osm);
    }
  }
  const segments = [];
  for (const s of getPkEntriesByType(idx, 'taxiway-segment')) {
    const osm = extractIntFromV4(s.block, 'OsmId');
    if (osm == null) continue;
    const irefs = extractIrefArray(s.block, 'Nodes');
    const nodeOsms = irefs.map((ir) => osmByIref.get(ir)).filter((o) => o != null);
    if (nodeOsms.length >= 2) segments.push({ osm, nodeOsms });
  }
  return { nodes, segments };
}

// ─── geo_data.osm parse (read-only: self-closing nodes + ways) ───

/** @returns {{ nodes: Map<id,{lat,lon,raw}>, ways: Map<id,{raw,refs,tags}> }} */
function parseGeoOsm(xml) {
  const nodes = new Map();
  const ways = new Map();
  let m;

  // Self-closing content node: <node id='X' ... lat='..' lon='..' />
  const reNode = /<node\s+id='(-?\d+)'[^>]*?\/>/g;
  while ((m = reNode.exec(xml)) !== null) {
    const lat = parseFloat(m[0].match(/lat='([-\d.eE+]+)'/)?.[1]);
    const lon = parseFloat(m[0].match(/lon='([-\d.eE+]+)'/)?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      nodes.set(parseInt(m[1], 10), { lat, lon, raw: m[0] });
    }
  }

  const reWay = /<way\s+id='(-?\d+)'[^>]*>([\s\S]*?)<\/way>/g;
  while ((m = reWay.exec(xml)) !== null) {
    const body = m[2];
    const refs = [...body.matchAll(/<nd ref='(-?\d+)'/g)].map((x) => parseInt(x[1], 10));
    const tags = {};
    for (const t of body.matchAll(/<tag k='([^']+)' v='([^']+)' \/>/g)) tags[t[1]] = t[2];
    ways.set(parseInt(m[1], 10), { raw: m[0], refs, tags });
  }
  return { nodes, ways };
}

function nodeXml(id, lat, lon) {
  return `<node id='${id}' action='modify' visible='true' lat='${lat.toFixed(10)}' lon='${lon.toFixed(10)}' />`;
}

function wayXml(id, nodeOsms) {
  const nds = nodeOsms.map((o) => `      <nd ref='${o}' />`).join('\n');
  return `<way id='${id}' action='modify' visible='true'>\n${nds}\n      <tag k='aeroway' v='taxiway' />\n  </way>`;
}

// ─── transform fit ───────────────────────────────────────────────

function fitTransform(aclNodes, geoNodes) {
  const pts = [];
  for (const [id, g] of geoNodes) {
    const p = aclNodes.get(id);
    if (p && Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      pts.push({ x: p.x, z: p.z, lat: g.lat, lon: g.lon });
    }
  }
  if (pts.length < 3) return null;
  function fit(ys, xs) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, n = pts.length;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
    const denom = n * sxx - sx * sx;
    const b = Math.abs(denom) > 1e-12 ? (n * sxy - sx * sy) / denom : 0;
    const a = (sy - b * sx) / n;
    let err = 0;
    for (let i = 0; i < n; i++) { const pred = a + b * xs[i]; err += Math.abs(pred - ys[i]); }
    return { a, b, err: err / n };
  }
  const latF = fit(pts.map((p) => p.lat), pts.map((p) => p.z));
  const lonF = fit(pts.map((p) => p.lon), pts.map((p) => p.x));
  // Reject a bad fit (should never be linear with >1e-5 deg residual if the model holds).
  if (!Number.isFinite(latF.a) || !Number.isFinite(lonF.a)) return null;
  return { a: latF.a, b: latF.b, c: lonF.a, d: lonF.b };
}

function toLatLon(t, x, z) { return { lat: t.a + t.b * z, lon: t.c + t.d * x }; }

// ─── sync (surgical) ─────────────────────────────────────────────

/**
 * Reconcile geo_data.osm to include the ACL's taxiway geometry.
 *
 * Two-phase reconcile (supports OSM-ID reuse):
 *  1. Nodes: for each ACL taxiway node, if the geo node exists, UPDATE its
 *     lat/lon to the re-projected position (moved taxiways / reused OSM IDs);
 *     else APPEND a new node.
 *  2. Ways: for each ACL taxiway segment, if the way exists, REPLACE its
 *     <nd> refs and ensure aeroway=taxiway tag; else APPEND.
 * Preserves every other OSM element byte-for-byte.
 * @returns {{xml:string, transform, addedNodes:number, addedWays:number, updatedNodes:number, updatedWays:number}}
 */
function syncGeoData(aclText, geoXml) {
  const model = buildTaxiwayModel(aclText);
  const geo = parseGeoOsm(geoXml);
  const t = fitTransform(model.nodes, geo.nodes);
  if (!t) throw new Error('[geo_osm] could not fit lat/lon transform (need >=3 linear ACL↔geo node pairs)');

  let out = geoXml;
  let addedNodes = 0, addedWays = 0, updatedNodes = 0, updatedWays = 0;
  const appends = [];

  // ── Nodes: add or update ──────────────────────────────────────────
  // Check existence on raw XML (covers block-form nodes too).
  // For existing nodes, surgical in-place lat/lon replacement if moved.
  for (const [osm, p] of model.nodes) {
    const ll = toLatLon(t, p.x, p.z);
    const existing = geo.nodes.get(osm);
    // Also check raw XML for block-form nodes not in parsed map (defensive)
    const rawHas = new RegExp(`<node[^>]*id='${osm}'`).test(out);
    if (!rawHas && !existing) {
      appends.push(nodeXml(osm, ll.lat, ll.lon));
      addedNodes++;
      continue;
    }
    if (existing) {
      // Update if moved beyond ~1e-7 deg (~1cm)
      if (Math.abs(existing.lat - ll.lat) > 1e-7 || Math.abs(existing.lon - ll.lon) > 1e-7) {
        const newNodeStr = nodeXml(osm, ll.lat, ll.lon);
        // Replace the existing node element (self-closing) in place.
        const re = new RegExp(`<node\\s+id='${osm}'[^>]*?\\/>`, 'g');
        out = out.replace(re, newNodeStr);
        updatedNodes++;
      }
      continue;
    }
    // Block-form node exists but not parsed (has children) — leave untouched
    // per original comment: positive "import" nodes differ, don't corrupt.
  }

  // ── Ways: add or replace ──────────────────────────────────────────
  for (const seg of model.segments) {
    const hasWay = new RegExp(`<way[^>]*id='${seg.osm}'`).test(out);
    const newWayStr = wayXml(seg.osm, seg.nodeOsms);
    if (!hasWay) {
      appends.push(newWayStr);
      addedWays++;
      continue;
    }
    const existing = geo.ways.get(seg.osm);
    if (existing) {
      const sameRefs = existing.refs.length === seg.nodeOsms.length &&
        existing.refs.every((v, i) => v === seg.nodeOsms[i]);
      const isTaxiway = existing.tags && existing.tags.aeroway === 'taxiway';
      if (!sameRefs || !isTaxiway) {
        const re = new RegExp(`<way\\s+id='${seg.osm}'[^>]*>[\\s\\S]*?<\\/way>`, 'g');
        out = out.replace(re, newWayStr);
        updatedWays++;
      }
    } else {
      // Block-form way not parsed? Replace via regex fallback
      const re = new RegExp(`<way\\s+id='${seg.osm}'[^>]*>[\\s\\S]*?<\\/way>`, 'g');
      if (re.test(out)) {
        out = out.replace(re, newWayStr);
        updatedWays++;
      } else {
        appends.push(newWayStr);
        addedWays++;
      }
    }
  }

  if (appends.length > 0) {
    const idx = out.lastIndexOf('</osm>');
    out = out.slice(0, idx) + appends.map((s) => '  ' + s).join('\n') + '\n' + out.slice(idx);
  }

  return { xml: out, transform: t, addedNodes, addedWays, updatedNodes, updatedWays };
}

/**
 * Sync a level's `geo_data.osm` from the decoded ACL text, deriving the data file
 * path from the level ACL path + its Config.geoDataFile. Backs up the existing
 * geo_data.osm to `<name>.bak` before writing (overwrite), mirroring the ACL save.
 * @param {string} aclText - decoded ACL text
 * @param {string} aclFilePath - absolute path to the level's .acl
 * @param {{createBackup?: boolean}} [opts]
 * @returns {{ok:boolean, geoPath:string, addedNodes?:number, addedWays?:number, skipReason?:string, error?:string}}
 */
function syncGeoDataForLevel(aclText, aclFilePath, opts = {}) {
  const geoPath = deriveGeoDataPath(aclText, aclFilePath);
  if (!fs.existsSync(geoPath)) {
    return { ok: false, geoPath, skipReason: 'no geo_data.osm at ' + geoPath };
  }
  try {
    const geoXml = fs.readFileSync(geoPath, 'utf8');
    const res = syncGeoData(aclText, geoXml);
    if (opts.createBackup !== false) fs.copyFileSync(geoPath, geoPath + '.bak');
    fs.writeFileSync(geoPath, res.xml, 'utf8');
    return { ok: true, geoPath, addedNodes: res.addedNodes, addedWays: res.addedWays, updatedNodes: res.updatedNodes, updatedWays: res.updatedWays };
  } catch (e) {
    return { ok: false, geoPath, error: e.message || String(e) };
  }
}

module.exports = { buildTaxiwayModel, parseGeoOsm, syncGeoData, syncGeoDataForLevel, deriveGeoDataPath };

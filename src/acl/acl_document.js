/**
 * ACL Document Model.
 *
 * Wraps a .acl file's text content and provides:
 *   - Section indexing (one O(n) pass at construction)
 *   - Lazy parsing with the pre-processor + JSON.parse
 *   - Mutation tracking (only modified sections are re-serialized)
 *   - Verbatin pass-through of unmodified sections
 *
 * This is the single source of truth for ACL file content during a
 * load→edit→save cycle, eliminating the 5 file re-reads per save.
 */

const { createTokenizer } = require('./tokenizer');
const { preprocessUnityJson, serializeUnityJson } = require('./acl_json');

// Known top-level section names in ACL files
const TOP_LEVEL_SECTIONS = [
  'SceneryData',
  'WorldState',
  'GameTime',
  'Config',
  'Channels',
  'WeatherFrames',
  'WindFrames',
  'RunwayTimeline',
  'Jetways',
];

// Sub-sections within WorldState
const WORLD_STATE_SUB = [
  'Aircrafts',
  'AircraftAnimators',
  'FlightPlans',
];

class AclDocument {
  /**
   * @param {string} rawText - Full .acl file content
   */
  constructor(rawText) {
    this._rawText = rawText;
    this._tokenizer = createTokenizer(rawText);

    /** @type {Map<string, {keyStart: number, valueStart: number, valueEnd: number, text: string, object: object|null, _customText: string|null}>} */
    this._sections = new Map();

    /** @type {Set<string>} Names of modified sections */
    this._modified = new Set();

    /** @type {Map<number,string>|null} Lazy type map */
    this._typeMap = null;

    this._indexSections();
  }

  // ── Section Indexing ────────────────────────────────────────────

  _indexSections() {
    // Index top-level sections
    for (const name of TOP_LEVEL_SECTIONS) {
      const range = this._tokenizer.findSection(name);
      if (range) {
        this._sections.set(name, {
          keyStart: range.keyStart,
          valueStart: range.valueStart,
          valueEnd: range.valueEnd,
          text: this._rawText.substring(range.valueStart, range.valueEnd),
          object: null,
          _customText: null,
        });
      }
    }

    // Index WorldState sub-sections
    const ws = this._sections.get('WorldState');
    if (ws) {
      const wsText = ws.text;
      const wsTokenizer = createTokenizer(wsText);

      for (const name of WORLD_STATE_SUB) {
        const range = wsTokenizer.findSection(name);
        if (range) {
          this._sections.set(name, {
            keyStart: ws.valueStart + range.keyStart,
            valueStart: ws.valueStart + range.valueStart,
            valueEnd: ws.valueStart + range.valueEnd,
            text: wsText.substring(range.valueStart, range.valueEnd),
            object: null,
            _customText: null,
          });
        }
      }
    }
  }

  // ── Section Access (Lazy Parsing) ───────────────────────────────

  /**
   * Get a parsed JavaScript object for a section.
   * Uses pre-processor + JSON.parse on first access.
   * Returns null if the section doesn't exist or can't be parsed.
   */
  getSection(name) {
    const sec = this._sections.get(name);
    if (!sec) return null;

    if (sec.object === null && sec._customText === null) {
      try {
        const cleaned = preprocessUnityJson(sec.text);
        sec.object = JSON.parse(cleaned);
      } catch (e) {
        console.warn('[AclDocument] Failed to parse section "' + name + '":', e.message);
        return null;
      }
    }
    return sec.object;
  }

  /**
   * Get raw text for a section (no parse overhead).
   * Useful for sections with non-standard format that we don't need to parse.
   */
  getSectionRaw(name) {
    const sec = this._sections.get(name);
    return sec ? sec.text : null;
  }

  /**
   * Get the byte range of a section's value in the original text.
   */
  getSectionRange(name) {
    const sec = this._sections.get(name);
    if (!sec) return null;
    return { start: sec.valueStart, end: sec.valueEnd };
  }

  /**
   * Check if a section exists in the document.
   */
  hasSection(name) {
    return this._sections.has(name);
  }

  /**
   * Get all indexed section names.
   */
  getSectionNames() {
    return [...this._sections.keys()];
  }

  // ── Section Mutation ─────────────────────────────────────────────

  /**
   * Replace a section with a new JS object. The section will be
   * re-serialized via serializeUnityJson() on toAclString().
   */
  setSection(name, newObject) {
    const sec = this._sections.get(name);
    if (!sec) {
      throw new Error('Section "' + name + '" not found. Available: ' + this.getSectionNames().join(', '));
    }
    sec.object = newObject;
    sec._customText = null;
    this._modified.add(name);
  }

  /**
   * Directly replace a section's text (bypasses serialization).
   * Use for sections generated from scratch (e.g., Aircrafts strings
   * built by approach.js).
   */
  setSectionRaw(name, newText) {
    const sec = this._sections.get(name);
    if (!sec) {
      throw new Error('Section "' + name + '" not found. Available: ' + this.getSectionNames().join(', '));
    }
    sec.object = null;
    sec._customText = newText;
    this._modified.add(name);
  }

  /**
   * Check if a section has been modified.
   */
  isModified(name) {
    return this._modified.has(name);
  }

  // ── Typed Accessors ─────────────────────────────────────────────

  /**
   * Get the parsed Config section as a plain object.
   * Fields: startTime, endTime, flightScheduleFile, runwayTimelineFile
   */
  getConfig() {
    const cfg = this.getSection('Config');
    if (!cfg) return null;
    return {
      startTime: cfg.startTime || '',
      endTime: cfg.endTime || '',
      flightScheduleFile: cfg.flightScheduleFile || '',
      runwayTimelineFile: cfg.runwayTimelineFile || '',
    };
  }

  /**
   * Get GameTime data.
   * Returns { ticks, secSinceMidnight, timeString } or null.
   */
  getGameTime() {
    const gt = this.getSection('GameTime');
    if (!gt) return null;

    // CurrentDateTime is a typed-value object: { $type: 3, __v: ["ticks"] }
    const cdt = gt.CurrentDateTime;
    if (!cdt) return null;

    let ticks;
    if (cdt.__v && cdt.__v.length > 0) {
      ticks = BigInt(cdt.__v[0]);
    } else if (typeof cdt === 'object') {
      // Might be already parsed differently
      ticks = BigInt(cdt.__v ? cdt.__v[0] : '0');
    }

    const TICKS_PER_SECOND = 10000000n;
    const TICKS_PER_DAY = 864000000000n;
    const NET_EPOCH_OFFSET = 621355968000000000n;

    const sec = Number((ticks - NET_EPOCH_OFFSET) / TICKS_PER_SECOND);
    const secSinceMidnight = ((sec % 86400) + 86400) % 86400;
    const h = Math.floor(secSinceMidnight / 3600);
    const m = Math.floor((secSinceMidnight % 3600) / 60);
    const s = secSinceMidnight % 60;
    const timeString = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');

    return { ticks, secSinceMidnight, timeString };
  }

  /**
   * Get FlightPlan entries as raw $k/$v objects.
   * Returns array of { k: string, v: object }.
   */
  getFlightPlanEntries() {
    const fp = this.getSection('FlightPlans');
    if (!fp) return null;

    // FlightPlans structure: { $type, $rcontent: [ { $k: "guid", $v: {...} }, ... ], $rlength: N }
    const rcontent = fp.$rcontent;
    if (!Array.isArray(rcontent)) return null;

    return rcontent.map(entry => ({
      k: entry.$k || '',
      v: entry.$v || null,
    }));
  }

  /**
   * Get the full type map from the document.
   * Scans for all "$type": "N|..." declarations.
   */
  getTypeMap() {
    if (this._typeMap !== null) return this._typeMap;

    this._typeMap = new Map();
    const re = /"\$type":\s*"(\d+)\|([^"]+)"/g;
    let m;
    while ((m = re.exec(this._rawText)) !== null) {
      const num = parseInt(m[1], 10);
      if (!this._typeMap.has(num)) {
        this._typeMap.set(num, m[2]);
      }
    }
    return this._typeMap;
  }

  // ── Serialization ───────────────────────────────────────────────

  /**
   * Serialize the document back to ACL text.
   *
   * Modified sections are re-serialized from their objects (or custom text).
   * Unmodified sections pass through verbatim from the original text.
   *
   * @returns {string} Full ACL file content
   */
  toAclString() {
    if (this._modified.size === 0) {
      return this._rawText;
    }

    // Process in reverse order to avoid invalidating start/end positions
    const sorted = [...this._modified]
      .map(name => {
        const sec = this._sections.get(name);
        return { name, ...sec };
      })
      .filter(s => s.valueStart !== undefined)
      .sort((a, b) => b.valueStart - a.valueStart);

    let result = this._rawText;

    for (const { name, valueStart, valueEnd, object, _customText } of sorted) {
      let newText;
      if (_customText !== null) {
        newText = _customText;
      } else if (object !== null) {
        newText = serializeUnityJson(object);
      } else {
        // Nothing to serialize — keep original
        continue;
      }

      result = result.substring(0, valueStart) + newText + result.substring(valueEnd);

      // Update internal positions
      const delta = newText.length - (valueEnd - valueStart);
      this._sections.get(name).text = newText;
      this._sections.get(name).valueEnd = valueStart + newText.length;

      // Shift any sections that come after this one
      for (const [otherName, otherSec] of this._sections) {
        if (otherName === name) continue;
        if (otherSec.valueStart > valueEnd) {
          otherSec.valueStart += delta;
          otherSec.valueEnd += delta;
          otherSec.keyStart += delta;
        }
      }
    }

    this._rawText = result;
    this._modified.clear();
    this._tokenizer = createTokenizer(result);

    return result;
  }

  /**
   * Get the current raw text (original or after modifications).
   */
  getRawText() {
    return this._rawText;
  }
}

module.exports = { AclDocument };

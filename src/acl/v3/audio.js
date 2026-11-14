'use strict';

/**
 * GATCARC4 v3 audio metadata loader & callsign/voice lookup (`src/acl/v3/audio.js`).
 *
 * Reads the v3 audio assets under `GroundATC_Data/StreamingAssets`:
 *   - `Voices/voice_catalog.json`
 *   - `radio_clip_durations.json`
 *   - `Airports/<ICAO>/radio_channel_config.json`
 *
 * Caches shared catalog and clip-duration indexes per game root (keyed by
 * file mtimeMs + size signature so disk updates invalidate automatically)
 * and builds per-airport language, voice, and allocatable-callsign lookups.
 */

const fs = require('fs');
const path = require('path');
const gamePaths = require('../../utils/gamePaths');

// Operational non-callsign clip prefixes present in radio_clip_durations.json
// (e.g. RWY01, RWY15, RWY16L, RWY16R, RWY19, RWY33, RWY34L, RWY34R).
const NON_CALLSIGN_PREFIXES = new Set(['RWY']);
const CALLSIGN_RE = /^([A-Z]{3})(\d+[A-Z0-9]*)$/;

// Shared per-root / per-airport caches keyed by normalized path + stat signature.
const _catalogCache = new Map();
const _clipIndexCache = new Map();
const _channelConfigCache = new Map();

function _fileSig(filePath) {
  if (!filePath) return 'none';
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return 'notfile';
    return `present:${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return 'missing';
  }
}

function _sortFlightNums(arr) {
  return arr.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

function _formatCallsignSet(callsignIterable) {
  const allSet = new Set();
  const byAirlineSets = new Map();
  for (const cs of callsignIterable) {
    const m = CALLSIGN_RE.exec(cs);
    if (!m) continue;
    const [, airline, num] = m;
    if (NON_CALLSIGN_PREFIXES.has(airline)) continue;
    allSet.add(cs);
    if (!byAirlineSets.has(airline)) byAirlineSets.set(airline, new Set());
    byAirlineSets.get(airline).add(num);
  }
  const allCallsigns = [...allSet].sort();
  const allAirlines = [...byAirlineSets.keys()].sort();
  const byAirline = {};
  for (const airline of allAirlines) {
    byAirline[airline] = _sortFlightNums([...byAirlineSets.get(airline)]);
  }
  return { byAirline, allCallsigns, allAirlines };
}

/**
 * Clear all in-memory v3 audio caches (useful in tests or manual rescan).
 */
function clearV3AudioCache() {
  _catalogCache.clear();
  _clipIndexCache.clear();
  _channelConfigCache.clear();
}

/**
 * Load `<StreamingAssets>/Voices/voice_catalog.json` (cached per game root + stat).
 *
 * @param {string} gameRoot
 */
function loadV3VoiceCatalog(gameRoot) {
  const empty = {
    present: false,
    sig: 'missing',
    filePath: null,
    voices: [],
    voiceLanguages: {},
    voiceRoles: {},
    captainVoices: [],
    atcVoices: [],
    captainVoicesByLang: {},
  };
  if (!gameRoot) return empty;

  const catalogPath = gamePaths.voiceCatalogPath(gameRoot);
  const sig = _fileSig(catalogPath);
  const cacheKey = gamePaths.norm(path.resolve(gameRoot));
  const cached = _catalogCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.value;

  if (!sig.startsWith('present:')) {
    const res = { ...empty, filePath: catalogPath, sig };
    _catalogCache.set(cacheKey, { sig, value: res });
    return res;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const list = Array.isArray(raw && raw.voices) ? raw.voices : [];
    const voices = [];
    const voiceLanguages = {};
    const voiceRoles = {};
    const captainSet = new Set();
    const atcSet = new Set();
    const captainByLangSets = {};

    for (const entry of list) {
      if (!entry || typeof entry.name !== 'string') continue;
      const name = entry.name.trim();
      if (!name) continue;
      const role = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : '';
      const language = typeof entry.language === 'string' ? entry.language.trim() : '';
      voices.push({ name, role, language });
      if (language) voiceLanguages[name] = language;
      if (role) voiceRoles[name] = role;
      if (role === 'captain') {
        captainSet.add(name);
        if (language) {
          if (!captainByLangSets[language]) captainByLangSets[language] = new Set();
          captainByLangSets[language].add(name);
        }
      } else if (role === 'atc') {
        atcSet.add(name);
      }
    }

    if (voices.length === 0) {
      const res = { ...empty, filePath: catalogPath, sig: `empty:${sig}` };
      _catalogCache.set(cacheKey, { sig, value: res });
      return res;
    }

    const captainVoices = [...captainSet].sort((a, b) => a.localeCompare(b));
    const atcVoices = [...atcSet].sort((a, b) => a.localeCompare(b));
    const captainVoicesByLang = {};
    for (const [lang, s] of Object.entries(captainByLangSets)) {
      captainVoicesByLang[lang] = [...s].sort((a, b) => a.localeCompare(b));
    }

    const value = {
      present: true,
      sig,
      filePath: catalogPath,
      voices,
      voiceLanguages,
      voiceRoles,
      captainVoices,
      atcVoices,
      captainVoicesByLang,
    };
    _catalogCache.set(cacheKey, { sig, value });
    return value;
  } catch (_) {
    const res = { ...empty, filePath: catalogPath, sig: `unreadable:${sig}` };
    _catalogCache.set(cacheKey, { sig, value: res });
    return res;
  }
}

/**
 * Load `<StreamingAssets>/radio_clip_durations.json` (cached per game root + stat).
 *
 * @param {string} gameRoot
 */
function loadV3ClipIndex(gameRoot) {
  const empty = {
    present: false,
    sig: 'missing',
    filePath: null,
    clipsByVoice: new Map(),
    callsignsByVoice: new Map(),
  };
  if (!gameRoot) return empty;

  const clipPath = gamePaths.radioClipDurationsPath(gameRoot);
  const sig = _fileSig(clipPath);
  const cacheKey = gamePaths.norm(path.resolve(gameRoot));
  const cached = _clipIndexCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.value;

  if (!sig.startsWith('present:')) {
    const res = { ...empty, filePath: clipPath, sig };
    _clipIndexCache.set(cacheKey, { sig, value: res });
    return res;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(clipPath, 'utf8'));
    const clips = raw && raw.clips && typeof raw.clips === 'object' ? raw.clips : null;
    if (!clips) {
      const res = { ...empty, filePath: clipPath, sig: `empty:${sig}` };
      _clipIndexCache.set(cacheKey, { sig, value: res });
      return res;
    }

    const clipsByVoice = new Map();
    const callsignsByVoice = new Map();

    for (const key of Object.keys(clips)) {
      const slash = key.indexOf('/');
      if (slash <= 0 || slash >= key.length - 1) continue;
      const voice = key.slice(0, slash);
      const clip = key.slice(slash + 1);

      let clipSet = clipsByVoice.get(voice);
      if (!clipSet) {
        clipSet = new Set();
        clipsByVoice.set(voice, clipSet);
      }
      clipSet.add(clip);

      const m = CALLSIGN_RE.exec(clip);
      if (m && !NON_CALLSIGN_PREFIXES.has(m[1])) {
        let csSet = callsignsByVoice.get(voice);
        if (!csSet) {
          csSet = new Set();
          callsignsByVoice.set(voice, csSet);
        }
        csSet.add(clip);
      }
    }

    const value = {
      present: true,
      sig,
      filePath: clipPath,
      clipsByVoice,
      callsignsByVoice,
    };
    _clipIndexCache.set(cacheKey, { sig, value });
    return value;
  } catch (_) {
    const res = { ...empty, filePath: clipPath, sig: `unreadable:${sig}` };
    _clipIndexCache.set(cacheKey, { sig, value: res });
    return res;
  }
}

/**
 * Load `<StreamingAssets>/Airports/<ICAO>/radio_channel_config.json`.
 *
 * Absent, empty, or unreadable channel voice mappings (such as `EGLC`) are
 * returned as `{ known: false, languages: null, atcVoicesByLang: {} }` rather
 * than assuming zero languages or zero voices.
 *
 * @param {string} gameRoot
 * @param {string} icao
 */
function loadV3ChannelConfig(gameRoot, icao) {
  const unknown = {
    known: false,
    present: false,
    filePath: null,
    languages: null,
    atcVoicesByLang: {},
    sig: 'missing',
  };
  if (!gameRoot || !icao) return unknown;

  const cfgPath = gamePaths.radioChannelConfigPath(gameRoot, icao);
  const sig = _fileSig(cfgPath);
  const cacheKey = `${gamePaths.norm(path.resolve(gameRoot))}|${String(icao).toUpperCase()}`;
  const cached = _channelConfigCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.value;

  if (!sig.startsWith('present:')) {
    const res = { ...unknown, filePath: cfgPath, sig };
    _channelConfigCache.set(cacheKey, { sig, value: res });
    return res;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      const res = { ...unknown, filePath: cfgPath, present: false, sig: `empty:${sig}` };
      _channelConfigCache.set(cacheKey, { sig, value: res });
      return res;
    }
    const channels = Array.isArray(raw.radioChannels) ? raw.radioChannels : [];
    const byLangSets = new Map();

    for (const ch of channels) {
      if (!ch || !ch.voice || typeof ch.voice !== 'object' || Array.isArray(ch.voice)) continue;
      for (const [rawLang, rawVoice] of Object.entries(ch.voice)) {
        const lang = typeof rawLang === 'string' ? rawLang.trim() : '';
        const voiceName = typeof rawVoice === 'string' ? rawVoice.trim() : '';
        if (!lang || !voiceName) continue;
        if (!byLangSets.has(lang)) byLangSets.set(lang, new Set());
        byLangSets.get(lang).add(voiceName);
      }
    }

    if (byLangSets.size === 0) {
      const res = { ...unknown, filePath: cfgPath, present: true, sig };
      _channelConfigCache.set(cacheKey, { sig, value: res });
      return res;
    }

    const languages = [...byLangSets.keys()].sort((a, b) => a.localeCompare(b));
    const atcVoicesByLang = {};
    for (const lang of languages) {
      atcVoicesByLang[lang] = [...byLangSets.get(lang)].sort((a, b) => a.localeCompare(b));
    }

    const value = {
      known: true,
      present: true,
      filePath: cfgPath,
      languages,
      atcVoicesByLang,
      sig,
    };
    _channelConfigCache.set(cacheKey, { sig, value });
    return value;
  } catch (_) {
    const res = { ...unknown, filePath: cfgPath, present: false, sig: `unreadable:${sig}` };
    _channelConfigCache.set(cacheKey, { sig, value: res });
    return res;
  }
}

/**
 * Intersect callsign clips across a selected captain voice and/or applicable ATC voice(s).
 *
 * @param {ReturnType<typeof loadV3ClipIndex>} clipIndex
 * @param {{ captainVoice?: string|null, atcVoices?: string[] }} options
 * @returns {{ byAirline: Record<string, string[]>, allCallsigns: string[], allAirlines: string[] }}
 */
function lookupV3Callsigns(clipIndex, { captainVoice = null, atcVoices = [] } = {}) {
  const empty = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (!clipIndex || !clipIndex.present) return empty;

  const requiredVoices = [];
  if (typeof captainVoice === 'string' && captainVoice.trim()) {
    requiredVoices.push(captainVoice.trim());
  }
  if (Array.isArray(atcVoices)) {
    for (const v of atcVoices) {
      if (typeof v === 'string' && v.trim() && !requiredVoices.includes(v.trim())) {
        requiredVoices.push(v.trim());
      }
    }
  }
  if (requiredVoices.length === 0) return empty;

  let intersection = null;
  for (const voiceName of requiredVoices) {
    const csSet = clipIndex.callsignsByVoice.get(voiceName);
    if (!csSet || csSet.size === 0) return empty;
    if (intersection === null) {
      intersection = new Set(csSet);
    } else {
      for (const cs of intersection) {
        if (!csSet.has(cs)) intersection.delete(cs);
      }
      if (intersection.size === 0) return empty;
    }
  }

  return _formatCallsignSet(intersection || []);
}

/**
 * Look up allocatable callsigns for `(gameRoot, icao)` given a captain voice and/or language.
 *
 * @param {string} gameRoot
 * @param {string} icao
 * @param {{ captainVoice?: string|null }} options
 */
function lookupV3CallsignsForAirport(gameRoot, icao, { captainVoice = null } = {}) {
  const clipIndex = loadV3ClipIndex(gameRoot);
  const channelCfg = loadV3ChannelConfig(gameRoot, icao);

  const cap = typeof captainVoice === 'string' && captainVoice.trim() ? captainVoice.trim() : null;
  const atcVoices = Object.values(channelCfg.atcVoicesByLang).flat();

  return lookupV3Callsigns(clipIndex, { captainVoice: cap, atcVoices });
}

/**
 * Build the complete v3 audio metadata bundle for an airport.
 *
 * @param {string} gameRoot
 * @param {string} icao
 */
function loadV3AirportAudio(gameRoot, icao) {
  const catalog = loadV3VoiceCatalog(gameRoot);
  const clipIndex = loadV3ClipIndex(gameRoot);
  const channelCfg = loadV3ChannelConfig(gameRoot, icao);

  const languages = channelCfg.known ? [...channelCfg.languages] : null;
  const langFilter = languages ? new Set(languages) : null;
  // The airport's callsign pool must account for its local ATC libraries,
  // including when an English captain shares a recording with global ATC audio.
  const sessionAtcVoices = [...new Set(Object.values(channelCfg.atcVoicesByLang).flat())];

  // Step 1: Captain voices matching airport channel languages (all captain voices when unknown)
  const langMatchedCaptains = catalog.captainVoices.filter((v) => {
    if (!langFilter) return true;
    const vLang = catalog.voiceLanguages[v];
    return !vLang || langFilter.has(vLang);
  });

  // Step 2: Allocatable callsigns per catalog captain voice against this airport's ATC voice(s)
  const allocatableLookupByVoice = {};
  for (const capVoice of catalog.captainVoices) {
    allocatableLookupByVoice[capVoice] = lookupV3Callsigns(clipIndex, {
      captainVoice: capVoice,
      atcVoices: sessionAtcVoices,
    });
  }

  // Step 3: Compatible captain voices for dropdowns/defaults at this airport.
  // When clip index and channel config are present, prefer captain voices that
  // share at least one callsign with the airport's ATC voice(s) (separating
  // Western Yeager+American-Female-ATC from CN-Captain-*-EN+Hanser-EN).
  let captainVoices = langMatchedCaptains;
  if (clipIndex.present && channelCfg.known) {
    const withClips = langMatchedCaptains.filter(
      (v) => (allocatableLookupByVoice[v]?.allCallsigns.length || 0) > 0,
    );
    if (withClips.length > 0) captainVoices = withClips;
  }

  const captainVoicesByLang = {};
  for (const v of captainVoices) {
    const vLang = catalog.voiceLanguages[v] || '';
    if (!vLang) continue;
    if (!captainVoicesByLang[vLang]) captainVoicesByLang[vLang] = [];
    captainVoicesByLang[vLang].push(v);
  }

  // Step 4: Merge allocatable callsigns across compatible captain voices for airport-level audioCallsigns
  const { mergeAudioCallsigns } = require('../utils');
  let audioCallsigns = { byAirline: {}, allCallsigns: [], allAirlines: [] };
  if (captainVoices.length > 0) {
    for (const v of captainVoices) {
      audioCallsigns = mergeAudioCallsigns(audioCallsigns, allocatableLookupByVoice[v]);
    }
  } else if (clipIndex.present && channelCfg.known) {
    audioCallsigns = lookupV3Callsigns(clipIndex, { atcVoices: sessionAtcVoices });
  }

  // Step 5: Serializable IPC / validator payload
  const voiceCallsigns = {};
  if (clipIndex.present) {
    const voicesToExport = new Set(catalog.captainVoices);
    if (voicesToExport.size === 0) {
      for (const v of clipIndex.callsignsByVoice.keys()) voicesToExport.add(v);
    }
    for (const v of voicesToExport) {
      const csSet = clipIndex.callsignsByVoice.get(v);
      voiceCallsigns[v] = csSet ? [...csSet].sort() : [];
    }
  }

  const atcCallsigns = {};
  if (clipIndex.present && channelCfg.known) {
    for (const atcList of Object.values(channelCfg.atcVoicesByLang)) {
      for (const atcVoice of atcList) {
        if (atcCallsigns[atcVoice]) continue;
        const csSet = clipIndex.callsignsByVoice.get(atcVoice);
        atcCallsigns[atcVoice] = csSet ? [...csSet].sort() : [];
      }
    }
  }

  const allocatableByVoice = {};
  const allocatableCallsignsByVoice = {};
  for (const [v, res] of Object.entries(allocatableLookupByVoice)) {
    allocatableByVoice[v] = res.byAirline;
    allocatableCallsignsByVoice[v] = res.allCallsigns;
  }

  const sourceSignature = `v3|cat=${catalog.sig}|clips=${clipIndex.sig}|ch=${channelCfg.sig}`;

  const v3Audio = {
    icao: String(icao || ''),
    hasCatalog: catalog.present,
    hasClipIndex: clipIndex.present,
    hasChannelConfigFile: Boolean(channelCfg.present),
    knownChannelConfig: channelCfg.known,
    catalogSig: catalog.sig,
    clipIndexSig: clipIndex.sig,
    channelConfigSig: channelCfg.sig,
    knownChannelLanguages: languages,
    sessionAtcVoices,
    allocatableAirlines: clipIndex.present && channelCfg.known ? audioCallsigns.allAirlines : null,
    atcVoicesByLang: channelCfg.atcVoicesByLang,
    voiceLanguages: catalog.voiceLanguages,
    voiceRoles: catalog.voiceRoles,
    captainVoices,
    allCaptainVoices: catalog.captainVoices,
    captainVoicesByLang,
    voiceCallsigns,
    atcCallsigns,
    allocatableByVoice,
    allocatableCallsignsByVoice,
  };

  return {
    languages,
    knownChannelConfig: channelCfg.known,
    atcVoicesByLang: channelCfg.atcVoicesByLang,
    captainVoices,
    allCaptainVoices: catalog.captainVoices,
    captainVoicesByLang,
    voiceLanguages: catalog.voiceLanguages,
    audioCallsigns,
    v3Audio,
    sourceSignature,
  };
}

/**
 * Lightweight header peek to detect an `.acl` file's container format without
 * decompressing or decoding the entire archive.
 *
 * @param {string} filePath
 * @returns {'gatcarc4-v1'|'gatcarc4-v2'|'gatcarc4-v3'|'legacy-text'|null}
 */
function peekAclFormat(filePath) {
  if (!filePath) return null;
  const { detectAclFormat } = require('../archive');
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const probe = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
    if (bytesRead <= 0) return null;
    return detectAclFormat(probe.subarray(0, bytesRead));
  } catch (_) {
    try {
      const full = fs.readFileSync(filePath);
      return detectAclFormat(full);
    } catch (_e2) {
      return null;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function hasV2AudioClips(gameRoot, icao) {
  if (!gameRoot || !icao) return false;
  const levelsPath = gamePaths.levelsDir(gameRoot, icao);
  const apPath = gamePaths.airportDir(gameRoot, icao);
  return (
    fs.existsSync(path.join(levelsPath, 'audio_clips_en.json')) ||
    fs.existsSync(path.join(levelsPath, 'audio_clips_zh.json')) ||
    fs.existsSync(path.join(apPath, 'audio_clips_en.json')) ||
    fs.existsSync(path.join(apPath, 'audio_clips_zh.json'))
  );
}

function hasV3AudioAssets(gameRoot, icao) {
  if (!gameRoot) return false;
  return (
    (icao && fs.existsSync(gamePaths.radioChannelConfigPath(gameRoot, icao))) ||
    fs.existsSync(gamePaths.radioClipDurationsPath(gameRoot)) ||
    fs.existsSync(gamePaths.voiceCatalogPath(gameRoot))
  );
}

/**
 * Choose `'v3'`, `'v2'`, or `'mixed'` audio mode by inspecting the active level
 * format (when specified) or the airport's `.acl` files (for airport-wide cache).
 *
 * @param {string} gameRoot
 * @param {string} icao
 * @param {string[]|string|null} [aclPathsOrActive]
 * @param {string|null} [activeAclPath]
 * @returns {'v2'|'v3'|'mixed'}
 */
function resolveAirportAudioMode(gameRoot, icao, aclPathsOrActive = [], activeAclPath = null) {
  let aclPaths = aclPathsOrActive;
  let resolvedActive = activeAclPath;
  if (typeof aclPathsOrActive === 'string') {
    resolvedActive = aclPathsOrActive;
    aclPaths = [];
  }

  if (resolvedActive) {
    const fmt = peekAclFormat(resolvedActive);
    if (fmt === 'gatcarc4-v3') return 'v3';
    if (fmt) return 'v2';
  }

  if ((!aclPaths || aclPaths.length === 0) && gameRoot && icao) {
    try {
      const levelsPath = gamePaths.levelsDir(gameRoot, icao);
      if (fs.existsSync(levelsPath)) {
        aclPaths = fs.readdirSync(levelsPath)
          .filter((n) => /\.acl$/i.test(n))
          .map((n) => path.join(levelsPath, n));
      }
    } catch (_) {
      aclPaths = [];
    }
  }

  let v3Count = 0;
  let legacyCount = 0;
  for (const p of (aclPaths || [])) {
    const fmt = peekAclFormat(p);
    if (fmt === 'gatcarc4-v3') v3Count++;
    else if (fmt) legacyCount++;
  }

  if (v3Count > 0 && legacyCount === 0) return 'v3';
  if (legacyCount > 0 && v3Count === 0) return 'v2';
  if (v3Count > 0 && legacyCount > 0) return 'mixed';

  // Airport with 0 level files (e.g. EGLC): prefer v2 sidecars if present, else v3 assets
  if (hasV2AudioClips(gameRoot, icao)) return 'v2';
  if (hasV3AudioAssets(gameRoot, icao)) return 'v3';
  return 'v2';
}

/**
 * Compute a deterministic file-stat signature over all audio source files for
 * `(gameRoot, icao)` so cached dropdown values can be invalidated if audio
 * assets or format mode change on disk.
 *
 * @param {string} gameRoot
 * @param {string} icao
 * @param {'v2'|'v3'|'mixed'} [mode]
 * @returns {string}
 */
function computeAudioSourceSignature(gameRoot, icao, mode) {
  const effectiveMode = mode || resolveAirportAudioMode(gameRoot, icao);
  if (!gameRoot || !icao) return `mode=${effectiveMode}|empty`;
  const levelsPath = gamePaths.levelsDir(gameRoot, icao);
  const apPath = gamePaths.airportDir(gameRoot, icao);
  const enSig = `${_fileSig(path.join(levelsPath, 'audio_clips_en.json'))},${_fileSig(path.join(apPath, 'audio_clips_en.json'))}`;
  const zhSig = `${_fileSig(path.join(levelsPath, 'audio_clips_zh.json'))},${_fileSig(path.join(apPath, 'audio_clips_zh.json'))}`;
  const catSig = _fileSig(gamePaths.voiceCatalogPath(gameRoot));
  const clipSig = _fileSig(gamePaths.radioClipDurationsPath(gameRoot));
  const chSig = _fileSig(gamePaths.radioChannelConfigPath(gameRoot, icao));
  return `mode=${effectiveMode}|en=${enSig}|zh=${zhSig}|cat=${catSig}|clip=${clipSig}|ch=${chSig}`;
}

module.exports = {
  NON_CALLSIGN_PREFIXES,
  clearV3AudioCache,
  loadV3VoiceCatalog,
  loadV3ClipIndex,
  loadV3ChannelConfig,
  lookupV3Callsigns,
  lookupV3CallsignsForAirport,
  loadV3AirportAudio,
  peekAclFormat,
  hasV2AudioClips,
  hasV3AudioAssets,
  resolveAirportAudioMode,
  computeAudioSourceSignature,
};

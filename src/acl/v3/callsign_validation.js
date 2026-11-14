'use strict';

/**
 * GATCARC4 v3 callsign & voice audio allocation validation (`src/acl/v3/callsign_validation.js`).
 *
 * Mirrors Unity's `FlightScheduleManager.TryAllocateCallsignReservation`,
 * `ContextCross.Services.CallsignService`, `CallsignPool`, and `VoiceCatalog`:
 *   - Every static `flight-plan:<Registration>` in `StaticData.StaticItems` must
 *     use a `captain`-role voice from `Voices/voice_catalog.json` whose catalog
 *     language matches `FlightPlan.Language` and is supported by the airport's
 *     active radio channels.
 *   - Every stored leg (`InitialArrival` and `InitialDeparture`) must have a
 *     recorded callsign clip for its selected captain voice (`<voice>/<callsign>`
 *     in `radio_clip_durations.json`) AND for every configured session ATC voice
 *     (`Airports/<ICAO>/radio_channel_config.json` / static
 *     `radio-channel:*` items).
 *   - Dual-leg plans (`InitialArrival` + `InitialDeparture`) must have two
 *     distinct callsigns, and callsigns cannot collide across different owners.
 *   - Distinguishes an absent recording in a loaded index (`missing_captain_clip` /
 *     `missing_atc_clip`) from unavailable or unreadable audio metadata
 *     (`audio_metadata_unavailable`).
 */

const gamePaths = require('../../utils/gamePaths');
const { getSchemaForHash } = require('./schema_registry');
const {
  dictEntries,
  indexDocumentGraph,
  resolveGraphNode,
} = require('./graph');
const {
  NON_CALLSIGN_PREFIXES,
  loadV3VoiceCatalog,
  loadV3ClipIndex,
  loadV3ChannelConfig,
  loadV3AirportAudio,
  hasV3AudioAssets,
} = require('./audio');

// Matches Unity's CallsignPool.StandardCallsignPattern (`^[A-Z]{2,4}[0-9]{1,5}[A-Z]{0,2}$`)
// and CallsignPool.SingleLetterFourDigitCallsignPattern (`^[A-Z][0-9]{4}$`).
const UNITY_CALLSIGN_POOL_RE = /^(?:([A-Z]{2,4})\d{1,5}[A-Z]{0,2}|[A-Z]\d{4})$/;

class CallsignAllocationError extends Error {
  constructor(issues, { metadataUnavailable = false, missingResources = [] } = {}) {
    const summary = issues.map((iss) => formatCallsignAllocationIssue(iss)).join('; ');
    const prefix = metadataUnavailable
      ? `Cannot verify v3 callsign audio allocation (${issues.length} metadata issue${issues.length === 1 ? '' : 's'})`
      : `Invalid v3 callsign/voice allocation (${issues.length} issue${issues.length === 1 ? '' : 's'})`;
    super(`${prefix}: ${summary}`);
    this.name = 'CallsignAllocationError';
    this.code = metadataUnavailable ? 'V3_AUDIO_METADATA_UNAVAILABLE' : 'V3_CALLSIGN_ALLOCATION';
    this.metadataUnavailable = Boolean(metadataUnavailable);
    this.missingResources = Array.isArray(missingResources) ? missingResources : [];
    this.issues = issues;
  }
}

function _isPoolCallsign(cs) {
  if (typeof cs !== 'string' || !cs) return false;
  const m = UNITY_CALLSIGN_POOL_RE.exec(cs);
  if (!m) return false;
  if (m[1] && NON_CALLSIGN_PREFIXES.has(m[1])) return false;
  return true;
}

function _voiceHasCallsignClip(voiceName, callSign, clipIndex, serializedMap) {
  if (!voiceName || !callSign || !_isPoolCallsign(callSign)) return false;
  if (clipIndex && clipIndex.present) {
    const csSet = clipIndex.callsignsByVoice.get(voiceName);
    if (csSet && csSet.has(callSign)) return true;
    const rawSet = clipIndex.clipsByVoice.get(voiceName);
    if (rawSet && rawSet.has(callSign)) return true;
    return false;
  }
  if (serializedMap && Object.prototype.hasOwnProperty.call(serializedMap, voiceName)) {
    const list = serializedMap[voiceName];
    if (list instanceof Set) return list.has(callSign);
    if (Array.isArray(list)) return list.includes(callSign);
  }
  return false;
}

/**
 * Extract all static `flight-plan:*` entries and their stored legs
 * (`InitialArrival` and `InitialDeparture`) from a decoded v3 container.
 *
 * @param {object} container
 * @param {object|null} [schema]
 */
function extractV3StaticPlansForCallsigns(container, schema = null) {
  if (!container || !container.staticData) return [];
  const resolvedSchema = schema || getSchemaForHash(container.header?.schemaHash);
  const stIdx = indexDocumentGraph(container.staticData, resolvedSchema.roots.static, resolvedSchema);
  const siDict = resolveGraphNode(container.staticData.StaticItems, stIdx);

  const plans = [];
  for (const [pk, rawV] of dictEntries(siDict)) {
    const key = String(pk);
    if (!key.startsWith('flight-plan:')) continue;
    const fp = resolveGraphNode(rawV, stIdx);
    if (!fp || typeof fp !== 'object') continue;

    const fallbackReg = key.slice('flight-plan:'.length);
    const registration = (typeof fp.Registration === 'string' && fp.Registration.trim())
      ? fp.Registration.trim()
      : fallbackReg;
    const language = typeof fp.Language === 'string' ? fp.Language.trim() : '';
    const voice = typeof fp.Voice === 'string' ? fp.Voice.trim() : '';

    const legs = [];
    for (const [slot, direction] of [
      ['InitialArrival', 'arrival'],
      ['InitialDeparture', 'departure'],
    ]) {
      const legObj = resolveGraphNode(fp[slot], stIdx);
      if (!legObj || typeof legObj !== 'object') continue;
      const callSign = typeof legObj.CallSign === 'string' ? legObj.CallSign.trim() : '';
      const airlineCode = typeof legObj.AirlineCode === 'string' ? legObj.AirlineCode.trim() : '';
      const flightNumber = typeof legObj.FlightNumber === 'string' ? legObj.FlightNumber.trim() : '';
      legs.push({
        slot,
        direction,
        callSign,
        airlineCode,
        flightNumber,
      });
    }

    plans.push({
      planKey: key,
      registration,
      language,
      voice,
      legs,
    });
  }

  return plans;
}

/**
 * Extract session ATC voices by language from `radio-channel:*` static items in
 * `StaticData.StaticItems` (matching `CallsignService.BuildSessionAtcVoices()`).
 *
 * @param {object} staticData
 * @param {object|null} [schema]
 */
function extractV3StaticRadioChannelVoices(staticData, schema = null) {
  const empty = { known: false, languages: null, atcVoicesByLang: {} };
  if (!staticData) return empty;
  const resolvedSchema = schema;
  if (!resolvedSchema || !resolvedSchema.roots?.static) return empty;

  const stIdx = indexDocumentGraph(staticData, resolvedSchema.roots.static, resolvedSchema);
  const siDict = resolveGraphNode(staticData.StaticItems, stIdx);
  const byLangSets = new Map();

  for (const [pk, rawV] of dictEntries(siDict)) {
    if (!String(pk).startsWith('radio-channel:')) continue;
    const rc = resolveGraphNode(rawV, stIdx);
    if (!rc || typeof rc !== 'object') continue;
    const voiceDict = resolveGraphNode(rc.Voice, stIdx);
    for (const [rawLang, rawVoice] of dictEntries(voiceDict)) {
      const lang = typeof rawLang === 'string' ? rawLang.trim() : '';
      const voiceName = typeof rawVoice === 'string' ? rawVoice.trim() : '';
      if (!lang || !voiceName) continue;
      if (!byLangSets.has(lang)) byLangSets.set(lang, new Set());
      byLangSets.get(lang).add(voiceName);
    }
  }

  if (byLangSets.size === 0) return empty;
  const languages = [...byLangSets.keys()].sort((a, b) => a.localeCompare(b));
  const atcVoicesByLang = {};
  for (const lang of languages) {
    atcVoicesByLang[lang] = [...byLangSets.get(lang)].sort((a, b) => a.localeCompare(b));
  }
  return { known: true, languages, atcVoicesByLang };
}

function _describeSigStatus(sig) {
  const s = String(sig || 'missing');
  if (s.startsWith('unreadable:')) return 'unreadable';
  if (s.startsWith('empty:')) return 'empty';
  if (s === 'notfile') return 'not a file';
  if (s.startsWith('present:')) return 'present';
  return 'missing';
}

/**
 * Compare a staged/target game root's v3 audio capability flags against an
 * optional source install and/or usability requirements (used by Flight Fuzz
 * startup and `--replace` safety gates).
 *
 * @param {{
 *   targetRoot: string|null,
 *   icao: string,
 *   sourceRoot?: string|null,
 *   requireUsable?: boolean,
 * }} params
 */
function verifyV3AudioCapabilities({
  targetRoot,
  icao,
  sourceRoot = null,
  requireUsable = false,
} = {}) {
  const targetCatalog = loadV3VoiceCatalog(targetRoot);
  const targetClips = loadV3ClipIndex(targetRoot);
  const targetChannel = loadV3ChannelConfig(targetRoot, icao);
  const targetBundle = (targetRoot && icao) ? loadV3AirportAudio(targetRoot, icao) : null;

  const capabilities = {
    icao: String(icao || ''),
    hasCatalog: Boolean(targetCatalog.present),
    hasClipIndex: Boolean(targetClips.present),
    hasChannelConfigFile: Boolean(targetChannel.present),
    knownChannelConfig: Boolean(targetChannel.known),
    catalogSig: targetCatalog.sig,
    clipIndexSig: targetClips.sig,
    channelConfigSig: targetChannel.sig,
    captainVoiceCount: targetBundle ? targetBundle.captainVoices.length : 0,
    allocatableCallsignCount: targetBundle ? targetBundle.audioCallsigns.allCallsigns.length : 0,
  };

  let sourceCapabilities = null;
  let sourceShipsV3Audio = false;
  let sourceCatalog = null;
  let sourceClips = null;
  let sourceChannel = null;

  if (sourceRoot) {
    sourceShipsV3Audio = Boolean(hasV3AudioAssets(sourceRoot, icao));
    sourceCatalog = loadV3VoiceCatalog(sourceRoot);
    sourceClips = loadV3ClipIndex(sourceRoot);
    sourceChannel = loadV3ChannelConfig(sourceRoot, icao);
    sourceCapabilities = {
      icao: String(icao || ''),
      hasCatalog: Boolean(sourceCatalog.present),
      hasClipIndex: Boolean(sourceClips.present),
      hasChannelConfigFile: Boolean(sourceChannel.present),
      knownChannelConfig: Boolean(sourceChannel.known),
      catalogSig: sourceCatalog.sig,
      clipIndexSig: sourceClips.sig,
      channelConfigSig: sourceChannel.sig,
    };
  }

  const missingOrUnreadable = [];
  const addMissing = (resource, filePath, status, reason) => {
    if (missingOrUnreadable.some((m) => m.resource === resource)) return;
    missingOrUnreadable.push({ resource, filePath: filePath || null, status, reason });
  };

  const enforceUsable = Boolean(requireUsable || sourceShipsV3Audio);

  if (enforceUsable) {
    if (!targetRoot) {
      addMissing('gameRoot', null, 'missing', 'gameRoot is not configured');
    } else {
      if (!targetCatalog.present) {
        addMissing(
          'Voices/voice_catalog.json',
          targetCatalog.filePath || gamePaths.voiceCatalogPath(targetRoot),
          _describeSigStatus(targetCatalog.sig),
          'captain/ATC voice roles and languages cannot be verified',
        );
      }
      if (!targetClips.present) {
        addMissing(
          'radio_clip_durations.json',
          targetClips.filePath || gamePaths.radioClipDurationsPath(targetRoot),
          _describeSigStatus(targetClips.sig),
          'per-voice callsign clip recordings cannot be verified',
        );
      }
      if (
        icao &&
        (String(targetChannel.sig).startsWith('unreadable:') || String(targetChannel.sig).startsWith('empty:'))
      ) {
        addMissing(
          `Airports/${icao}/radio_channel_config.json`,
          targetChannel.filePath || gamePaths.radioChannelConfigPath(targetRoot, icao),
          _describeSigStatus(targetChannel.sig),
          'airport ATC channel voice assignments are unreadable',
        );
      }
    }
  }

  if (sourceRoot && targetRoot) {
    if (sourceCatalog.present && !targetCatalog.present) {
      addMissing(
        'Voices/voice_catalog.json',
        targetCatalog.filePath || gamePaths.voiceCatalogPath(targetRoot),
        _describeSigStatus(targetCatalog.sig),
        'present in source install but missing or unreadable in target root',
      );
    }
    if (sourceClips.present && !targetClips.present) {
      addMissing(
        'radio_clip_durations.json',
        targetClips.filePath || gamePaths.radioClipDurationsPath(targetRoot),
        _describeSigStatus(targetClips.sig),
        'present in source install but missing or unreadable in target root',
      );
    }
    if (icao && sourceChannel.present && !targetChannel.present) {
      addMissing(
        `Airports/${icao}/radio_channel_config.json`,
        targetChannel.filePath || gamePaths.radioChannelConfigPath(targetRoot, icao),
        _describeSigStatus(targetChannel.sig),
        'present in source install but missing or unreadable in target root',
      );
    } else if (icao && sourceChannel.known && !targetChannel.known) {
      addMissing(
        `Airports/${icao}/radio_channel_config.json`,
        targetChannel.filePath || gamePaths.radioChannelConfigPath(targetRoot, icao),
        'incomplete',
        'source install defines radio channel voices (`knownChannelConfig: true`) but target root does not',
      );
    }
  }

  const ok = missingOrUnreadable.length === 0;
  const details = missingOrUnreadable
    .map((m) => `${m.resource} [${m.status}]${m.filePath ? ` (${m.filePath})` : ''}: ${m.reason}`)
    .join('; ');

  return {
    ok,
    sourceShipsV3Audio,
    capabilities,
    sourceCapabilities,
    missingOrUnreadable,
    message: ok
      ? ''
      : `v3 audio validation metadata incomplete for ${icao || 'airport'}: ${details}`,
  };
}

function formatCallsignAllocationIssue(iss) {
  if (!iss) return 'Unknown callsign allocation issue';
  if (iss.message) return iss.message;

  const regPart = iss.registration ? `registration ${iss.registration}` : (iss.planKey || 'unknown plan');
  const legLabel = iss.direction ? `${iss.direction} ` : '';
  const csLabel = iss.callSign ? `${legLabel}callsign "${iss.callSign}"` : `${legLabel}leg`;

  switch (iss.kind) {
    case 'audio_metadata_unavailable': {
      const resText = Array.isArray(iss.missingResources) && iss.missingResources.length > 0
        ? iss.missingResources.map((r) => `${r.resource} (${r.status})`).join(', ')
        : 'v3 audio metadata';
      return `Cannot verify v3 callsign audio allocation${iss.airportIcao ? ` for ${iss.airportIcao}` : ''}: required audio metadata could not be loaded [${resText}]`;
    }
    case 'missing_captain_clip': {
      const compat = Array.isArray(iss.compatibleCaptainVoices) && iss.compatibleCaptainVoices.length > 0
        ? ` Compatible captain voice(s)${iss.airportIcao ? ` at ${iss.airportIcao}` : ''}: ${iss.compatibleCaptainVoices.join(', ')}.`
        : '';
      return `Flight plan ${iss.planKey || regPart} (${regPart}, ${csLabel}): captain voice "${iss.voice}" has no audio recording for callsign "${iss.callSign}" in radio_clip_durations.json.${compat}`;
    }
    case 'missing_atc_clip': {
      const atcStr = Array.isArray(iss.missingAtcVoices) ? iss.missingAtcVoices.join(', ') : (iss.atcVoice || 'ATC');
      return `Flight plan ${iss.planKey || regPart} (${regPart}, ${csLabel}): airport ATC voice(s) "${atcStr}" have no audio recording for callsign "${iss.callSign}" in radio_clip_durations.json.`;
    }
    case 'unknown_captain_voice':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): voice "${iss.voice}" is not defined in Voices/voice_catalog.json.`;
    case 'invalid_captain_voice':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): voice "${iss.voice}" has role "${iss.role || 'unknown'}" in Voices/voice_catalog.json (expected "captain").`;
    case 'voice_language_mismatch':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): captain voice "${iss.voice}" has catalog language "${iss.voiceLanguage}", which does not match FlightPlan.Language "${iss.language}".`;
    case 'unsupported_language':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): language "${iss.language}" has no assigned radio channel ATC voice at ${iss.airportIcao || 'this airport'}.`;
    case 'duplicate_pair_callsign':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): turnaround InitialArrival and InitialDeparture cannot share the same callsign "${iss.callSign}".`;
    case 'duplicate_callsign':
      return `Flight plan ${iss.planKey || regPart} (${regPart}, ${csLabel}): duplicate callsign "${iss.callSign}" is already allocated to ${iss.otherPlanKey || iss.otherRegistration || 'another flight plan'}.`;
    case 'missing_voice':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): FlightPlan.Voice is empty.`;
    case 'missing_language':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): FlightPlan.Language is empty.`;
    case 'missing_callsign':
      return `Flight plan ${iss.planKey || regPart} (${regPart}): ${iss.slot || 'leg'} CallSign is empty.`;
    default:
      return `${iss.planKey || regPart}: ${iss.kind}`;
  }
}

/**
 * Validate v3 static flight-plan callsign/voice/language allocation against
 * the level's game root and airport audio metadata.
 *
 * @param {object} container - Decoded v3 container (`{ header, metaData, staticData, frames }`).
 * @param {object|null} [schema]
 * @param {{
 *   levelPath?: string|null,
 *   gameRoot?: string|null,
 *   airportIcao?: string|null,
 *   v3Audio?: object|null,
 *   atcVoicesByLang?: Record<string, string[]>|null,
 *   ignoreStaticChannelVoices?: boolean,
 *   requireAudioMetadata?: boolean,
 * }} [opts]
 */
function validateV3CallsignAllocation(container, schema = null, opts = {}) {
  if (!container || !container.staticData) {
    return { ok: true, metadataUnavailable: false, missingResources: [], issues: [] };
  }

  const resolvedSchema = schema || getSchemaForHash(container.header?.schemaHash);
  const plans = extractV3StaticPlansForCallsigns(container, resolvedSchema);
  const staticChannels = extractV3StaticRadioChannelVoices(container.staticData, resolvedSchema);

  const resolvedGameRoot = opts.gameRoot !== undefined
    ? opts.gameRoot
    : (opts.levelPath ? gamePaths.gameRootFromLevelPath(opts.levelPath) : null);

  const resolvedIcao = String(
    opts.airportIcao ||
    (opts.levelPath ? gamePaths.airportIcaoFromLevelPath(opts.levelPath) : '') ||
    container.header?.airportIcao ||
    container.metaData?.Config?.prototypeName ||
    '',
  ).trim();

  const explicitV3Audio = (opts.v3Audio && typeof opts.v3Audio === 'object') ? opts.v3Audio : null;
  const shouldVerifyAudio = Boolean(
    opts.requireAudioMetadata ||
    (plans.length > 0 && (resolvedGameRoot || explicitV3Audio)),
  );

  const issues = [];
  const missingResources = [];

  // 1. Structural flight-plan & callsign uniqueness checks (independent of external files)
  const ownerByCallsign = new Map();
  for (const plan of plans) {
    if (plan.legs.length === 0) continue;

    if (!plan.language) {
      const iss = {
        kind: 'missing_language',
        planKey: plan.planKey,
        registration: plan.registration,
        airportIcao: resolvedIcao,
      };
      iss.message = formatCallsignAllocationIssue(iss);
      issues.push(iss);
    }
    if (!plan.voice) {
      const iss = {
        kind: 'missing_voice',
        planKey: plan.planKey,
        registration: plan.registration,
        airportIcao: resolvedIcao,
      };
      iss.message = formatCallsignAllocationIssue(iss);
      issues.push(iss);
    }

    if (
      plan.legs.length >= 2 &&
      plan.legs[0].callSign &&
      plan.legs[0].callSign === plan.legs[1].callSign
    ) {
      const iss = {
        kind: 'duplicate_pair_callsign',
        planKey: plan.planKey,
        registration: plan.registration,
        callSign: plan.legs[0].callSign,
        airportIcao: resolvedIcao,
      };
      iss.message = formatCallsignAllocationIssue(iss);
      issues.push(iss);
    }

    for (const leg of plan.legs) {
      if (!leg.callSign) {
        const iss = {
          kind: 'missing_callsign',
          planKey: plan.planKey,
          registration: plan.registration,
          slot: leg.slot,
          direction: leg.direction,
          airportIcao: resolvedIcao,
        };
        iss.message = formatCallsignAllocationIssue(iss);
        issues.push(iss);
        continue;
      }

      const prevOwner = ownerByCallsign.get(leg.callSign);
      if (prevOwner && prevOwner.planKey !== plan.planKey) {
        const iss = {
          kind: 'duplicate_callsign',
          planKey: plan.planKey,
          registration: plan.registration,
          callSign: leg.callSign,
          slot: leg.slot,
          direction: leg.direction,
          otherPlanKey: prevOwner.planKey,
          otherRegistration: prevOwner.registration,
          airportIcao: resolvedIcao,
        };
        iss.message = formatCallsignAllocationIssue(iss);
        issues.push(iss);
      } else if (!prevOwner) {
        ownerByCallsign.set(leg.callSign, {
          planKey: plan.planKey,
          registration: plan.registration,
        });
      }
    }
  }

  if (!shouldVerifyAudio) {
    return {
      ok: issues.length === 0,
      metadataUnavailable: false,
      missingResources: [],
      issues,
    };
  }

  // 2. Load or inspect audio metadata and distinguish unavailable metadata from missing clips
  let catalog = null;
  let clipIndex = null;
  let channelCfg = null;
  let v3Audio = explicitV3Audio;

  if (!v3Audio && resolvedGameRoot) {
    catalog = loadV3VoiceCatalog(resolvedGameRoot);
    clipIndex = loadV3ClipIndex(resolvedGameRoot);
    channelCfg = resolvedIcao ? loadV3ChannelConfig(resolvedGameRoot, resolvedIcao) : null;
    v3Audio = loadV3AirportAudio(resolvedGameRoot, resolvedIcao).v3Audio;
  } else if (v3Audio && resolvedGameRoot) {
    clipIndex = loadV3ClipIndex(resolvedGameRoot);
  }

  const hasCatalog = Boolean(v3Audio && v3Audio.hasCatalog);
  const hasClipIndex = Boolean(v3Audio && v3Audio.hasClipIndex);
  const chSig = channelCfg ? channelCfg.sig : (v3Audio?.channelConfigSig || 'missing');
  const channelCorrupt = String(chSig).startsWith('unreadable:') || String(chSig).startsWith('empty:');

  if (!v3Audio && !resolvedGameRoot) {
    missingResources.push({
      resource: 'gameRoot',
      filePath: opts.levelPath || null,
      status: 'missing',
      reason: 'could not resolve StreamingAssets game root for v3 audio verification',
    });
  } else {
    if (!hasCatalog) {
      missingResources.push({
        resource: 'Voices/voice_catalog.json',
        filePath: catalog?.filePath || (resolvedGameRoot ? gamePaths.voiceCatalogPath(resolvedGameRoot) : null),
        status: _describeSigStatus(catalog?.sig || v3Audio?.catalogSig),
        reason: 'voice catalog is required to verify captain voice roles and languages',
      });
    }
    if (!hasClipIndex) {
      missingResources.push({
        resource: 'radio_clip_durations.json',
        filePath: clipIndex?.filePath || (resolvedGameRoot ? gamePaths.radioClipDurationsPath(resolvedGameRoot) : null),
        status: _describeSigStatus(clipIndex?.sig || v3Audio?.clipIndexSig),
        reason: 'clip duration index is required to verify callsign audio recordings',
      });
    }
    if (channelCorrupt) {
      missingResources.push({
        resource: `Airports/${resolvedIcao || '<ICAO>'}/radio_channel_config.json`,
        filePath: channelCfg?.filePath || (resolvedGameRoot && resolvedIcao ? gamePaths.radioChannelConfigPath(resolvedGameRoot, resolvedIcao) : null),
        status: _describeSigStatus(chSig),
        reason: 'airport radio channel config is unreadable',
      });
    }
  }

  if (missingResources.length > 0) {
    const metaIss = {
      kind: 'audio_metadata_unavailable',
      airportIcao: resolvedIcao,
      missingResources,
    };
    metaIss.message = formatCallsignAllocationIssue(metaIss);
    issues.unshift(metaIss);
    return {
      ok: false,
      metadataUnavailable: true,
      missingResources,
      issues,
    };
  }

  // 3. Determine effective ATC voice map:
  //    explicit override -> radio_channel_config.json -> static `radio-channel:*` items -> none (captain-only)
  let effectiveAtcVoicesByLang = {};
  if (opts.atcVoicesByLang && typeof opts.atcVoicesByLang === 'object') {
    effectiveAtcVoicesByLang = opts.atcVoicesByLang;
  } else if (v3Audio.knownChannelConfig && v3Audio.atcVoicesByLang) {
    effectiveAtcVoicesByLang = v3Audio.atcVoicesByLang;
  } else if (!opts.ignoreStaticChannelVoices && staticChannels.known) {
    effectiveAtcVoicesByLang = staticChannels.atcVoicesByLang;
  }
  const effectiveChannelLangs = Object.keys(effectiveAtcVoicesByLang);
  const effectiveChannelKnown = effectiveChannelLangs.length > 0;
  const sessionAtcVoices = [...new Set(Object.values(effectiveAtcVoicesByLang).flat())];

  const voiceRoles = v3Audio.voiceRoles || {};
  const voiceLanguages = v3Audio.voiceLanguages || {};
  const allCaptainVoices = Array.isArray(v3Audio.allCaptainVoices)
    ? v3Audio.allCaptainVoices
    : Object.keys(voiceRoles).filter((v) => voiceRoles[v] === 'captain');

  const findCompatibleCaptainVoices = (callSign) => {
    const out = [];
    for (const cv of allCaptainVoices) {
      if (!_voiceHasCallsignClip(cv, callSign, clipIndex, v3Audio.voiceCallsigns)) continue;
      const cvLang = voiceLanguages[cv] || '';
      if (effectiveChannelKnown && cvLang) {
        if (!effectiveAtcVoicesByLang[cvLang]?.length) continue;
        const atcOk = sessionAtcVoices.every((av) =>
          _voiceHasCallsignClip(av, callSign, clipIndex, v3Audio.atcCallsigns),
        );
        if (!atcOk) continue;
      }
      out.push(cv);
    }
    return out;
  };

  // 4. Per-plan and per-leg voice/language/clip checks
  for (const plan of plans) {
    if (plan.legs.length === 0) continue;

    const { planKey, registration, language, voice } = plan;

    if (voice) {
      const role = voiceRoles[voice];
      if (!role) {
        const iss = {
          kind: 'unknown_captain_voice',
          planKey,
          registration,
          voice,
          language,
          airportIcao: resolvedIcao,
        };
        iss.message = formatCallsignAllocationIssue(iss);
        issues.push(iss);
      } else if (role !== 'captain') {
        const iss = {
          kind: 'invalid_captain_voice',
          planKey,
          registration,
          voice,
          role,
          language,
          airportIcao: resolvedIcao,
        };
        iss.message = formatCallsignAllocationIssue(iss);
        issues.push(iss);
      } else if (language && voiceLanguages[voice] && voiceLanguages[voice] !== language) {
        const iss = {
          kind: 'voice_language_mismatch',
          planKey,
          registration,
          voice,
          voiceLanguage: voiceLanguages[voice],
          language,
          airportIcao: resolvedIcao,
        };
        iss.message = formatCallsignAllocationIssue(iss);
        issues.push(iss);
      }
    }

    if (language && effectiveChannelKnown && !effectiveAtcVoicesByLang[language]) {
      const iss = {
        kind: 'unsupported_language',
        planKey,
        registration,
        language,
        voice,
        airportIcao: resolvedIcao,
      };
      iss.message = formatCallsignAllocationIssue(iss);
      issues.push(iss);
    }

    for (const leg of plan.legs) {
      if (!leg.callSign) continue;

      // Captain clip check — enforced independently of ATC coverage
      if (voice && voiceRoles[voice] === 'captain') {
        const hasCapClip = _voiceHasCallsignClip(voice, leg.callSign, clipIndex, v3Audio.voiceCallsigns);
        if (!hasCapClip) {
          const compatibleCaptainVoices = findCompatibleCaptainVoices(leg.callSign);
          const iss = {
            kind: 'missing_captain_clip',
            planKey,
            registration,
            callSign: leg.callSign,
            slot: leg.slot,
            direction: leg.direction,
            language,
            voice,
            airportIcao: resolvedIcao,
            compatibleCaptainVoices,
          };
          iss.message = formatCallsignAllocationIssue(iss);
          issues.push(iss);
        }
      }

      // Session ATC clip check — enforced against every ATC voice for this language
      if (sessionAtcVoices.length > 0) {
        const missingAtcVoices = sessionAtcVoices.filter(
          (av) => !_voiceHasCallsignClip(av, leg.callSign, clipIndex, v3Audio.atcCallsigns),
        );
        if (missingAtcVoices.length > 0) {
          const iss = {
            kind: 'missing_atc_clip',
            planKey,
            registration,
            callSign: leg.callSign,
            slot: leg.slot,
            direction: leg.direction,
            language,
            voice,
            missingAtcVoices,
            atcVoice: missingAtcVoices[0],
            airportIcao: resolvedIcao,
          };
          iss.message = formatCallsignAllocationIssue(iss);
          issues.push(iss);
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    metadataUnavailable: false,
    missingResources: [],
    issues,
  };
}

module.exports = {
  CallsignAllocationError,
  extractV3StaticPlansForCallsigns,
  extractV3StaticRadioChannelVoices,
  verifyV3AudioCapabilities,
  formatCallsignAllocationIssue,
  validateV3CallsignAllocation,
};

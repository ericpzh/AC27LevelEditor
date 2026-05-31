/**
 * ACL FlightSchedule parser — old format type 33/34.
 */
const { FIELDS } = require('./constants');
const { timeToTicks, _extractBaseDateTicks } = require('./time_utils');

// ─── FlightSchedule parser ────────────────────────────────────

function _parseFlightSchedule(text) {
  const fsMatch = text.match(/"FlightSchedule"\s*:\s*\{/);
  if (!fsMatch) return null;
  const afterFS = text.substring(fsMatch.index);
  const rcMatch = afterFS.match(/"\$rcontent"\s*:\s*\[/);
  if (!rcMatch) return null;

  const pos = fsMatch.index + rcMatch.index + rcMatch[0].length;
  let depth = 0, endPos = null;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        let j = i + 1;
        while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
        if (j < text.length && text[j] === ']') { endPos = i + 1; break; }
      }
    } else if (c === ']' && depth === 0) { endPos = i; break; }
  }
  if (endPos === null) return null;

  // Extract $rlength from the before section
  const beforeRaw = text.substring(0, pos);
  const rlMatch = beforeRaw.match(/"\$rlength"\s*:\s*(\d+)/);
  const originalLength = rlMatch ? parseInt(rlMatch[1], 10) : 0;

  const before = text.substring(0, pos);
  const after = text.substring(endPos);
  const arrayContent = text.substring(pos, endPos);
  const flights = [], originalBlocks = [];
  depth = 0; let entryStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === '{') { if (depth === 0) entryStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && entryStart >= 0) {
        const block = arrayContent.substring(entryStart, i + 1);
        originalBlocks.push(block);
        const flight = _parseFlightBlock(block);
        if (flight) flights.push(flight);
        entryStart = -1;
      }
    }
  }
  return { flights, before, after, arrayContent, originalBlocks, originalLength };
}

// ─── Flight block parser ──────────────────────────────────────

function _parseFlightBlock(block) {
  const flight = {};
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const m = block.match(new RegExp(`"${fn}"\\s*:\\s*"([^"]*)"`));
      flight[fn] = m ? m[1] : '';
    } else if (ft === 'time') {
      const m = block.match(new RegExp(`"${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*(\\d+)\\s*,\\s*(-?\\d+)\\s*\\}`));
      flight[fn] = m ? require('./time_utils').ticksToTime(m[2]) : '';
    }
  }
  return flight;
}

// ─── In-place patch helpers ───────────────────────────────────

function _applyChanges(block, flight, baseDateTicks) {
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const val = flight[fn] || '';
      const m = block.match(new RegExp(`("${fn}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`));
      if (m) {
        block = block.substring(0, m.index) + m[1] + '"' + val + '"' + block.substring(m.index + m[0].length);
      } else {
        const mNull = block.match(new RegExp(`("${fn}"\\s*:\\s*)null`));
        if (mNull && val) {
          block = block.substring(0, mNull.index) + mNull[1] + '"' + val + '"' + block.substring(mNull.index + mNull[0].length);
        }
      }
    } else if (ft === 'time') {
      const ticks = timeToTicks(flight[fn] || '', baseDateTicks);
      const m = block.match(new RegExp(`("${fn}"\\s*:\\s*\\{\\s*"\\$type"\\s*:\\s*\\d+\\s*,\\s*)(-?\\d+)(\\s*\\})`));
      if (m) {
        const start = m.index + m[1].length;
        const end = start + m[2].length;
        block = block.substring(0, start) + String(ticks) + block.substring(end);
      }
    }
  }
  return block;
}

function _buildNewBlock(flight, templateBlock, baseDateTicks) {
  if (templateBlock) {
    let block = templateBlock;
    // Deterministic $id based on CallSign to avoid collisions across saves
    const cs = (flight.CallSign || 'UNKNOWN');
    let hash = 0;
    for (let i = 0; i < cs.length; i++) hash = ((hash << 5) - hash + cs.charCodeAt(i)) | 0;
    const newId = 90000 + (Math.abs(hash) % 90000);
    block = block.replace(/"\$id"\s*:\s*\d+/, `"$id": ${newId}`);
    return _applyChanges(block, flight, baseDateTicks);
  }
  const lines = ['{'];
  lines.push('                "$id": 90000,');
  lines.push('                "$type": 34,');
  for (const [fn, ft] of FIELDS) {
    if (ft === 'string') {
      const val = flight[fn] || '';
      lines.push(val ? `                "${fn}": "${val}",` : `                "${fn}": null,`);
    } else if (ft === 'time') {
      const ticks = timeToTicks(flight[fn] || '', baseDateTicks);
      lines.push(`                "${fn}": { "$type": 3, ${ticks} },`);
    }
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  lines.push('            }');
  return lines.join('\n');
}

// ─── Block rebuild ────────────────────────────────────────────

function _rebuildBlocks(flights, originalBlocks, baseDateTicks) {
  const newBlocks = [];
  for (let i = 0; i < flights.length; i++) {
    if (i < originalBlocks.length) {
      newBlocks.push(_applyChanges(originalBlocks[i], flights[i], baseDateTicks));
    } else {
      const template = originalBlocks.length > 0 ? originalBlocks[originalBlocks.length - 1] : null;
      newBlocks.push(_buildNewBlock(flights[i], template, baseDateTicks));
    }
  }
  return newBlocks;
}

// ─── Rlength updater ──────────────────────────────────────────

function _updateRlength(text, newCount) {
  // Only update $rlength within the FlightSchedule section, not the first one in file
  const fsIdx = text.indexOf('"FlightSchedule"');
  if (fsIdx >= 0) {
    const beforeFS = text.substring(0, fsIdx);
    const afterFS = text.substring(fsIdx);
    const updated = afterFS.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newCount}`);
    return beforeFS + updated;
  }
  return text.replace(/"\$rlength"\s*:\s*\d+/, `"$rlength": ${newCount}`);
}

module.exports = {
  _parseFlightSchedule,
  _parseFlightBlock,
  _applyChanges,
  _buildNewBlock,
  _rebuildBlocks,
  _updateRlength,
};

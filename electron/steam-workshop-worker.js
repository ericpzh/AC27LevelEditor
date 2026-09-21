#!/usr/bin/env node
'use strict';
// ─── Steam Workshop worker (short-lived, plain node) ───────────────────────
// Runs as a disposable child process so SteamAPI_Init never executes in the
// long-lived Electron main process. When this process exits, Steam clears the
// app's "running" status — the whole reason this worker exists.
//
// Spawned by electron/steam-workshop-bridge.js via:
//   process.execPath <this file>   with ELECTRON_RUN_AS_NODE=1
// Env:
//   STEAM_WORKSHOP_LIB        absolute path to the steamworks.js entry (asar
//                             unpacked path in packaged builds)
//   STEAM_WORKSHOP_APP_ID     Workshop host app id (default 4004140)
//
// Protocol: JSON lines on stdin, JSON lines on stdout.
//   in : {id, op:'availability'|'getItem'|'missing'|'createItem'|'updateItem'|'shutdown', ...}
//   out: {id, type:'progress', value:{status,progress,total}}
//        {id, type:'result',   value:<json>}
//        {id, type:'error',    error:{code,message}}
//
// All Steam client logic lives in ./steam-workshop-core (shipped beside this
// file as extraResources — see build.js).

const readline = require('readline');
const core = require('./steam-workshop-core');

const APP_ID = Number(process.env.STEAM_WORKSHOP_APP_ID || '4004140');
const LIB_PATH = process.env.STEAM_WORKSHOP_LIB || '';

let lib = null;
let client = null;

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj, _bigintReplacer) + '\n');
  } catch (_) { /* parent gone */ }
}

function _bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function ensureClient() {
  if (client) return client;
  if (!lib) {
    if (!LIB_PATH) throw core.codedError('STEAM_UNAVAILABLE', 'worker missing STEAM_WORKSHOP_LIB');
    // eslint-disable-next-line global-require
    lib = require(LIB_PATH);
  }
  client = core.initClient(lib, APP_ID);
  return client;
}

async function handle(msg) {
  const id = msg && msg.id;
  const op = msg && msg.op;
  switch (op) {
    case 'availability': {
      try {
        const c = ensureClient();
        send({ id, type: 'result', value: { available: true, appId: String(APP_ID), author: core.getAuthor(c) } });
      } catch (err) {
        send({
          id,
          type: 'result',
          value: { available: false, appId: String(APP_ID), reason: (err && err.code) || 'STEAM_UNAVAILABLE', author: '' },
        });
      }
      return;
    }
    case 'getItem': {
      const item = await core.readLiveItem(ensureClient(), msg.publishedFileId);
      send({ id, type: 'result', value: item });
      return;
    }
    case 'missing': {
      send({ id, type: 'result', value: await core.itemMissing(ensureClient(), msg.publishedFileId) });
      return;
    }
    case 'createItem': {
      send({ id, type: 'result', value: await core.createItem(ensureClient(), APP_ID) });
      return;
    }
    case 'updateItem': {
      const value = await core.submitUpdate(ensureClient(), msg.publishedFileId, msg.details, APP_ID, (prog) => {
        send({
          id,
          type: 'progress',
          value: {
            status: (prog && prog.status) || 0,
            progress: prog && prog.progress != null ? Number(prog.progress) : 0,
            total: prog && prog.total != null ? Number(prog.total) : 0,
          },
        });
      });
      send({
        id,
        type: 'result',
        value: {
          itemId: value && value.itemId != null ? String(value.itemId) : null,
          needsToAcceptAgreement: Boolean(value && value.needsToAcceptAgreement),
        },
      });
      return;
    }
    case 'shutdown':
      process.exit(0);
      return;
    default:
      send({ id, type: 'error', error: { code: 'WORKER_BAD_OP', message: `unknown op ${op}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = String(line).trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (_) {
    return;
  }
  handle(msg).catch((err) => {
    send({
      id: msg && msg.id,
      type: 'error',
      error: { code: (err && err.code) || 'UPLOAD_FAILED', message: (err && err.message) || String(err) },
    });
  });
});
// Parent gone (stdin EOF, e.g. main process quit): never linger — a surviving
// child would keep Steam reporting the app as running.
rl.on('close', () => process.exit(0));

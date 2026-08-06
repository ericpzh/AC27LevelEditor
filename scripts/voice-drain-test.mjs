// voice-drain-test.mjs — session-lifecycle test for voiceSttWorker.js + ps1:
//   1. status → start → started
//   2. release → re-press within the drain window → success, no 'stopped',
//      no new 'started' (engine never stopped — seamless continuation)
//   3. release → 'stopped' arrives after the phrase boundary
//   4. dispose (mid-session) → clean exit, no WORKER_EXIT
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const voiceStt = require('../electron/voiceSttWorker.js');

const log = (...a) => console.log(`[test ${Date.now() % 100000}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
voiceStt.onEvent((e) => { events.push(e); log('event:', JSON.stringify(e)); });

const t0 = Date.now();
let failed = false;
const expect = (cond, label) => {
  log(cond ? 'PASS' : 'FAIL', label, `(${Date.now() - t0}ms)`);
  if (!cond) failed = true;
};
const countSince = (from, type) => events.slice(from).filter((e) => e.type === type).length;

// 1. probe + start
const status = await voiceStt.getStatus();
expect(status.available === true, `status available (culture=${status.culture})`);

const r1 = await voiceStt.start(null);
expect(r1.success === true, 'start succeeds');
await sleep(200);
expect(events.some((e) => e.type === 'started'), 'started event');

// 2. release → re-press inside the drain window → seamless continuation
voiceStt.stop();
await sleep(300);
const eMid = events.length;
const r2 = await voiceStt.start(null);
expect(r2.success === true, 're-press during drain succeeds');
await sleep(2000);                     // outlasts the 1.5s drain
expect(countSince(eMid, 'stopped') === 0, 'no stopped — pending stop cancelled');
expect(countSince(eMid, 'started') === 0, 'no restart — engine stayed live');

// 3. real release → stopped at the phrase boundary
voiceStt.stop();
let waited = 0;
while (!events.some((e) => e.type === 'stopped') && waited < 5000) {
  await sleep(100);
  waited += 100;
}
expect(events.some((e) => e.type === 'stopped'), `stopped after boundary (${waited}ms)`);

// 4. dispose mid-session → clean, no WORKER_EXIT
const before = events.length;
voiceStt.dispose();
await sleep(3800);
expect(!events.slice(before).some((e) => e.type === 'error' && e.code === 'WORKER_EXIT'), 'no WORKER_EXIT on dispose');

log(failed ? 'FAILED' : 'ALL PASS');

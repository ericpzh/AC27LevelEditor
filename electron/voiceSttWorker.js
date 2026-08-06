/**
 * Voice STT worker bridge — spawns and drives electron/voice-stt-vosk.js
 * (offline vosk recognition) as a long-lived child process. The child runs as
 * PLAIN NODE via ELECTRON_RUN_AS_NODE=1 (electron.exe behaves like node.exe),
 * so the spawned target is process.execPath, not powershell.exe.
 *
 * Protocol: JSON lines over stdin/stdout, UTF-8.
 *   in : {"cmd":"start"} | {"cmd":"stop"} | {"cmd":"exit"}
 *   out: ready / started / stopped / result / rejected / error
 *        (see electron/voice-stt-vosk.js)
 *
 * State machine: idle → starting → ready → recognizing → ready.
 *
 * Stop is DELAYED by STOP_DRAIN_MS (release-drain): the child finalizes the
 * phrase in flight at its own phrase boundary, so a PTT release can never
 * discard a phrase. A re-press inside the drain window cancels the pending
 * stop (the engine never stopped — seamless continuation); a re-press after
 * the drain expired but before the boundary is forwarded and the child
 * continues the finalizing session (re-emits 'started').
 * Event routing: start(sender) captures the initiating webContents; events are
 * pushed by the main.js subscription via getActiveSender().
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'voice-stt-vosk.js';

/**
 * Release-drain window (ms). Longer than the ps1's EndSilenceTimeout (1s) so
 * the final phrase result is always delivered before the stop takes effect,
 * and long enough to absorb a fast re-press (no stop is sent at all).
 */
const STOP_DRAIN_MS = 1500;

class VoiceSttWorker extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = 'idle';          // idle | starting | ready | recognizing
    this.stopTimer = null;        // release-drain (see STOP_DRAIN_MS)
    this.disposing = false;       // suppress WORKER_EXIT on our own shutdown
    this.activeSender = null;
    this.statusCache = null;      // {available, culture, recognizers} once ready
    this.statusProbes = [];       // pending getStatus() resolvers
    this.outBuf = '';
  }

  getActiveSender() {
    return this.activeSender;
  }

  // ── Script path (dev vs packaged — child files cannot live inside asar,
  //  they are shipped via extraResources) ──
  _scriptPath() {
    let app;
    try { app = require('electron').app; } catch (_) { /* plain node — dev path */ }
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, SCRIPT_NAME);
    }
    const devPath = path.join(__dirname, '..', 'electron', SCRIPT_NAME);
    return fs.existsSync(devPath) ? devPath : path.join(__dirname, SCRIPT_NAME);
  }

  // Packaged → process.resourcesPath (where extraResources land); dev → repo root.
  _resourcesRoot() {
    let app;
    try { app = require('electron').app; } catch (_) { /* plain node */ }
    return app && app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  }

  _send(obj) {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _failProbes(code) {
    if (this.statusProbes.length) {
      const probes = this.statusProbes.splice(0);
      probes.forEach((resolve) => resolve({ available: false, error: code }));
    }
    if (this._startWaits && this._startWaits.length) {
      const waits = this._startWaits.splice(0);
      waits.forEach((resolve) => resolve({ success: false, error: code }));
    }
  }

  _ensureWorker() {
    if (process.platform !== 'win32') {
      this._failProbes('NON_WINDOWS');
      return;
    }
    if (this.child) return;
    const script = this._scriptPath();
    if (!fs.existsSync(script)) {
      console.warn('[VoiceSTT] script not found:', script);
      this._failProbes('NO_SCRIPT');
      return;
    }
    console.log('[VoiceSTT] spawning worker:', script);
    try {
      this.child = spawn(process.execPath, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',       // electron.exe runs as plain node
          VOICE_RESOURCES: this._resourcesRoot(),  // packaged resources/ vs repo root
        },
      });
    } catch (err) {
      console.warn('[VoiceSTT] spawn failed:', err.message);
      this.child = null;
      this._failProbes('SPAWN_FAILED');
      return;
    }
    this.state = 'starting';

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.outBuf += chunk;
      let idx;
      while ((idx = this.outBuf.indexOf('\n')) >= 0) {
        const line = this.outBuf.slice(0, idx).trim();
        this.outBuf = this.outBuf.slice(idx + 1);
        if (line) this._onLine(line);
      }
    });
    this.child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log('[VoiceSTT]', line);
    });
    this.child.on('error', (err) => {
      console.warn('[VoiceSTT] spawn error:', err.message);
      this.child = null;
      this.state = 'idle';
      this.statusCache = null;
      this._failProbes('SPAWN_FAILED');
    });
    this.child.on('exit', (code) => this._onExit(code));
  }

  _onExit(code) {
    this.child = null;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const wasActive = this.state === 'recognizing';
    this.state = 'idle';
    this.statusCache = null;
    this._failProbes('SPAWN_FAILED');
    if (wasActive && !this.disposing) {
      this.emit('event', {
        type: 'error',
        code: 'WORKER_EXIT',
        message: `Speech worker exited unexpectedly (code ${code})`,
      });
    }
  }

  _onLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      console.warn('[VoiceSTT] ignoring malformed line:', line);
      return;
    }
    switch (obj.type) {
      case 'ready':
        this.state = 'ready';
        this.statusCache = {
          available: true,
          culture: obj.culture,
          engine: obj.engine,
          model: obj.model,
          sampleRate: obj.sampleRate,
          languages: obj.languages,
          models: obj.models,
        };
        if (this.statusProbes.length) {
          const probes = this.statusProbes.splice(0);
          probes.forEach((resolve) => resolve(this.statusCache));
        }
        break;
      case 'started':
        this.state = 'recognizing';
        break;
      case 'stopped':
        this.state = 'ready';
        break;
      case 'rejected':
        // Informational (busy) — the renderer's cooldown masks most cases.
        break;
      case 'error':
        this.state = 'idle';
        this._failProbes(obj.code || 'ENGINE');
        break;
      default:
        break;
    }
    this.emit('event', obj);
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Probe worker availability (lazy spawn, cached after first ready).
   * @returns {Promise<{available:boolean, culture?:string, recognizers?:string, error?:string}>}
   */
  getStatus() {
    if (this.statusCache) return Promise.resolve(this.statusCache);
    if (this.statusProbes.length) {
      // Already probing — join the queue.
      return new Promise((resolve) => this.statusProbes.push(resolve));
    }
    return new Promise((resolve) => {
      this.statusProbes.push(resolve);
      this._ensureWorker();
    });
  }

  /**
   * Begin recognition. Events are routed to `sender` via getActiveSender().
   * @param {Electron.WebContents} sender — initiating window
   * @param {string[]} [extraWords] — the current airport's waypoint names,
   *   merged into the session grammar (see voice-stt-vosk.js startSession)
   */
  async start(sender, extraWords) {
    this.activeSender = sender;
    // Re-press inside the release-drain: cancel the pending stop — the engine
    // never stopped, so no command is needed.
    const inDrain = !!this.stopTimer;
    if (inDrain) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.state !== 'recognizing') {
      const status = await this.getStatus();
      if (!status.available) return { success: false, error: status.error || 'UNAVAILABLE' };
    }
    if (!inDrain) {
      // Forward 'start' — the ps1 decides the outcome: continues a finalizing
      // session (re-press after the drain expired), rejects a busy one, or
      // begins a new one.
      this._send({ cmd: 'start', extraWords: Array.isArray(extraWords) ? extraWords : [] });
    }
    return { success: true };
  }

  stop() {
    if (this.state !== 'recognizing' || this.stopTimer) return;
    // Delayed stop (release-drain): lets the ps1 finalize the phrase in
    // flight before the stop lands; a fast re-press cancels it entirely.
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this._send({ cmd: 'stop' });
    }, STOP_DRAIN_MS);
  }

  /** Subscribe to worker events (result/started/stopped/rejected/error). */
  onEvent(cb) {
    this.on('event', cb);
  }

  /** Clean shutdown — used from main.js will-quit. */
  dispose() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (!this.child) return;
    this.disposing = true;
    try {
      this.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n');
    } catch (_) { /* already closed */ }
    const child = this.child;
    // The ps1 only reads stdin between recognition ticks (≤2.2s silence
    // boundary), so give it ~3s to exit cleanly before killing.
    setTimeout(() => {
      if (child && !child.killed) {
        try { child.kill(); } catch (_) { /* gone */ }
      }
    }, 3000).unref();
  }
}

module.exports = new VoiceSttWorker();

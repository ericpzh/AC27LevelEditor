'use strict';
// ─── Steam Workshop worker bridge (Electron main process) ──────────────────
// Spawns and drives electron/steam-workshop-worker.js — a short-lived plain-node
// child that owns SteamAPI_Init. Keeping Steam out of the long-lived main
// process means Steam stops reporting the game as "running" as soon as the
// worker exits (see the ac27-editor skill / livery workshop notes).
//
// Lifecycle: lazily spawned on the first request, torn down right after the
// high-level operation calls release(), and additionally on an idle timeout as
// a safety net. dispose() is called from main.js on will-quit.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'steam-workshop-worker.js';

// Safety net when a caller forgets release(). Kept short so a forgotten worker
// cannot keep Steam's "running" status alive for long.
const IDLE_MS = 8000;
// Grace after release() so a final progress/result can flush before the child
// is asked to exit.
const RELEASE_GRACE_MS = 300;
// Force-kill if the child ignores the shutdown request.
const EXIT_KILL_MS = 3000;

class SteamWorkshopBridge {
  constructor() {
    this.appId = '3328490';
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.outBuf = '';
    this.idleTimer = null;
    this.killTimer = null;
    this.releasing = false;
  }

  // ── Paths (dev vs packaged — child files cannot live inside asar, they ship
  //  via extraResources) ──
  _scriptPath() {
    let app;
    try { app = require('electron').app; } catch (_) { /* plain node */ }
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, SCRIPT_NAME);
    }
    const devPath = path.join(__dirname, '..', 'electron', SCRIPT_NAME);
    return fs.existsSync(devPath) ? devPath : path.join(__dirname, SCRIPT_NAME);
  }

  // The native module is asarUnpacked by electron-builder. The child is plain
  // node (no asar support), so point it at the unpacked copy on disk.
  _libPath() {
    try {
      let p = require.resolve('steamworks.js');
      if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
      return p;
    } catch (_) {
      return null;
    }
  }

  _log(...args) {
    try { console.log('[WorkshopWorker]', ...args); } catch (_) {}
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdle(ms = IDLE_MS) {
    this._clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this._shutdown();
    }, ms);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _spawn() {
    // Reuse a live worker; if the previous one is shutting down (release() /
    // idle teardown already ran), abandon it and start a fresh process.
    if (this.child && !this.releasing) return this.child;
    if (this.child) {
      const dying = this.child;
      this.child = null;
      try { dying.kill(); } catch (_) { /* gone */ }
    }
    const script = this._scriptPath();
    if (!fs.existsSync(script)) {
      throw Object.assign(new Error(`workshop worker not found: ${script}`), { code: 'STEAM_UNAVAILABLE' });
    }
    const libPath = this._libPath();
    if (!libPath) {
      throw Object.assign(new Error('steamworks.js not resolvable'), { code: 'STEAM_UNAVAILABLE' });
    }
    this._log(`spawning worker script=${script} lib=${libPath} app=${this.appId}`);
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        STEAM_WORKSHOP_LIB: libPath,
        STEAM_WORKSHOP_APP_ID: String(this.appId),
      },
    });
    this.child = child;
    this.releasing = false;
    this.outBuf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    // A write racing the worker's exit surfaces as an async EPIPE on stdin.
    child.stdin.on('error', () => { /* worker already gone */ });
    child.stderr.on('data', (data) => {
      const line = String(data).trim();
      if (line) this._log(line);
    });
    child.on('error', (err) => this._onExit(child, null, err));
    child.on('exit', (code) => this._onExit(child, code));
    return child;
  }

  _onData(chunk) {
    this.outBuf += chunk;
    let idx;
    while ((idx = this.outBuf.indexOf('\n')) >= 0) {
      const line = this.outBuf.slice(0, idx).trim();
      this.outBuf = this.outBuf.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      this._log('ignoring malformed line:', line.slice(0, 200));
      return;
    }
    const entry = msg && msg.id != null ? this.pending.get(msg.id) : null;
    if (!entry) return;
    if (msg.type === 'progress') {
      if (typeof entry.onProgress === 'function') {
        try { entry.onProgress(msg.value || {}); } catch (_) {}
      }
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'error') {
      const err = Object.assign(new Error((msg.error && msg.error.message) || 'WORKER_ERROR'), {
        code: (msg.error && msg.error.code) || 'UPLOAD_FAILED',
      });
      entry.reject(err);
    } else {
      entry.resolve(msg.value);
    }
    if (this.pending.size === 0) this._scheduleIdle();
  }

  _onExit(child, code, err) {
    // Ignore the exit of a worker we already abandoned (replaced on respawn).
    if (this.child !== child) return;
    this.child = null;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const wasReleasing = this.releasing;
    this.releasing = false;
    if (this.pending.size) {
      const entries = Array.from(this.pending.values());
      this.pending.clear();
      for (const entry of entries) {
        entry.reject(Object.assign(
          new Error(err ? err.message : `workshop worker exited (code ${code})`),
          { code: 'STEAM_UNAVAILABLE' },
        ));
      }
    }
    this._clearIdle();
    if (!wasReleasing && child && err) {
      this._log('spawn error:', err.message);
    } else if (!wasReleasing && code !== 0 && code != null) {
      this._log(`worker exited with code ${code}`);
    }
  }

  _shutdown() {
    const child = this.child;
    if (!child) return;
    this.releasing = true;
    this._clearIdle();
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
      }
    } catch (_) { /* already gone */ }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.child === child && !child.killed) {
        try { child.kill(); } catch (_) { /* gone */ }
      }
    }, EXIT_KILL_MS);
    if (this.killTimer.unref) this.killTimer.unref();
  }

  _request(op, payload, onProgress) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn();
      } catch (err) {
        reject(err);
        return;
      }
      this._clearIdle();
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(Object.assign(new Error(err.message), { code: 'STEAM_UNAVAILABLE' }));
      }
    });
  }

  // ── Public ops (same shape as the in-process implementation in
  //  steam-workshop.js) ──────────────────────────────────────────────────────

  async availability() {
    try {
      return await this._request('availability', {});
    } catch (err) {
      return {
        available: false,
        appId: String(this.appId || ''),
        reason: (err && err.code) || 'STEAM_UNAVAILABLE',
        author: '',
      };
    }
  }

  getItem(publishedFileId) {
    return this._request('getItem', { publishedFileId: String(publishedFileId) });
  }

  missing(publishedFileId) {
    return this._request('missing', { publishedFileId: String(publishedFileId) });
  }

  createItem() {
    return this._request('createItem', {});
  }

  updateItem(publishedFileId, details, onProgress) {
    return this._request('updateItem', {
      publishedFileId: String(publishedFileId),
      details,
    }, onProgress);
  }

  // Call after a high-level operation so the Steam client does not outlive it.
  release() {
    if (!this.child) return;
    if (this.pending.size) return; // a later _onLine reschedules
    this._scheduleIdle(RELEASE_GRACE_MS);
  }

  dispose() {
    this._clearIdle();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (!this.child) return;
    this._shutdown();
  }
}

module.exports = new SteamWorkshopBridge();

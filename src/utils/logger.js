/**
 * Persistent file logger for AC27 Editor.
 * At startup, redirects console.log / console.error to also write to a dated log file.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let logStream = null;

function initLogger() {
  // Determine log directory: {userData}/logs/
  const logsDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const logFile = path.join(logsDir, `editor_${dateStamp()}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const rawLog = console.log.bind(console);
  const rawErr = console.error.bind(console);

  const writeLine = (level, args) => {
    const ts = timestamp();
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
    const line = `[${ts}] [${level}] ${msg}`;
    rawLog(line);
    if (logStream) {
      logStream.write(line + '\n');
    }
  };

  console.log = (...args) => writeLine('INFO', args);
  console.error = (...args) => writeLine('ERROR', args);
  console.warn = (...args) => writeLine('WARN', args);

  // Also capture uncaught exceptions
  process.on('uncaughtException', (err) => {
    writeLine('FATAL', ['Uncaught exception:', err.message, err.stack]);
  });

  console.log('=== Logger initialized ===');
  console.log('Log file:', logFile);
  return logFile;
}

function timestamp() {
  const d = new Date();
  return d.toISOString();
}

function dateStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function closeLogger() {
  if (logStream) {
    console.log('=== Logger closing ===');
    logStream.end();
  }
}

module.exports = { initLogger, closeLogger };

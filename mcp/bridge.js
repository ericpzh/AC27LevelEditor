/**
 * MCP stdio↔HTTP bridge for AC27 Editor
 *
 * Launched by Claude Code via stdio. Reads JSON-RPC from stdin,
 * relays to the editor's HTTP API, writes responses to stdout.
 *
 * Usage: node mcp/bridge.js
 *
 * Zero npm dependencies. Requires the editor to be running
 * (API server auto-starts on 127.0.0.1:31415).
 */
const http = require('http');
const readline = require('readline');

const API = 'http://127.0.0.1:31415/mcp';

const rl = readline.createInterface({ input: process.stdin });

process.stderr.write('[ac27-mcp] Bridge ready, API: ' + API + '\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (!msg || msg.jsonrpc !== '2.0') return;

  const body = JSON.stringify(msg);
  const req = http.request(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (e) {
        process.stderr.write('[ac27-mcp] Invalid JSON response: ' + data.substring(0, 200) + '\n');
      }
    });
  });
  req.on('error', (err) => {
    process.stderr.write('[ac27-mcp] HTTP error: ' + err.message + '\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: 'Editor not reachable: ' + err.message },
    }) + '\n');
  });
  req.write(body);
  req.end();
});

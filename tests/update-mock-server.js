/**
 * Mock update server for local testing of the auto-update feature.
 *
 * Mimics the Cloudflare Worker endpoints:
 *   HEAD /editor  → returns ETag + Last-Modified headers
 *   GET /editor   → streams a dummy exe file
 *
 * Usage:
 *   node tests/update-mock-server.js
 *
 * Then launch the app with:
 *   AC27_UPDATE_SERVER=http://localhost:9999 npm run dev
 *
 * The mock always returns an ETag that differs from any real exe,
 * so the update prompt should always appear when using this server.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '9999', 10);

// Generate a dummy "exe" — just random bytes so its MD5 differs from any real build
const DUMMY_SIZE = 1024; // 1 KB — tiny for fast testing
const dummyBuffer = crypto.randomBytes(DUMMY_SIZE);
const DUMMY_MD5 = crypto.createHash('md5').update(dummyBuffer).digest('hex');
const DUMMY_DATE = new Date().toUTCString();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Normalize the URL — strip query string, trailing slash
  const url = req.url.split('?')[0].replace(/\/$/, '');

  if (url === '' || url === '/editor') {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': DUMMY_SIZE,
        'ETag': '"' + DUMMY_MD5 + '"',
        'Last-Modified': DUMMY_DATE,
        'Accept-Ranges': 'bytes',
      });
      res.end();
      console.log('[mock] HEAD /editor → etag=' + DUMMY_MD5.substring(0, 8) + '...');
    } else {
      // GET — stream the dummy exe
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': DUMMY_SIZE,
        'ETag': '"' + DUMMY_MD5 + '"',
        'Last-Modified': DUMMY_DATE,
        'Content-Disposition': 'attachment; filename="AC27Editor.exe"',
      });
      res.end(dummyBuffer);
      console.log('[mock] GET /editor → ' + DUMMY_SIZE + ' bytes');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  const localMd5 = ' (compares against ' + DUMMY_MD5.substring(0, 8) + '...)';
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   AC27 Update Mock Server                       ║');
  console.log('║   http://localhost:' + PORT + '                          ║');
  console.log('║   ETag (MD5): ' + DUMMY_MD5.substring(0, 8) + '...' + '               ║'.replace(/^.{40}/, ''));
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('Launch the app with:');
  console.log('  set AC27_UPDATE_SERVER=http://localhost:' + PORT + ' && npm run dev');
  console.log('  set AC27_UPDATE_DRY_RUN=1 (optional — skips actual script spawn)');
  console.log('');
});

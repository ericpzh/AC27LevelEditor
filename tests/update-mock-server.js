/**
 * Mock update server for local testing of the auto-update feature.
 *
 * Mimics the Cloudflare Worker endpoint on a single route:
 *   HEAD /editor → returns ETag + Last-Modified headers
 *   GET /editor  → streams a dummy exe file
 *
 * Both variants share the same route; the Worker (and this mock) select which
 * R2 objects to use from the X-AC27-Variant request header:
 *   normal → AC27Editor.exe(.md5)
 *   voice  → AC27EditorVoice.exe(.md5)
 *
 * Usage:
 *   node tests/update-mock-server.js
 *
 * Then launch the app with:
 *   AC27_UPDATE_SERVER=http://localhost:9999 npm run dev
 *
 * Note: the real updater only speaks https (ERR_INVALID_PROTOCOL on plain
 * http), so this plain-http mock can't drive the real update flow end-to-end —
 * it's for curl/prototyping or wiring into a TLS wrapper. See
 * mods/docs/cloudflare-worker-routes.md for the live Worker script.
 *
 * The mock always returns an ETag that differs from any real exe,
 * so the update prompt should always appear when using this server.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '9999', 10);

// Generate dummy "exe"s — just random bytes so their MD5s differ from any real build
const DUMMY_SIZE = 1024; // 1 KB — tiny for fast testing
const VARIANTS = {
  normal: { exe: 'AC27Editor.exe', label: '/editor', file: crypto.randomBytes(DUMMY_SIZE) },
  voice: { exe: 'AC27EditorVoice.exe', label: '/editor (voice)', file: crypto.randomBytes(DUMMY_SIZE) },
};
for (const key of Object.keys(VARIANTS)) {
  VARIANTS[key].md5 = crypto.createHash('md5').update(VARIANTS[key].file).digest('hex');
  VARIANTS[key].date = new Date().toUTCString();
}

function serveExe(req, res, variant) {
  const { exe, label, file } = variant;
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': DUMMY_SIZE,
      'ETag': '"' + variant.md5 + '"',
      'Last-Modified': variant.date,
      'Accept-Ranges': 'bytes',
    });
    res.end();
    console.log('[mock] HEAD ' + label + ' → etag=' + variant.md5.substring(0, 8) + '...');
  } else {
    // GET — stream the dummy exe
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': DUMMY_SIZE,
      'ETag': '"' + variant.md5 + '"',
      'Last-Modified': variant.date,
      'Content-Disposition': 'attachment; filename="' + exe + '"',
    });
    res.end(file);
    console.log('[mock] GET ' + label + ' → ' + DUMMY_SIZE + ' bytes');
  }
}

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
    const variant = VARIANTS[String(req.headers['x-ac27-variant'] || 'normal').toLowerCase()] || VARIANTS.normal;
    serveExe(req, res, variant);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   AC27 Update Mock Server                       ║');
  console.log('║   http://localhost:' + PORT + '                          ║');
  console.log('║   /editor (X-AC27-Variant: normal|voice)        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('Launch the app with:');
  console.log('  set AC27_UPDATE_SERVER=http://localhost:' + PORT + ' && npm run dev');
  console.log('  set AC27_UPDATE_DRY_RUN=1 (optional — skips actual script spawn)');
  console.log('');
});
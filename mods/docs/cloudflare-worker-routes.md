# Cloudflare Worker routes — downloads + auto-update (`/livery` + `/ac27approach` + `/editor`)

The editor ships no distributables for the livery or the AC27Approach plugin
DLL — both are fetched on demand from R2 through a Cloudflare Worker edge
route. The **exe auto-updater** also runs through the same Worker (`/editor`
routes). This file documents the infrastructure. The mirror-image in-app flows
are: the **Browser→Livery** button (BrowserScreen), the **Flight Strips →
Load DLL** tray button (FlightStripsWindow), and the **auto-update** check
(`electron/updater.js`).

## Architecture

One R2 bucket, all served through the Worker:

```
R2 bucket ac27editor           (public pub-e010b52dac3747868ec310113e11ca1a.r2.dev)
   ├── livery.zip              ← uploaded manually (or by a build script)
   ├── AC27Editor.exe          ← uploaded by the release workflow (build-windows)
   ├── AC27Editor.exe.md5      ← "          "        (sidecar — real MD5, the ETag source)
   ├── AC27EditorVoice.exe     ← "          "        (voice build)
   └── AC27EditorVoice.exe.md5 ← "          "        (voice sidecar)

R2 bucket ac27approach         (public pub-3cf0a07576984a6b82374a2bbc597e59.r2.dev)
   └── AC27Approach.dll        ← uploaded by the release workflow (build-plugin)

https://ericpzh.rest (Worker, route free.ts)
   /livery         → fetch R2 ac27editor/livery.zip, force attachment download
   /editor         → exe auto-update — BOTH variants on this ONE route; the
                     Worker picks the objects by the X-AC27-Variant request
                     header (normal → AC27Editor.exe(.md5), voice →
                     AC27EditorVoice.exe(.md5))
   /ac27approach*  → fetch R2 ac27approach/AC27Approach.dll, force attachment download
   everything else → pass through to the origin site (fetch(request))
```

The Worker only ever returns a `Response` — the editor downloads with
`https.get`, follows the Worker's redirects (≤5) and reads `content-length`
for the progress bar.

## In-app consumers

| Feature | Endpoint | IPC | Install target |
|---|---|---|---|
| Livery | `https://ericpzh.rest/livery` | `download-livery` → `install-livery` | `<gameRoot>/Mods` (zip extract) |
| Plugin DLL | `https://ericpzh.rest/ac27approach` | `download-approach-dll` → `install-approach-dll` | `<gameRoot>/BepInEx/plugins/AC27Approach.dll` |

Both flows are download-first, with a fall back to a local file picker
(`select-livery-zip` / `load-approach-dll`) when the Worker is unreachable.
`electron/main.js` pins `APPROACH_DLL_DOWNLOAD_URL = 'https://ericpzh.rest/ac27approach'`
(the Worker route — keep it in sync with the deployment here).

## Plugin version check (ETag = MD5)

`check-command-capability` gates the voice/composer UI on the installed plugin
matching the latest release. Versioning is zero-infra: the R2 object's ETag
**is** the build's MD5 for single-part uploads (verified equal to
`Get-FileHash`), and Cloudflare passes the ETag header through the Worker
proxy unchanged. So a `HEAD` to `APPROACH_DLL_DOWNLOAD_URL` returns the remote
build's MD5, compared against the locally installed
`<gameRoot>/BepInEx/plugins/AC27Approach.dll`.

- Mismatch → `pluginUpToDate:false` → PTT/composer hidden, Load-DLL install
  button shown (with an "update available" note).
- Remote fetch fails (offline) → `pluginUpToDate:null` → treated as OK, so a
  working plugin is never blocked by a dead network.
- ⚠ This relies on the ETag being the file MD5. `aws s3 cp` of a small DLL is
  a single-part PUT so the ETag is the MD5 — if the DLL ever exceeds the
  ~8 MB multipart threshold (or is re-uploaded via multipart), switch to an
  explicit `.md5` sidecar like the exe updater uses.

## Editor auto-update delivery (one `/editor` route, both variants)

The portable-windows updater (`electron/updater.js`) checks on launch:

- **Normal build** (`AC27Editor.exe`, no voice assets) HEADs
  `https://ericpzh.rest/editor` with `X-AC27-Variant: normal` and asks the
  Worker to return the real MD5 from the `AC27Editor.exe.md5` sidecar **as the
  ETag header**. The updater compares it against its own computed MD5 — differ
  → update prompt. `GET /editor` streams `AC27Editor.exe` (`content-length`
  drives the download progress bar).
- **Voice build** (`AC27EditorVoice.exe`) uses the **same URL** but sends
  `X-AC27-Variant: voice` — `updater.variantHeader()` sets the header whenever
  it detects the voice resources (`resources/voice-stt-vosk.js`, see
  `isVoiceBuild()`/`variantName()`). The Worker then compares against
  `AC27EditorVoice.exe.md5` and downloads `AC27EditorVoice.exe`.

The `.md5` sidecar is authoritative for **both** variants: R2's own ETag is
only the MD5 for single-part uploads, and the voice exe (~1.9 GB with the vosk
models) is always a multipart upload. The sidecar sidesteps that entirely.

⚠ **The header-to-Etag binding is what keeps the variants apart.** A voice
build that sent no/`normal` header would get the normal exe's MD5 (never equal
— phantom "update available") and `GET` would download the wrong build. Also
remember: if you swap the layout later, a worker route that can't reach one
exe returns no ETag → the updater treats that as "server unavailable", not
"update available".

Deploy the `/editor` block with the rest of the Worker (below). The
`AC27EditorVoice.exe` + `.md5` objects are uploaded by the release workflow
alongside the normal exe (see "Publishing the exes").

## Worker script

The same Worker serves all routes (the `/ac27approach` block is live at
`ericpzh.rest/ac27approach*` — any suffix, e.g. `/ac27approach.dll`, is served):

```js
// HARDCODED — R2 public r2.dev URL (read-only, no auth needed)
const R2 = 'https://pub-e010b52dac3747868ec310113e11ca1a.r2.dev';

// Pick the variant's R2 objects from the request header:
//   X-AC27-Variant: normal → AC27Editor.exe(.md5)
//   X-AC27-Variant: voice  → AC27EditorVoice.exe(.md5)
function variantObjects(request) {
  const isVoice = (request.headers.get('x-ac27-variant') || '').toLowerCase() === 'voice';
  return isVoice
    ? { exe: 'AC27EditorVoice.exe', md5: 'AC27EditorVoice.exe.md5' }
    : { exe: 'AC27Editor.exe', md5: 'AC27Editor.exe.md5' };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── HEAD /editor → proxy to R2, augment ETag with real MD5 ──
    // Serves whichever variant the X-AC27-Variant header asks for.
    if (url.pathname === '/editor' && request.method === 'HEAD') {
      const obj = variantObjects(request);
      const [head, md5Resp] = await Promise.all([
        fetch(`${R2}/${obj.exe}`, { method: 'HEAD' }),
        fetch(`${R2}/${obj.md5}`),
      ]);
      if (!head.ok) return new Response('Not Found', { status: 404 });
      const realMd5 = md5Resp.ok ? (await md5Resp.text()).trim() : null;
      return new Response(null, {
        status: 200,
        headers: {
          'etag': realMd5 || head.headers.get('etag') || '',
          'last-modified': head.headers.get('last-modified') || '',
          'content-length': head.headers.get('content-length') || '0',
          'accept-ranges': 'bytes',
          'access-control-expose-headers': 'etag, last-modified, content-length',
        },
      });
    }

    // ── GET /editor → proxy the download (variant per header) ──
    if (url.pathname === '/editor') {
      const obj = variantObjects(request);
      const resp = await fetch(`${R2}/${obj.exe}`);
      if (!resp.ok) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      headers.set('Content-Disposition', `attachment; filename="${obj.exe}"`);
      headers.set('ETag', resp.headers.get('etag') || '');
      headers.set('Content-Type', 'application/vnd.microsoft.portable-executable');
      // PASS Content-Length THROUGH. Without it Cloudflare streams the body
      // chunked, and large (multi-hundred-MB) chunked Worker streams sometimes
      // terminate early — the editor would get a silently truncated exe.
      // An explicit length makes the edge stream exactly N bytes (the updater
      // also re-verifies received === content-length before accepting).
      const cl = resp.headers.get('content-length');
      if (cl) headers.set('Content-Length', cl);
      return new Response(resp.body, { headers });
    }

    // ── All other requests → your normal site ──
    return fetch(request);
  },
};
```

Deploy: paste into the dashboard editor or `wrangler deploy free.ts`, with a
route of `ericpzh.rest/ac27approach*` (and `/livery` + `/editor` for the other
blocks). The script needs no bindings — it fetches the R2 object through the
bucket's **public** URL. Keep the `Content-Disposition` header (the editor
keys off the filenames it writes itself, but attachment semantics make curl
downloads / browsers behave).

⚠ **The /editor route never fell through when untested.** Verify after
deploying that `curl -I` with the voice header returns the voice sidecar MD5
(see the verification one-liner in the next section). A fresh Worker deploy
with no matching route passes straight through to the origin site (an HTML
200 with no ETag), which the updater reads as "server unavailable" — silent
no-update, which is easy to mistake for a working check.

## R2 side

- **Bucket `ac27approach`** (the plugin DLL; public access — the Worker relies
  on the `pub-<id>.r2.dev` hosting URL):
  - Public URL: `https://pub-3cf0a07576984a6b82374a2bbc597e59.r2.dev`
  - S3 (PUT) endpoint: `https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com`
  - Object: `AC27Approach.dll`
- **Bucket `ac27editor`** (livery + exe auto-update; public
  `https://pub-e010b52dac3747868ec310113e11ca1a.r2.dev` — the URL the live
  Worker pins as `R2`):
  - Objects: `livery.zip`, `AC27Editor.exe`, `AC27Editor.exe.md5`,
    `AC27EditorVoice.exe`, `AC27EditorVoice.exe.md5`
- **⚠ R2/S3 object keys are case-sensitive.** The workflow uploads
  `AC27Approach.dll` (uppercase) and the Worker must fetch the exact same
  key — a lowercase `ac27approach.dll` fetch 404s (an `Object not found`
  page), which surfaces in the editor as `DL_DOWNLOAD_HTTP_404` and triggers
  the file-dialog fallback. Same rule for the `.md5` / exe sidecars: the
  Worker's `variantObjects` builds `AC27Editor.exe.md5` /
  `AC27EditorVoice.exe.md5` with the exact casing of the bucket objects.
- **Verify after deploying** — the variant header must select the right sidecar:
  ```bash
  curl -sI -H "X-AC27-Variant: normal" https://ericpzh.rest/editor   # etag == AC27Editor.exe.md5
  curl -sI -H "X-AC27-Variant: voice"  https://ericpzh.rest/editor   # etag == AC27EditorVoice.exe.md5
  ```
  (Known good sidecar values: normal `97b1d9c4524e2cf0246690e252ece52d`,
  voice `6ba76b1381da173906f8755b2dcfb917`.)
- **Permissions:** one R2 Access Key ID / Secret with `PutObject` on both
  buckets, stored as the `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` GitHub secrets used by `.github/workflows/release.yml`.

## Publishing the exes (release workflow)

`build-windows` in `.github/workflows/release.yml` builds **both** portable
variants and uploads each with its `.md5` companion to the shared
`ac27editor` bucket — so every release carries a fresh auto-update source for
the normal and voice editions:

```yaml
- name: Upload to R2 (auto-update — both variants, same bucket)
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    AWS_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT_URL }}
    AWS_REGION: auto
  run: |
    aws s3 cp release/AC27Editor.exe s3://ac27editor/AC27Editor.exe --endpoint-url "$env:AWS_ENDPOINT_URL" --region auto
    $hash = (Get-FileHash -Path release/AC27Editor.exe -Algorithm MD5).Hash.ToLower()
    $hash | Out-File -NoNewline -Encoding ASCII md5.txt
    aws s3 cp md5.txt s3://ac27editor/AC27Editor.exe.md5 --endpoint-url "$env:AWS_ENDPOINT_URL" --region auto --content-type "text/plain"
    aws s3 cp release/AC27EditorVoice.exe s3://ac27editor/AC27EditorVoice.exe --endpoint-url "$env:AWS_ENDPOINT_URL" --region auto
    $voiceHash = (Get-FileHash -Path release/AC27EditorVoice.exe -Algorithm MD5).Hash.ToLower()
    $voiceHash | Out-File -NoNewline -Encoding ASCII voice-md5.txt
    aws s3 cp voice-md5.txt s3://ac27editor/AC27EditorVoice.exe.md5 --endpoint-url "$env:AWS_ENDPOINT_URL" --region auto --content-type "text/plain"
```

Both exes are also attached to the GitHub Release (the `release/*.exe` upload
step), and both `.md5` sidecars are written as raw lowercase hex with no
trailing newline — the Worker returns them verbatim as the ETag.

## Publishing the DLL (release workflow)

`build-plugin` in `.github/workflows/release.yml` builds the plugin and then
uploads it straight to the `ac27approach` bucket so every release carries a
fresh auto-installable DLL:

```yaml
- name: Upload plugin DLL to R2 (strips-window auto-install source)
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    AWS_ENDPOINT_URL: https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com
    AWS_REGION: auto
  run: |
    aws s3 cp mods/AC27Approach/bin/Release/net6.0/AC27Approach.dll s3://ac27approach/AC27Approach.dll --endpoint-url "$env:AWS_ENDPOINT_URL" --region auto
```

The DLL is also attached to the GitHub Release manually as before — the R2
copy is the source the editor's Load DLL button pulls from.

## Updating livery.zip

`livery.zip` is not produced by CI. Upload it to the `ac27editor` bucket when
the livery pack changes:

```bash
aws s3 cp livery.zip s3://ac27editor/livery.zip \
  --endpoint-url "https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com" \
  --region auto
```
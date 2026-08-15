# Cloudflare Worker routes — R2 downloads (`/livery` + `/ac27approach`)

The editor ships no distributables for the livery or the AC27Approach plugin
DLL — both are fetched on demand from R2 through a Cloudflare Worker edge
route. This file documents the infrastructure. The mirror-image in-app flows
are: the **Browser→Livery** button (BrowserScreen) and the **Flight Strips →
Load DLL** tray button (FlightStripsWindow).

## Architecture

Two R2 buckets, two Worker routes:

```
R2 bucket ac27editor           (public pub-eff366ba6c31470087fb1c73eac00f53.r2.dev)
   └── livery.zip              ← uploaded manually (or by a build script)

R2 bucket ac27approach         (public pub-3cf0a07576984a6b82374a2bbc597e59.r2.dev)
   └── AC27Approach.dll        ← uploaded by the release workflow (build-plugin)

https://ericpzh.rest (Worker, route free.ts)
   /livery        → fetch R2 ac27editor/livery.zip, force attachment download
   /ac27approach* → fetch R2 ac27approach/AC27Approach.dll, force attachment download
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

## Worker script

The same Worker serves both routes (the `/ac27approach` block is live at
`ericpzh.rest/ac27approach*` — any suffix, e.g. `/ac27approach.dll`, is served):

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Livery (bucket ac27editor) ────────────────────────────────────
    if (url.pathname === '/livery' || url.pathname === '/livery.zip') {
      const r2Url = 'https://pub-eff366ba6c31470087fb1c73eac00f53.r2.dev/livery.zip';
      const response = await fetch(r2Url);
      const headers = new Headers(response.headers);
      headers.set('Content-Disposition', 'attachment; filename="livery.zip"');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ── AC27Approach plugin DLL (bucket ac27approach) ────────────────
    if (url.pathname.startsWith('/ac27approach')) {
      const r2Url = 'https://pub-3cf0a07576984a6b82374a2bbc597e59.r2.dev/AC27Approach.dll';
      const response = await fetch(r2Url);
      const headers = new Headers(response.headers);
      headers.set('Content-Disposition', 'attachment; filename="AC27Approach.dll"');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // IMPORTANT: If they visit any other page, let your normal website load
    return fetch(request);
  },
};
```

Deploy: paste into the dashboard editor or `wrangler deploy free.ts`, with a
route of `ericpzh.rest/ac27approach*` (and `/livery` for the other block).
The script needs no bindings — it fetches the R2 object through the bucket's
**public** URL. Keep the `Content-Disposition` header (the editor keys off
the filenames it writes itself, but attachment semantics make curl
downloads / browsers behave).

## R2 side

- **Bucket `ac27approach`** (the plugin DLL; public access — the Worker relies
  on the `pub-<id>.r2.dev` hosting URL):
  - Public URL: `https://pub-3cf0a07576984a6b82374a2bbc597e59.r2.dev`
  - S3 (PUT) endpoint: `https://66f99fd03d3228c43e0acb85f7b8298f.r2.cloudflarestorage.com`
  - Object: `AC27Approach.dll`
- **Bucket `ac27editor`** (livery + exe auto-update; public
  `https://pub-eff366ba6c31470087fb1c73eac00f53.r2.dev`):
  - Object: `livery.zip`
- **⚠ R2/S3 object keys are case-sensitive.** The workflow uploads
  `AC27Approach.dll` (uppercase) and the Worker must fetch the exact same
  key — a lowercase `ac27approach.dll` fetch 404s (an `Object not found`
  page), which surfaces in the editor as `DL_DOWNLOAD_HTTP_404` and triggers
  the file-dialog fallback.
- **Permissions:** one R2 Access Key ID / Secret with `PutObject` on the
  `ac27approach` bucket, stored as the `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` GitHub secrets used by `.github/workflows/release.yml`.

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
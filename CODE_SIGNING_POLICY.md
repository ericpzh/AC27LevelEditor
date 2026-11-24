# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Team roles and members

- **Committers and reviewers:** [@ericpzh](https://github.com/ericpzh) (all external contributions are submitted via pull requests and reviewed before merging)
- **Approvers:** [@ericpzh](https://github.com/ericpzh) (every release signing request requires manual approval)

All team accounts use multi-factor authentication (MFA) on both GitHub and SignPath.

## Build and signing process

- Official signed releases are built directly from public source code on GitHub-hosted runners via [`.github/workflows/release.yml`](.github/workflows/release.yml) for tagged releases (`v*`).
- Local developer builds are never signed with the SignPath Foundation certificate.
- Every release signing request is reviewed and manually approved before signed binaries are published to GitHub Releases, Cloudflare R2, or Steam Workshop.

## Privacy policy

AC27 Editor operates locally on your Airport Control 27 game files and does not collect telemetry, analytics, or personal data.

### Automatic network requests

- **Startup update check (Windows standalone builds only):** When launched on Windows (non-Workshop builds), the editor sends a lightweight HTTP `HEAD` request to `https://ericpzh.rest/editor` (hosted on Cloudflare Workers / R2) to compare the MD5 hash of the installed executable against the latest release. No personal data or usage telemetry is sent, and downloading or installing an update only occurs if you explicitly confirm it.
  - To disable this automatic check, set the environment variable `AC27_DISABLE_AUTO_UPDATE=1`, or use the Steam Workshop / macOS / Linux builds where the built-in updater is disabled.

### User-initiated network requests

All other network communication occurs **only when explicitly triggered by the user**:

- **Live weather (METAR) import:** Fetches public aviation weather data from `https://aviationweather.gov/api/data/metar`.
- **Real-world schedule import (optional):** Queries `https://api.aviationstack.com` using a user-provided API key.
- **AI / Voice assistant features (optional):** Sends user prompts to the user-selected LLM provider (OpenAI, Anthropic, Google Gemini, or DeepSeek) using the user's own API key.
- **Optional one-click mod downloads:** Downloads BepInEx IL2CPP (`builds.bepinex.dev` / `thunderstore.io`), the AC27Approach plugin DLL (`https://ericpzh.rest/ac27approach`), or the realistic livery pack (`https://ericpzh.rest/livery`) when clicked by the user.
- **Steam Workshop publishing (optional):** Uploads user-created liveries to Steam Workshop through the local Steam client when the user clicks **Upload**.

When you use these optional features, your requests are also subject to the respective privacy policies of those third-party services (Cloudflare, Valve/Steam, AviationWeather.gov, AviationStack, Thunderstore/BepInEx, and any LLM provider you choose to configure).

## License

AC27 Editor is open-source software licensed under the [MIT License](LICENSE).

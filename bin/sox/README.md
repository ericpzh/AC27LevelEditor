# bin/sox — vendored sox (sox_ng) Windows x64 build

`sox.exe` is a **static 64-bit Windows build of sox_ng 14.8.0.1** (GPL-2.0),
downloaded from the official sox_ng Codeberg release:

- https://codeberg.org/sox_ng/sox_ng/releases/tag/sox_ng-14.8.0.1
- Asset: `sox_ng-14.8.0.1-win64-exe.zip` → `sox_ng.exe` renamed to `sox.exe`

The binary is 100% static (no DLL dependencies — maintained by sox_ng for
Windows). The original sox 14.4.2 (2015) SourceForge build was rejected:
SourceForge blocks scripted downloads, and the coqui-ai GitHub mirror build is
MSYS-dependent (fails with "error while loading shared libraries").

Used for **microphone capture only** — the Windows `waveaudio` driver captures
the *system default* recording device ("Microsoft Wave Mapper"):

```
sox.exe --no-show-progress -t waveaudio default -t raw -r 16000 -c 1 -e signed-integer -b 16 -
```

sox resamples/mixes the device's native format to 16 kHz mono S16LE raw PCM on
stdout, which is fed to the vosk recognizer (`electron/voskFfi.js`). The voice
worker child spawns it via `electron/voice-stt-vosk.js`; the loader finds it
through `VOSK_SOX_PATH` → packaged `resources/sox/sox.exe` → repo `bin/sox/`.

Update procedure: grab the newest win64-exe zip from the sox_ng Codeberg
releases page, replace `sox.exe`, and re-run
`node scripts/voice-stt-test.mjs` (round-trip) plus a manual PTT check.

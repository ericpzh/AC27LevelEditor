# bin/vosk — vendored vosk win64 binaries

Windows x64 runtime DLLs for Vosk 0.3.39, extracted from the official npm tarball
`vosk@0.3.39` (Apache-2.0, https://github.com/alphacep/vosk-api).

| File | Source |
| --- | --- |
| `libvosk.dll` | `lib/win-x86_64/libvosk.dll` (26 MB, Kaldi-based recognizer) |
| `libgcc_s_seh-1.dll` | MinGW runtime (GCC SEH) |
| `libstdc++-6.dll` | MinGW C++ runtime |
| `libwinpthread-1.dll` | MinGW pthread runtime |

Vendor reason: the `vosk` npm package's JS wrapper depends on `ffi-napi`/`ref-napi`,
whose prebuilt binaries are compiled against N-API 10 and cannot load under
Electron 33's bundled Node (N-API 9), and whose `node-gyp-build` install script
crashes on process teardown (`Assertion failed: 0, src\win\handle.c, line 71`).
Instead the editor loads `libvosk.dll` directly through **koffi**
(`electron/voskFfi.js`), an N-API 8 FFI library that works on both N-API 9
(Electron) and N-API 10 (Node 24) without any native compilation.

These DLLs are MinGW-built; the Windows loader resolves them from the directory
prepended to `PATH` when the voice worker child is spawned (`VOICE_RESOURCES` /
`VOSK_LIB_DIR` handling in `electron/voiceSttWorker.js` and
`electron/voice-stt-vosk.js`).

Update procedure: `npm pack vosk@<version>`, extract
`package/lib/win-x86_64/*.dll` into this directory, update the table above, and
re-run the round-trip harness (`node scripts/voice-stt-test.mjs`) plus the
packaged `--test` smoke.

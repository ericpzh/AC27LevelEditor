# v3 save test error report

Date: 2026-11-12

## Findings

1. **No-change save blocked by runway validation.** The Electron save sweep opened the installed `ZGSZ_runwaychange.acl` in a staged copy and cancelled the save after reporting two issues: `CSS4255` lands on runway `15` at `10:35:41` while active runways are `33, 34L, 34R`; `CES5751` lands on `33` at `11:24:43` while active runways are `15, 16L, 16R`. The test marks this as skipped, so the overall suite passed despite not verifying this save. Determine whether the level data or the runway validation/timeline interpretation is responsible.
2. **Flight fuzz suite timed out.** With `FUZZ_SEED=20261112`, 20 of 24 levels completed successfully. The 21st, `ZGSZ_runwaychange`, was interrupted by Playwright's 3,600,000 ms test timeout; its closed-page error followed the timeout. The remaining three levels were not reached. This is a test execution timeout, not evidence of a save defect in that case.
3. **Ground fuzz sandbox guard triggered.** The ground suite started after the flight timeout and its first case resolved to the live game level path rather than the staged root. The guard refused to fuzz it. The run was stopped at the user's request; no ground-fuzz save was performed. Investigate test process/API isolation before rerunning.

## Results

- `npm run test:all`: exit 0. Vitest: 2,778 passed, 6 skipped across 155 passed and one skipped test file. Save integrity: 27 installed production/demo files passed; jetway rebuild: 27 passed; runway extraction: 7 passed. Build succeeded. Playwright: 16 passed, 2 fuzz tests skipped by default. The 24-level Electron save sweep counted 23 passed and one validation-blocked skip (above).
- Focused `tests/acl/v3_save_preservation.test.js`: 13 passed.
- v3 fixture binary round-trip: 39 assertions passed across 13 files.
- Flight fuzz: 20 completed passes, timeout on case 21; seed base `20261112`, replacement disabled.
- Ground fuzz: first case rejected by sandbox guard; stopped, incomplete.

The tests do not establish that rebuilt saves load successfully in the game itself. Full logs: `%TEMP%/ac27-v3-test-all.log`, `%TEMP%/ac27-v3-preservation.log`, `%TEMP%/ac27-v3-roundtrip.log`, `%TEMP%/ac27-v3-fuzz-flight.log`, and `%TEMP%/ac27-v3-fuzz-ground.log`.

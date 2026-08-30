// voice-stt-test.mjs — end-to-end STT round-trip harness for the vosk worker.
//
// (a) Synthesizes test phrases with Windows System.Speech SYNTHESIS (TTS —
//     recognition was the broken half; TTS is known-good) at 16 kHz mono
//     16-bit, the exact vosk input format:
//       en: "delta one two three heavy contact tower climb and maintain three thousand"
//       zh: "东方幺两三四 联系塔台 爬升保持三零零零"
//     (zero-digit 零 decodes reliably on the small-cn model; 洞 maps to 重.)
// (b) Spawns the worker child in --wav mode (plain node + VOICE_RESOURCES)
//     and asserts ready → ≥1 result{text,language} → stopped, plus plausible
//     tokens for each language.
//
// Usage: node scripts/voice-stt-test.mjs
// Exit: 0 pass, 1 fail, 2 SKIP (no TTS voice for a language — non-fatal).
import { spawnSync } from 'child_process';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'electron', 'voice-stt-vosk.js');

const PHRASES = {
  en: {
    text: 'delta one two three heavy contact tower climb and maintain three thousand',
    tokens: ['delta', 'one', 'two', 'three', 'maintain'],
  },
  zh: {
    text: '东方幺两三四 联系塔台 爬升保持三零零零',
    tokens: ['东', '幺', '两', '三', '四', '保'],
  },
};

function psEscape(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

function hasTtsVoice(langPrefix) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${langPrefix}*' } | Select-Object -First 1 | ForEach-Object { $_.VoiceInfo.Name }`],
      { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

/** Synthesize a phrase to a 16 kHz mono 16-bit WAV. Returns the wav path or null. */
function synthWav(lang, text) {
  if (!hasTtsVoice(lang === 'zh' ? 'zh' : 'en')) return null;
  const wav = path.join(os.tmpdir(), `voice-stt-${lang}.wav`);
  const script = [
    'Add-Type -AssemblyName System.Speech',
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${lang === 'zh' ? 'zh' : 'en'}*' } | Select-Object -First 1`,
    `$s.SelectVoice($v.VoiceInfo.Name)`,
    `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$s.SetOutputToWaveFile(${psEscape(wav)}, $fmt)`,
    `$s.Speak(${psEscape(text)})`,
    `$s.Dispose()`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    return existsSync(wav) ? wav : null;
  } catch (_) {
    return null;
  }
}

/** Run the worker --wav and return parsed JSON events. */
function runWorker(wav) {
  const res = spawnSync(process.execPath, [WORKER, '--wav', wav], {
    cwd: ROOT,
    env: { ...process.env, VOICE_RESOURCES: ROOT },
    encoding: 'utf8',
    timeout: 120000,
  });
  if (res.status !== 0) throw new Error(`worker exited ${res.status}: ${res.stderr.slice(-500)}`);
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

let failed = false;
const log = (ok, label) => {
  console.log(ok ? 'PASS' : 'FAIL', label);
  if (!ok) failed = true;
};

for (const [lang, p] of Object.entries(PHRASES)) {
  console.log(`\n=== ${lang} ===`);
  const wav = synthWav(lang, p.text);
  if (!wav) {
    console.log(`SKIP  no ${lang} TTS voice installed`);
    continue;
  }
  const events = runWorker(wav);
  const result = events.find((e) => e.type === 'result');
  log(events.some((e) => e.type === 'ready'), 'ready event');
  log(!!result, 'result event');
  log(events.some((e) => e.type === 'stopped'), 'stopped event');
  if (result) {
    log(result.language === lang, `language ${lang} (got ${result.language})`);
    const text = result.text;
    for (const t of p.tokens) log(text.includes(t), `contains ${JSON.stringify(t)} (text: ${text.slice(0, 60)})`);
  }
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);

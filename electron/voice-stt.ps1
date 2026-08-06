# voice-stt.ps1 — Windows System.Speech recognition worker for the editor's
# push-to-talk voice input. Spawned by electron/voiceSttWorker.js with
# powershell.exe (Windows PowerShell 5.1 — System.Speech is not available in
# PowerShell 7+/.NET Core).
#
# Protocol: JSON lines over stdin/stdout, UTF-8, one object per line.
#   in : {"cmd":"start"} | {"cmd":"stop"} | {"cmd":"exit"}
#   out: {"type":"ready","culture":...,"recognizers":...}
#        {"type":"started"} | {"type":"stopped"}
#        {"type":"result","text":...,"confidence":...}
#        {"type":"detected"}                       — mic audio crossed the level threshold
#        {"type":"rejected","reason":"busy"}       — start while already recognizing
#        {"type":"rejected","reason":"low-confidence"} — heard audio, no parseable phrase
#        {"type":"error","code":...,"message":...}
#
# Recognition model: SINGLE-THREADED tick loop — the SAPI engine is driven by
# the synchronous Recognize() loop (results come from the return value), and
# stdin is read via BeginRead/EndRead (genuinely async, no background thread).
# Why not async events or a thread:
#   - async recognition (RecognizeAsync + event handlers) is fragile in PS 5.1
#     — wav-input async crashed the process in testing, and cancel/restart
#     semantics are unreliable (RecognizeCompleted never fires on cancel);
#   - a raw [Threading.Thread] scriptblock never completes in PS 5.1 and a
#     live thread makes the process exit with code 2 at shutdown.
#
# Session semantics: 'start' creates a FRESH engine (SAPI is unreliable across
# cancel/restart). 'stop' sets a flag; the current phrase ALWAYS finalizes
# (EndSilenceTimeout, 1s) and its result is delivered before the session ends
# at the next phrase boundary — the PTT release can never discard a phrase, so
# the Node side sends 'stop' immediately. A 'start' while finalizing cancels
# the pending stop (press again = session continues). InitialSilenceTimeout
# (2s) bounds silent Recognize() ticks so a no-speech session stops promptly.
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File voice-stt.ps1
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File voice-stt.ps1 -Wav sample.wav
#     (CLI test mode — processes a wave file synchronously, no mic, no stdin loop)
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File voice-stt.ps1 -Mic
#     (CLI test mode — listens on the default audio device for 60s (or -MicSeconds N), then exits)

param([string]$Wav, [switch]$Mic, [int]$MicSeconds = 60, [string]$TestWav)

# ── Encoding: force UTF-8 first so Node can decode the JSON lines ──
# (PS 5.1 writes UTF-16 to redirected stdout by default; we always emit via
# [Console]::Out and never Write-Host/Write-Output, which bypass/pipe streams.)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'

$script:engine = $null
$script:recognizing = $false
$script:stopRequested = $false
$script:recognizer = $null
$script:testWav = $TestWav

function Emit($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function EmitError($code, $message) {
    Emit @{ type = 'error'; code = $code; message = $message }
}

# Fresh engine for one listening session. The caller drives it with
# synchronous Recognize() calls (see header for why).
function New-SessionEngine {
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($script:recognizer.Culture)
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1000)
    $engine.InitialSilenceTimeout = [TimeSpan]::FromMilliseconds(2000)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    if ($script:testWav) {
        $engine.SetInputToWaveFile($script:testWav)   # test-only: wav stands in for the mic
    } else {
        $engine.SetInputToDefaultAudioDevice()
    }
    # Diagnostics: distinguish "mic heard nothing" (no events at all) from
    # "heard audio but couldn't parse" (SpeechRecognitionRejected). These fire
    # during synchronous recognition too; results still come from Recognize().
    $engine.add_SpeechDetected({
        param($s, $e)
        Emit @{ type = 'detected' }
    })
    $engine.add_SpeechRecognitionRejected({
        param($s, $e)
        Emit @{ type = 'rejected'; reason = 'low-confidence' }
    })
    return $engine
}

# ── Set up (recognizer pick only; the engine itself is per-session) ──
try {
    Add-Type -AssemblyName System.Speech

    # en-US preferred, zh-CN fallback (only installed recognizers are usable)
    $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    $recognizer = $null
    foreach ($pref in @('en-US', 'zh-CN')) {
        foreach ($r in $installed) {
            if ($r.Culture.Name -eq $pref) { $recognizer = $r; break }
        }
        if ($recognizer) { break }
    }
    if (-not $recognizer) {
        EmitError 'NO_RECOGNIZER' "No installed speech recognizer for en-US or zh-CN"
        exit 1
    }
    $script:recognizer = $recognizer

    $recognizerNames = @($installed | ForEach-Object { $_.Culture.Name }) -join ';'
    Emit @{ type = 'ready'; culture = $recognizer.Culture.Name; recognizers = $recognizerNames }

    # ── CLI test mode: process the wave file synchronously, then exit ──
    if ($Wav) {
        if (-not (Test-Path -LiteralPath $Wav -PathType Leaf)) {
            EmitError 'WAV_NOT_FOUND' "Wave file not found: $Wav"
            exit 1
        }
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer.Culture)
        $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1000)
        $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $engine.SetInputToWaveFile($Wav)
        while ($true) {
            $r = $null
            try { $r = $engine.Recognize() } catch { break }  # EOF → InvalidOperationException
            if (-not $r) { break }
            if (-not [string]::IsNullOrWhiteSpace($r.Text)) {
                Emit @{ type = 'result'; text = $r.Text.Trim(); confidence = [double]$r.Confidence }
            }
        }
        Emit @{ type = 'stopped' }
        $engine.Dispose()
        $engine = $null
        exit 0
    }

    # ── CLI mic test mode: synchronous recognition from the default audio
    # device for MicSeconds, then exit — verifies the mic path standalone.
    if ($Mic) {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer.Culture)
        $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1000)
        $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $engine.SetInputToDefaultAudioDevice()
        $deadline = [DateTime]::Now.AddSeconds($MicSeconds)
        while ([DateTime]::Now -lt $deadline) {
            $r = $null
            try { $r = $engine.Recognize() } catch { break }
            if (-not $r) { continue }
            if (-not [string]::IsNullOrWhiteSpace($r.Text)) {
                Emit @{ type = 'result'; text = $r.Text.Trim(); confidence = [double]$r.Confidence }
            }
        }
        Emit @{ type = 'stopped' }
        $engine.Dispose()
        $engine = $null
        exit 0
    }

    # ── Interactive mode: single-threaded tick loop ──
    # Recognition ticks: synchronous Recognize() on the session engine.
    # Command ticks: async stdin reads (BeginRead/EndRead — no threads).
    $stdin = [Console]::OpenStandardInput()
    $inBuf = New-Object byte[] 4096
    $async = $stdin.BeginRead($inBuf, 0, 4096, $null, $null)
    $lineBuf = ''
    $running = $true

    while ($running) {
        # ── Recognition tick ──
        if ($script:recognizing) {
            if ($script:stopRequested) {
                # Session end at the phrase boundary — the in-flight phrase
                # has already finalized (recognizing=stopRequested is only
                # checked after Recognize() returns or the engine errored).
                try { $script:engine.Dispose() } catch { /* already disposed */ }
                $script:engine = $null
                $script:recognizing = $false
                $script:stopRequested = $false
                Emit @{ type = 'stopped' }
            } else {
                $r = $null
                try { $r = $script:engine.Recognize() } catch {
                    # Walk to the innermost exception — PS wraps .NET method
                    # exceptions in a MethodInvocationException.
                    $ex = $_.Exception
                    while ($ex.InnerException) { $ex = $ex.InnerException }
                    EmitError 'ENGINE' "Recognition failed: $($ex.Message)"
                    $script:stopRequested = $true
                }
                if ($r -and -not [string]::IsNullOrWhiteSpace($r.Text)) {
                    Emit @{ type = 'result'; text = $r.Text.Trim(); confidence = [double]$r.Confidence }
                }
            }
        }

        # ── Command tick (non-blocking) ──
        if ($async.IsCompleted) {
            $n = $stdin.EndRead($async)
            if ($n -le 0) { break }   # stdin EOF — Node closed the pipe
            $lineBuf += [System.Text.Encoding]::UTF8.GetString($inBuf, 0, $n)
            while ($lineBuf.Contains("`n")) {
                $idx = $lineBuf.IndexOf("`n")
                $line = $lineBuf.Substring(0, $idx).Trim()
                $lineBuf = $lineBuf.Substring($idx + 1)
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $cmd = $null
                try { $cmd = $line | ConvertFrom-Json } catch { continue }  # malformed — ignore
                if (-not $cmd) { continue }
                switch ($cmd.cmd) {
                    'start' {
                        if ($script:recognizing) {
                            if ($script:stopRequested) {
                                # Re-press while finalizing — continue the session.
                                $script:stopRequested = $false
                                Emit @{ type = 'started' }
                            } else {
                                Emit @{ type = 'rejected'; reason = 'busy' }
                            }
                        } else {
                            try {
                                $script:engine = New-SessionEngine
                                $script:recognizing = $true
                                $script:stopRequested = $false
                                Emit @{ type = 'started' }
                            } catch {
                                $script:recognizing = $false
                                if ($script:engine) { try { $script:engine.Dispose() } catch {}; $script:engine = $null }
                                $ex = $_.Exception
                                while ($ex.InnerException) { $ex = $ex.InnerException }
                                if ($ex -is [System.InvalidOperationException]) {
                                    EmitError 'NO_AUDIO_DEVICE' "No audio device available: $($ex.Message)"
                                } else {
                                    EmitError 'ENGINE' "Start failed: $($ex.Message)"
                                }
                            }
                        }
                    }
                    'stop' {
                        # Flag only — the phrase in flight finalizes first and
                        # its result is delivered before the session ends.
                        $script:stopRequested = $true
                    }
                    'exit' {
                        $script:stopRequested = $true
                        $running = $false
                    }
                }
            }
            $async = $stdin.BeginRead($inBuf, 0, 4096, $null, $null)
        } else {
            Start-Sleep -Milliseconds 20
        }
    }
} catch {
    EmitError 'ENGINE' $_.Exception.Message
} finally {
    if ($script:engine) {
        try { $script:engine.Dispose() } catch { /* already disposed */ }
        $script:engine = $null
    }
}

exit 0

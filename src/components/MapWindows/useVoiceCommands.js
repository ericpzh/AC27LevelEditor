/**
 * React hook that orchestrates the full voice-command pipeline:
 *
 *   transcript → parseVoiceTranscript (callsign → aircraft, then the
 *                patch-command chain — heading/altitude/speed/clear_for_appr)
 *
 * The returned matchedCommand is an ARRAY of {type, label, payload} command
 * entries (payloads are sendPatchCommand patch objects) — empty/null means
 * selection only (bare callsign → active/yellow). The caller dispatches the
 * chain; selection of the matched callsign is the caller's selection effect.
 *
 * Speech backend (2026-08-06): in Electron, offline vosk — electron/voice-stt-vosk.js
 * (spawned by voiceSttWorker.js via process.execPath + ELECTRON_RUN_AS_NODE;
 * sox mic capture, EN+ZH grammar-constrained decoding) — the Chromium Web
 * Speech API uploads mic audio to Google's speech API, which is shut down for
 * Electron (network error, was silently swallowed here). In a plain browser
 * (vite dev) the original Web Speech API path is kept as a fallback — it
 * works in Chrome.
 *
 * Manages the recognition session lifecycle, silence timeout, and error
 * handling. State shape is unchanged: listening/transcript/matchedCallsign/
 * matchedCommand/confidence/error/voiceResult/matchedAircraft.
 *
 * Usage:
 *   const voice = useVoiceCommands(udpAircraft);
 *   // voice.startListening(), voice.stopListening()
 *   // voice.listening, voice.transcript, voice.matchedCallsign,
 *   // voice.matchedCommand, voice.confidence, voice.error,
 *   // voice.voiceResult, voice.matchedAircraft
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { parseVoiceCandidates } from './voiceTranscriptParser.js';

// ─── Constants ─────────────────────────────────────────────────────────

/** Auto-stop after this many ms of silence. */
const SILENCE_TIMEOUT_MS = 2000;

/** Minimum time between startListening calls (debounce). */
const COOLDOWN_MS = 500;

// ─── Hook ──────────────────────────────────────────────────────────────

/**
 * @param {Object[]} udpAircraft — live aircraft array from useUdpAircraftState
 * @returns {Object} voice state + controls
 */
export default function useVoiceCommands(udpAircraft) {
  const electronAPI = useElectronAPI();
  const isElectron = !!electronAPI;
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [matchedCallsign, setMatchedCallsign] = useState(null);
  const [matchedCommand, setMatchedCommand] = useState(null);
  const [confidence, setConfidence] = useState(0);
  const [error, setError] = useState(null);
  const [voiceResult, setVoiceResult] = useState(null);   // full parseVoiceTranscript result (feedback)
  const [matchedAircraft, setMatchedAircraft] = useState(null);
  const [voiceStatus, setVoiceStatus] = useState(null);   // Electron: {available, culture, error} | null = unknown

  const recognitionRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const lastStartRef = useRef(0);
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRecognition();
      if (isElectron) electronAPI?.voiceSttStop?.();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recognition helpers ───────────────────────────────────────────

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {
        // Already stopped — ignore
      }
      recognitionRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const resetSilenceTimer = useCallback(() => {
    if (isElectron) return; // the worker's engine owns silence timing (child finalize grace)
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      stopRecognition();
      setListening(false);
    }, SILENCE_TIMEOUT_MS);
  }, [isElectron, stopRecognition]);

  // ── Check support ─────────────────────────────────────────────────
  // Electron: probe the vosk worker (null = unknown → button stays
  // hidden until the probe resolves, same pattern as bepInExActive).
  // Browser: the Web Speech API's presence.
  useEffect(() => {
    if (!isElectron) return undefined;
    let cancelled = false;
    electronAPI.getVoiceSttStatus()
      .then((s) => {
        if (cancelled) return;
        setVoiceStatus(s || { available: false });
        if (!s?.available) {
          setError(`Speech unavailable: ${s?.error || 'unknown'}`);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setVoiceStatus({ available: false });
        setError('Speech unavailable');
      });
    return () => { cancelled = true; };
  }, [isElectron, electronAPI]);

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isSupported = isElectron
    ? voiceStatus?.available === true
    : !!SpeechRecognitionAPI;

  // ── Start / Stop ──────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!isSupported) {
      setError(isElectron ? 'Speech engine not available' : 'Speech recognition not supported in this browser');
      return;
    }

    // Cooldown
    const now = Date.now();
    if (now - lastStartRef.current < COOLDOWN_MS) return;
    lastStartRef.current = now;

    // Clear previous state
    setTranscript('');
    setMatchedCallsign(null);
    setMatchedCommand(null);
    setConfidence(0);
    setError(null);
    setVoiceResult(null);
    setMatchedAircraft(null);

    // Stop any existing session
    stopRecognition();

    if (isElectron) {
      // ── Electron: vosk worker (main process spawns it) ──
      (async () => {
        try {
          const r = await electronAPI?.voiceSttStart?.();
          if (r?.success) {
            setListening(true);
            resetSilenceTimer();
          } else {
            setError(r?.error ? `Speech failed: ${r.error}` : 'Failed to start speech');
            setListening(false);
          }
        } catch (err) {
          console.error('[Voice] Failed to start speech:', err);
          setError('Failed to start speech');
          setListening(false);
        }
      })();
      return;
    }

    // ── Browser fallback (plain vite in Chrome): Web Speech API ──
    try {
      const recognition = new SpeechRecognitionAPI();
      recognitionRef.current = recognition;

      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US'; // Default — will restart in ZH if CJK detected

      // Build grammar? We can't easily switch grammar per recognition instance.
      // Instead, we rely on post-recognition fuzzy matching.

      recognition.onresult = (event) => {
        resetSilenceTimer();

        // Get the latest final or interim result
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0].transcript;
          } else {
            interimTranscript += result[0].transcript;
          }
        }

        const displayText = finalTranscript || interimTranscript;
        if (!displayText.trim()) return;

        setTranscript(displayText);

        // Only process final results for matching
        if (finalTranscript) {
          processTranscript(finalTranscript.trim());
        }
      };

      recognition.onerror = (event) => {
        console.warn('[Voice] Recognition error:', event.error, event.message);

        if (event.error === 'not-allowed') {
          setError('Microphone permission denied');
        } else if (event.error === 'no-speech') {
          // No speech detected — just stop gracefully
        } else if (event.error === 'aborted') {
          // Normal abort — ignore
        } else if (event.error !== 'network') {
          setError(`Recognition error: ${event.error}`);
        }

        setListening(false);
      };

      recognition.onend = () => {
        if (mountedRef.current) {
          setListening(false);
        }
      };

      recognition.start();
      setListening(true);
    } catch (err) {
      console.error('[Voice] Failed to start recognition:', err);
      setError('Failed to start microphone');
      setListening(false);
    }
  }, [isSupported, isElectron, electronAPI, stopRecognition, resetSilenceTimer]);

  const stopListening = useCallback(() => {
    if (isElectron) {
      // Fire-and-forget — the UI flips immediately; the worker's 'stopped'
      // event later re-confirms the state (no-op on the hook).
      electronAPI?.voiceSttStop?.();
    }
    stopRecognition();
    setListening(false);
  }, [isElectron, electronAPI, stopRecognition]);

  // ── Transcript processing ────────────────────────────────────────
  // Candidates: the primary result first, then the worker's alternate
  // alternate hypotheses (parseVoiceCandidates tries them in order and
  // keeps the first that yields commands — see voiceTranscriptParser.js).

  const processCandidates = useCallback((texts) => {
    if (!mountedRef.current) return;

    const { result, candidateIndex } = parseVoiceCandidates(texts, udpAircraft || []);

    // Print the parse to the main-process npm log (mirrors the MCP
    // send_voice_command tool's [VOICE-PARSE] line — same pipeline).
    if (electronAPI?.debugLog) {
      electronAPI.debugLog(
        '[VOICE-PARSE]', JSON.stringify(texts[0]),
        'matchedFrom=' + (candidateIndex === 0 ? 'primary' : 'alternate#' + candidateIndex),
        'ok=' + result.ok,
        'callsign=' + result.callsign,
        'a/c=' + (result.aircraft?.callSign ?? '-') + ' seat=' + (result.aircraft?.controlSeat ?? '-'),
        'commands=' + JSON.stringify(result.commands),
        'notices=' + JSON.stringify(result.notices),
        'rendered=' + JSON.stringify(result.renderedLine),
        'reason=' + (result.reason ?? '-')
      );
    }

    setVoiceResult(result);

    if (result.ok) {
      setMatchedCallsign(result.callsign);
      setMatchedAircraft(result.aircraft);
      setMatchedCommand(result.commands.length ? result.commands : null);
      setConfidence(result.commands.length ? 1 : 0);
    } else {
      // No aircraft matched — clear any previous match
      setMatchedCallsign(null);
      setMatchedAircraft(null);
      setMatchedCommand(null);
      setConfidence(0);
    }
  }, [udpAircraft]);

  /** Single-transcript entry (browser Web Speech path — no alternates). */
  const processTranscript = useCallback((text) => processCandidates([text]), [processCandidates]);

  // ── Worker event subscription (Electron) ──────────────────────────
  // (Declared after processTranscript — the deps array evaluates at call time.)
  useEffect(() => {
    if (!electronAPI?.onVoiceSttEvent) return undefined;
    const onEvent = (evt) => {
      if (!mountedRef.current) return;
      if (evt.type === 'result') {
        if (!evt.text) return;
        setTranscript(evt.text);   // displayed text stays the PRIMARY
        processCandidates([evt.text, ...(Array.isArray(evt.alternates) ? evt.alternates : [])]);
        resetSilenceTimer();
      } else if (evt.type === 'error') {
        console.warn('[Voice] Speech worker error:', evt.code, evt.message);
        if (evt.code === 'WORKER_EXIT') {
          setError('Speech engine stopped unexpectedly — press again to retry');
        } else if (evt.code === 'NO_AUDIO_DEVICE') {
          setError('No audio device available');
        } else {
          setError(evt.message || `Speech error: ${evt.code}`);
        }
        setListening(false);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      } else if (evt.type === 'stopped') {
        setListening(false);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      }
      // 'rejected' (busy / no-speech) — informational, ignore
    };
    electronAPI.onVoiceSttEvent(onEvent);
    return () => electronAPI.offVoiceSttEvent?.(onEvent);
  }, [electronAPI, processCandidates, resetSilenceTimer]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Return ───────────────────────────────────────────────────────

  return {
    listening,
    transcript,
    matchedCallsign,
    matchedCommand,
    confidence,
    error,
    isSupported,
    startListening,
    stopListening,
    voiceResult,
    matchedAircraft,
  };
}

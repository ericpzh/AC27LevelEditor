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
 * Manages SpeechRecognition lifecycle, silence timeout, and error handling.
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
import { parseVoiceTranscript } from './voiceTranscriptParser.js';

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
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [matchedCallsign, setMatchedCallsign] = useState(null);
  const [matchedCommand, setMatchedCommand] = useState(null);
  const [confidence, setConfidence] = useState(0);
  const [error, setError] = useState(null);
  const [voiceResult, setVoiceResult] = useState(null);   // full parseVoiceTranscript result (feedback)
  const [matchedAircraft, setMatchedAircraft] = useState(null);

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
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

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
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      stopRecognition();
      setListening(false);
    }, SILENCE_TIMEOUT_MS);
  }, [stopRecognition]);

  // ── Check support ─────────────────────────────────────────────────

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isSupported = !!SpeechRecognitionAPI;

  // ── Start / Stop ──────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!isSupported) {
      setError('Speech recognition not supported in this browser');
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
  }, [isSupported, stopRecognition, resetSilenceTimer]);

  const stopListening = useCallback(() => {
    stopRecognition();
    setListening(false);
  }, [stopRecognition]);

  // ── Transcript processing ────────────────────────────────────────

  const processTranscript = useCallback((text) => {
    if (!mountedRef.current) return;

    const result = parseVoiceTranscript(text, udpAircraft || []);

    // Print the parse to the main-process npm log (mirrors the MCP
    // send_voice_command tool's [VOICE-PARSE] line — same pipeline).
    if (electronAPI?.debugLog) {
      electronAPI.debugLog(
        '[VOICE-PARSE]', JSON.stringify(text),
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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { IoMicOutline, IoMic } from 'react-icons/io5';

/**
 * Push-to-talk microphone button for the Flight Strips bottom bar.
 *
 * Hold-to-talk: press and hold to start listening, release to stop.
 * The press uses pointer capture so a hold survives the cursor drifting off
 * the (tiny, 26px) button or the bar re-rendering — releasing is driven by
 * the pointer-up edge, never by mouseleave.
 * Visual states:
 *   - idle:       gray mic outline
 *   - listening:  solid mic with red pulsing ring
 *   - matched:    brief green flash (300ms) after a command match
 *   - error:      red mic with strikethrough style
 *   - unsupported: hidden
 *
 * Props:
 *   listening       — boolean, is mic currently active
 *   transcript      — string, the recognized text (shown as title tooltip)
 *   matchedCommand  — array of {type, label, payload} or null (the voice
 *                     command chain; empty = selection only)
 *   confidence      — number 0–1
 *   isSupported     — boolean, SpeechRecognition available
 *   error           — string or null
 *   feedback        — string or null, the transient result line (shown as
 *                     tooltip when not listening)
 *   witchMode       — boolean, use witch-themed sprite
 *   onPress()       — called once on pointer/key press
 *   onRelease()     — called once on pointer/key release
 */
export default function VoicePTTButton({
  listening,
  transcript,
  matchedCommand,
  confidence,
  isSupported,
  error,
  feedback,
  witchMode,
  onPress,
  onRelease,
}) {
  const [flash, setFlash] = useState(false);
  const prevMatchedRef = useRef(null);
  const pressedRef = useRef(false);

  // Green flash when a command is matched
  useEffect(() => {
    if (matchedCommand && matchedCommand !== prevMatchedRef.current) {
      prevMatchedRef.current = matchedCommand;
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 300);
      return () => clearTimeout(timer);
    }
  }, [matchedCommand]);

  // A window blur / pointer cancel mid-hold must still release the mic.
  useEffect(() => {
    const release = () => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      if (onRelease) onRelease();
    };
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, [onRelease]);

  // ── Event handlers ────────────────────────────────────────────────

  const handlePress = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (pressedRef.current) return;     // ignore key auto-repeat / double events
    pressedRef.current = true;
    // Capture the pointer so the release lands on this element even if the
    // cursor leaves the button while held. jsdom lacks the API — guard it.
    const el = e && e.currentTarget;
    if (el && typeof el.setPointerCapture === 'function' && e.pointerId != null) {
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
    }
    if (onPress) onPress();
  }, [onPress]);

  const handleRelease = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (onRelease) onRelease();
  }, [onRelease]);

  // Keyboard hold (Space / Enter) while the button itself is focused.
  const handleKeyDown = useCallback((e) => {
    if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
    handlePress(e);
  }, [handlePress]);

  const handleKeyUp = useCallback((e) => {
    if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
    handleRelease(e);
  }, [handleRelease]);

  // ── Render ────────────────────────────────────────────────────────

  if (!isSupported) {
    // Unavailable — show a disabled error mic when a reason is known so the
    // failure is visible instead of a silently missing button.
    return error ? (
      <div
        className="voice-ptt-btn voice-ptt-error"
        title={`Voice error: ${error}`}
        aria-label={`Voice error: ${error}`}
      >
        <IoMicOutline size={16} />
      </div>
    ) : null;
  }

  // Determine CSS class based on state
  let className = 'voice-ptt-btn';
  if (error) className += ' voice-ptt-error';
  else if (flash) className += ' voice-ptt-matched';
  else if (listening) className += ' voice-ptt-listening';

  // Tooltip: show transcript, the last result line, or the matched chain
  let title = 'Push to Talk';
  if (error) title = `Voice error: ${error}`;
  else if (listening && transcript) title = `Heard: "${transcript}"`;
  else if (listening) title = 'Listening...';
  else if (feedback) title = feedback;
  else if (matchedCommand && confidence > 0) title = `Matched: ${matchedCommand.map(c => c.label).join(', ')} (${Math.round(confidence * 100)}%)`;

  return (
    <div
      className={className}
      title={title}
      onPointerDown={handlePress}
      onPointerUp={handleRelease}
      onPointerCancel={handleRelease}
      onLostPointerCapture={handleRelease}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      role="button"
      tabIndex={0}
      aria-label={title}
      aria-pressed={listening}
    >
      {witchMode
        ? <img src="witch/voice.png" alt="Voice" className="witch-voice-img" />
        : (listening ? <IoMic size={16} /> : <IoMicOutline size={16} />)
      }
    </div>
  );
}

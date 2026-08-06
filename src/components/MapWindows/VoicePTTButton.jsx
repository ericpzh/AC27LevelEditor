import React, { useState, useEffect, useCallback, useRef } from 'react';
import { IoMicOutline, IoMic } from 'react-icons/io5';

/**
 * Push-to-talk microphone button for the Flight Strips bottom bar.
 *
 * Hold-to-talk: press and hold to start listening, release to stop.
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
 *   onPress()       — called on mousedown/touchstart
 *   onRelease()     — called on mouseup/touchend/mouseleave
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

  // Green flash when a command is matched
  useEffect(() => {
    if (matchedCommand && matchedCommand !== prevMatchedRef.current) {
      prevMatchedRef.current = matchedCommand;
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 300);
      return () => clearTimeout(timer);
    }
  }, [matchedCommand]);

  // ── Event handlers ────────────────────────────────────────────────

  const handlePress = useCallback((e) => {
    e.preventDefault();
    if (onPress) onPress();
  }, [onPress]);

  const handleRelease = useCallback((e) => {
    e.preventDefault();
    if (onRelease) onRelease();
  }, [onRelease]);

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
      onMouseDown={handlePress}
      onMouseUp={handleRelease}
      onMouseLeave={handleRelease}
      onTouchStart={handlePress}
      onTouchEnd={handleRelease}
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

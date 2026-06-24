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
 *   matchedCommand  — object or null, the matched command
 *   confidence      — number 0–1
 *   isSupported     — boolean, SpeechRecognition available
 *   error           — string or null
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

  if (!isSupported) return null;

  // Determine CSS class based on state
  let className = 'voice-ptt-btn';
  if (error) className += ' voice-ptt-error';
  else if (flash) className += ' voice-ptt-matched';
  else if (listening) className += ' voice-ptt-listening';

  // Tooltip: show transcript or error
  let title = 'Push to Talk';
  if (error) title = `Voice error: ${error}`;
  else if (listening && transcript) title = `Heard: "${transcript}"`;
  else if (listening) title = 'Listening...';
  else if (matchedCommand && confidence > 0) title = `Matched: ${matchedCommand.id} (${Math.round(confidence * 100)}%)`;

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

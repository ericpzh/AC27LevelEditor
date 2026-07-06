/**
 * useWitchAnimation — shared 500ms frame-toggle timer for witch mode sprites.
 *
 * Witch mode uses a 2-frame sprite animation. This hook toggles between frame 0
 * and frame 1 on a 500ms interval whenever witchMode is true. When witchMode is
 * turned off the interval is cleared and the frame resets to 0.
 *
 * Used by: AirMapWindow, GroundMapWindow, FlightStripsWindow.
 */
import { useState, useEffect, useRef } from 'react';

/**
 * @param {boolean} witchMode
 * @returns {number} 0 or 1 — current animation frame index
 */
export function useWitchAnimation(witchMode) {
  const [witchFrame, setWitchFrame] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!witchMode) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setWitchFrame(0);
      return;
    }
    timerRef.current = setInterval(() => {
      setWitchFrame(f => (f === 0 ? 1 : 0));
    }, 500);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [witchMode]);

  return witchFrame;
}

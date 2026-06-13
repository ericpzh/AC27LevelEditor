import React, { useState } from 'react';
import ClockPopover from '../CellEditor/TimeClockPopover';
import { useAppStore } from '../../../store/appStore';
import { timeToMinutes } from '../../../utils/timeUtils';
import { T } from '../../../utils/i18n';

/**
 * @param {{ value: string, onChange: (v: string) => void, minTime?: string, maxTime?: string }} props
 *   minTime / maxTime — optional validation bounds. When BOTH are provided the clock
 *   validates before committing. Omit to skip validation (matches save‑time behaviour
 *   per field: only runway timeline entries are bounds‑checked).
 */
export default function TimeCell({ value, onChange, minTime, maxTime }) {
  const [show, setShow] = useState(false);
  const showToast = useAppStore(s => s.showToast);

  const handleCommit = (v) => {
    if (minTime && maxTime) {
      const t = timeToMinutes(v);
      if (t < timeToMinutes(minTime) || t > timeToMinutes(maxTime)) {
        showToast(T('clock_time_out_of_bounds', { min: minTime, max: maxTime }), 'error');
        return;
      }
    }
    onChange(v);
    setShow(false);
  };

  return (
    <>
      <span className="tl-input" onClick={() => setShow(true)}>{value || ''}</span>
      {show && <ClockPopover value={value || '00:00:00'} col="Time" onCommit={handleCommit} onClose={() => setShow(false)} />}
    </>
  );
}

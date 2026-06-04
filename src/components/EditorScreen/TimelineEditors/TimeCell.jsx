import React, { useState } from 'react';
import ClockPopover from '../CellEditor/TimeClockPopover';

export default function TimeCell({ value, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <span className="tl-input" onClick={() => setShow(true)}>{value || ''}</span>
      {show && <ClockPopover value={value || '00:00:00'} col="Time" onCommit={v => { onChange(v); setShow(false); }} onClose={() => setShow(false)} />}
    </>
  );
}

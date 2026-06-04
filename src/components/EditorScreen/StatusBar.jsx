import React from 'react';

export default function StatusBar() {
  return (
    <footer id="statusbar">
      <span id="editor-filename">—</span>
      <span id="editor-airport" className="editor-airport"></span>
      <span id="flight-stats"></span>
    </footer>
  );
}

import React from 'react';
import './RunwaySidebar.css';

/**
 * Vertical runway filter sidebar for the air radar window.
 * Renders one toggle button per runway designator, stacked from the bottom.
 * Reuses the same .air-map-toggle CSS classes as the right ControlSidebar,
 * so witch mode sprites (button.png / button_on.png) work automatically.
 *
 * Props:
 *   runways      - string[] of runway designators (e.g. ["04L","04R","13L",...])
 *   activeRunways - Set of currently active designators (null = uninitialized)
 *   onToggle     - (designator: string) => void
 */
export default function RunwaySidebar({ runways, activeRunways, onToggle }) {
  if (!runways || runways.length === 0) return null;

  return (
    <div className="runway-sidebar">
      <div className="runway-sidebar-actions">
        {runways.map(rwy => {
          const isActive = !activeRunways || activeRunways.has(rwy);
          return (
            <div
              key={rwy}
              className={'air-map-toggle' + (isActive ? ' active' : '')}
              onClick={() => onToggle(rwy)}
            >
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">RWY{rwy}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

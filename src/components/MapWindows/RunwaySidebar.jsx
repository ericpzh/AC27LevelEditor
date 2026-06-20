import React from 'react';
import './RunwaySidebar.css';

/**
 * Vertical runway filter sidebar for the air radar window.
 * Renders arr/dep label toggles at the top and runway filter buttons
 * stacked from the bottom.
 * Reuses the same .air-map-toggle CSS classes as the right ControlSidebar,
 * so witch mode sprites (button.png / button_on.png) work automatically.
 *
 * Props:
 *   runways          - string[] of runway designators (e.g. ["04L","04R","13L",...])
 *   activeRunways    - Set of currently active designators (null = uninitialized)
 *   onToggle         - (designator: string) => void
 *   showArrLabels    - boolean — arrival labels visible
 *   showDepLabels    - boolean — departure labels visible
 *   onToggleArrLabels - () => void
 *   onToggleDepLabels - () => void
 */
export default function RunwaySidebar({ runways, activeRunways, onToggle, showArrLabels, showDepLabels, onToggleArrLabels, onToggleDepLabels }) {
  if (!runways || runways.length === 0) return null;

  return (
    <div className="runway-sidebar">
      {/* Arrival / Departure label toggles — top of sidebar */}
      <div className="runway-sidebar-labels">
        <div
          className={'air-map-toggle' + (showArrLabels ? ' active' : '')}
          onClick={onToggleArrLabels}
          title="Toggle arrival labels"
        >
          <div className="air-map-toggle-knob" />
          <span className="air-map-toggle-label">ARR</span>
        </div>
        <div
          className={'air-map-toggle' + (showDepLabels ? ' active' : '')}
          onClick={onToggleDepLabels}
          title="Toggle departure labels"
        >
          <div className="air-map-toggle-knob" />
          <span className="air-map-toggle-label">DEP</span>
        </div>
      </div>
      {/* Runway toggles — stacked from bottom */}
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

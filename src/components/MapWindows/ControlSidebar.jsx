import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import SpinKnob from './SpinKnob';
import { MAP_TOOLTIPS_ENABLED } from '../../utils/constants';
import './ControlSidebar.css';

/**
 * Vertical control sidebar for radar map windows.
 * Houses 3 spin knobs (zoom, pan E-W, pan S-N) at the top
 * and action buttons via children at the bottom.
 *
 * Optional knobTooltips: { zoom?, panH?, panV?, airspace? }
 *   Tooltip text strings for each SpinKnob (from help page content).
 */
export default function ControlSidebar({ zoomStep, panHStep, panVStep, zoomPos, panHPos, panVPos, onResetZoom, onResetPanH, onResetPanV, airspaceKnob, knobTooltips, children }) {
  const { t } = useTranslation();

  const airspaceWithTooltip = MAP_TOOLTIPS_ENABLED && knobTooltips?.airspace && airspaceKnob
    ? React.cloneElement(airspaceKnob, { tooltip: knobTooltips.airspace })
    : airspaceKnob;

  return (
    <div className="control-sidebar">
      <div className="control-sidebar-knobs">
        <SpinKnob label={t('knob_zoom')} onStep={zoomStep} position={zoomPos} onReset={onResetZoom} tooltip={MAP_TOOLTIPS_ENABLED ? knobTooltips?.zoom : undefined} />
        <SpinKnob label={t('knob_pan_h')} onStep={panHStep} position={panHPos} onReset={onResetPanH} tooltip={MAP_TOOLTIPS_ENABLED ? knobTooltips?.panH : undefined} />
        <SpinKnob label={t('knob_pan_v')} onStep={panVStep} position={panVPos} onReset={onResetPanV} tooltip={MAP_TOOLTIPS_ENABLED ? knobTooltips?.panV : undefined} />
        {airspaceWithTooltip}
      </div>
      <div className="control-sidebar-actions">
        {children}
      </div>
    </div>
  );
}

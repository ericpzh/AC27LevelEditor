import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import SpinKnob from './SpinKnob';
import './ControlSidebar.css';

/**
 * Vertical control sidebar for radar map windows.
 * Houses 3 spin knobs (zoom, pan E-W, pan S-N) at the top
 * and action buttons via children at the bottom.
 */
export default function ControlSidebar({ zoomStep, panHStep, panVStep, zoomPos, panHPos, panVPos, onResetZoom, onResetPanH, onResetPanV, airspaceKnob, children }) {
  const { t } = useTranslation();

  return (
    <div className="control-sidebar">
      <div className="control-sidebar-knobs">
        <SpinKnob label={t('knob_zoom')} onStep={zoomStep} position={zoomPos} onReset={onResetZoom} />
        <SpinKnob label={t('knob_pan_h')} onStep={panHStep} position={panHPos} onReset={onResetPanH} />
        <SpinKnob label={t('knob_pan_v')} onStep={panVStep} position={panVPos} onReset={onResetPanV} />
        {airspaceKnob}
      </div>
      <div className="control-sidebar-actions">
        {children}
      </div>
    </div>
  );
}

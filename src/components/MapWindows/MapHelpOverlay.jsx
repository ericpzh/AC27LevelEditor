import React, { useEffect, useState, useCallback } from 'react';
import './MapHelpOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { IoClose } from 'react-icons/io5';

// ─── Button registry (label key → visual type) ──────────────
const MAP_BUTTONS = {
  // Air Map toggles
  star:    { labelKey: 'air_map_star',       type: 'toggle' },
  sid:     { labelKey: 'air_map_sid',        type: 'toggle' },
  appr:    { labelKey: 'air_map_appr',       type: 'toggle' },
  labels:  { labelKey: 'air_map_labels',     type: 'toggle' },
  ils:     { labelKey: 'air_map_runway_ext', type: 'toggle' },
  mapbg:   { labelKey: 'air_map_bg',         type: 'toggle' },
  refresh: { labelKey: 'map_refresh',        type: 'action', icon: '↻' },
  // Ground Map toggles
  parked:  { labelKey: 'ground_map_show_all',type: 'toggle' },
  taxiway: { labelKey: 'ground_map_taxiway', type: 'toggle' },
  // Knobs
  range:   { labelKey: 'knob_zoom',          type: 'knob' },
  panew:   { labelKey: 'knob_pan_h',         type: 'knob' },
  pansn:   { labelKey: 'knob_pan_v',         type: 'knob' },
  airspace:{ label: 'AIRSPACE',              type: 'knob' },
};

// ─── Render text with {{btn:key}} tokens → inline button visual
function renderContent(text, t, activeButtons, onToggle, mapType) {
  const parts = text.split(/(\{\{btn:\w+\}\})/);
  return parts.map((part, i) => {
    const m = part.match(/\{\{btn:(\w+)\}\}/);
    if (m) {
      const key = m[1];
      const btn = MAP_BUTTONS[key];
      if (!btn) return part;
      const label = btn.labelKey ? t(btn.labelKey) : (btn.label || key);
      const icon = btn.icon || label;
      const isActive = activeButtons.has(key);
      // Strips window uses static icon buttons matching its bottom bar; radar uses knob visuals
      const isIcon = btn.type === 'icon' || (mapType === 'strips' && (key === 'refresh'));
      const isToggle = !isIcon && (btn.type === 'toggle' || btn.type === 'action');
      // Icon buttons: flat span, no wrappers
      if (isIcon) {
        return <span key={i} className="map-help-btn-icon-symbol">{icon}</span>;
      }
      return (
        <span
          key={i}
          className={'map-help-btn-inline'
            + (btn.type === 'knob' ? ' map-help-btn-knob' : '')
            + (isActive ? ' active' : '')}
          onClick={isToggle ? (e) => { e.stopPropagation(); onToggle(key); } : undefined}
          title={isToggle ? 'Click to toggle' : undefined}
        >
          <span className="map-help-btn-knob-visual" />
          <span className="map-help-btn-knob-label">{label}</span>
        </span>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// ─── Air Map help sections ──────────────────────────────────
const AIR_SECTIONS = [
  {
    id: 'knobs', headingKey: 'map_help_air_knobs_heading',
    bodyKeys: ['map_help_air_knobs_range', 'map_help_air_knobs_panew', 'map_help_air_knobs_pansn', 'map_help_air_airspace'],
  },
  {
    id: 'toggles', headingKey: 'map_help_air_toggles_heading',
    bodyKeys: [
      'map_help_air_star',
      'map_help_air_sid',
      'map_help_air_appr',
      'map_help_air_labels',
      'map_help_air_ils',
      'map_help_air_map',
      'map_help_air_refresh',
    ],
  },
  {
    id: 'interact', headingKey: 'map_help_air_interact_heading',
    bodyKeys: ['map_help_air_click', 'map_help_air_drag', 'map_help_air_scroll'],
  },
];

// ─── Ground Map help sections ───────────────────────────────
const GROUND_SECTIONS = [
  {
    id: 'knobs', headingKey: 'map_help_ground_knobs_heading',
    bodyKeys: ['map_help_ground_knobs_range', 'map_help_ground_knobs_panew', 'map_help_ground_knobs_pansn'],
  },
  {
    id: 'toggles', headingKey: 'map_help_ground_toggles_heading',
    bodyKeys: [
      'map_help_ground_parked',
      'map_help_ground_labels',
      'map_help_ground_refresh',
    ],
  },
  {
    id: 'interact', headingKey: 'map_help_ground_interact_heading',
    bodyKeys: ['map_help_ground_click', 'map_help_ground_drag', 'map_help_ground_scroll'],
  },
];

// ─── Flight Strips help sections ──────────────────────────
const STRIPS_SECTIONS = [
  {
    id: 'interact', headingKey: null,
    bodyKeys: [
      'map_help_strips_refresh',
      'map_help_strips_click',
      'map_help_strips_drag',
    ],
  },
];

// ─── Component ──────────────────────────────────────────────
export default function MapHelpOverlay({ type, onClose, title, titleKey }) {
  const { t } = useTranslation();
  const [activeButtons, setActiveButtons] = useState(() => new Set());

  const handleToggle = useCallback((key) => {
    setActiveButtons(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'map-help-overlay') onClose();
  };

  const sections = type === 'air' ? AIR_SECTIONS : type === 'ground' ? GROUND_SECTIONS : STRIPS_SECTIONS;

  return (
    <div id="map-help-overlay" onClick={handleOverlayClick}>
      <div id="map-help-box" onClick={(e) => e.stopPropagation()}>
        <div id="map-help-header">
          <h2>{titleKey ? t(titleKey) : (title || t('map_help_title'))}</h2>
          <button onClick={onClose} title={t('tutorial_close')}>
            <IoClose size={18} />
          </button>
        </div>

        <div id="map-help-body">
          {sections.map((s) => (
            <section key={s.id} id={'map-help-' + s.id} className="map-help-section">
              {s.headingKey && <h2>{t(s.headingKey)}</h2>}
              {s.bodyKeys && s.bodyKeys.map((bk, i) => {
                const text = t(bk);
                const isToggleRow = type !== 'strips' && text.match(/^(\{\{btn:\w+\}\})\s*[—–\-：:]\s*/);
                if (isToggleRow) {
                  return (
                    <div key={'p' + i} className="map-help-toggle-row">
                      <span className="map-help-toggle-btn">{renderContent(isToggleRow[1], t, activeButtons, handleToggle, type)}</span>
                      <span className="map-help-toggle-desc">{text.slice(isToggleRow[0].length)}</span>
                    </div>
                  );
                }
                return <p key={'p' + i}>{renderContent(text, t, activeButtons, handleToggle, type)}</p>;
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

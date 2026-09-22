import React, { useEffect } from 'react';
import './BrowserHelpOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { IoClose, IoFolderOpenOutline, IoBugOutline, IoLanguage, IoMapOutline, IoNavigateOutline, IoListOutline, IoVideocamOutline, IoCodeSlash } from 'react-icons/io5';
import { AiFillSkin } from 'react-icons/ai';
import { MdOutlineRestore } from 'react-icons/md';
import { FaGear } from 'react-icons/fa6';
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';

// Radar / flight-strip toggles are hidden from the level browser (kept for
// revival). When false, the header buttons AND their help section are omitted.
export const BROWSER_RADAR_TOGGLES_ENABLED = false;

// ─── Button registry (icon + label key + help description) ───
export const BUTTONS = {
  changeDir:      { icon: IoFolderOpenOutline, labelKey: 'browser_change_dir',      descKey: 'browser_help_change_dir' },
  debugMode:      { icon: IoCodeSlash,        labelKey: 'browser_debug_mode',      descKey: 'browser_help_debug_mode' },
  replaceBg:      { icon: IoVideocamOutline,  labelKey: 'browser_replace_background', descKey: 'browser_help_replace_bg' },
  livery:         { icon: AiFillSkin, labelKey: 'browser_livery',      descKey: 'browser_help_livery' },
  restoreAll:     { icon: MdOutlineRestore,   labelKey: 'browser_restore_all',     descKey: 'browser_help_restore_all' },
  settings:       { icon: FaGear,             labelKey: 'browser_settings',        descKey: 'browser_help_settings' },
  bugReport:      { icon: IoBugOutline,       labelKey: 'browser_bug_report',      descKey: 'browser_help_bug_report' },
  lang:           { icon: IoLanguage,         labelKey: 'browser_language',        descKey: 'browser_help_lang' },
  themeDark:      { icon: IoSunnyOutline,     labelKey: 'browser_light_mode',      descKey: 'browser_help_theme' },
  themeLight:     { icon: IoMoonOutline,      labelKey: 'browser_dark_mode',       descKey: 'browser_help_theme' },
  surfaceRadar:   { icon: IoMapOutline,       labelKey: 'toolbar_surface_radar',   descKey: 'browser_help_surface_radar' },
  approachRadar:  { icon: IoNavigateOutline,  labelKey: 'toolbar_approach_radar',  descKey: 'browser_help_approach_radar' },
  flightStrips:   { icon: IoListOutline,      labelKey: 'toolbar_flight_strips',   descKey: 'browser_help_flight_strips' },
};

// ─── Render text with {{btn:key}} tokens
function renderContent(text, t) {
  const parts = text.split(/(\{\{btn:\w+\}\})/);
  return parts.map((part, i) => {
    const btnM = part.match(/\{\{btn:(\w+)\}\}/);
    if (btnM) {
      const btn = BUTTONS[btnM[1]];
      if (!btn) return part;
      const Icon = btn.icon;
      return <span key={i} className="browser-help-btn"><Icon size={12} className="btn-icon" />{btn.labelKey ? t(btn.labelKey) : null}</span>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// ─── Section definitions ──────────────────────────────────
const SECTIONS = [
  {
    id: 'toolbar', headingKey: 'browser_help_header_heading',
    items: [
      { text: '{{btn:livery}} — {desc}', descKey: 'browser_help_livery' },
      { text: '{{btn:restoreAll}} — {desc}', descKey: 'browser_help_restore_all' },
      { text: '{{btn:settings}} — {desc}', descKey: 'browser_help_settings' },
    ],
  },
  {
    id: 'settings', headingKey: 'browser_help_settings_heading',
    items: [
      { text: '{{btn:changeDir}} — {desc}', descKey: 'browser_help_change_dir' },
      { text: '{{btn:replaceBg}} — {desc}', descKey: 'browser_help_replace_bg' },
      { text: '{{btn:bugReport}} — {desc}', descKey: 'browser_help_bug_report' },
      { text: '{{btn:lang}} — {desc}', descKey: 'browser_help_lang' },
      { text: '{{btn:themeDark}} / {{btn:themeLight}} — {desc}', descKey: 'browser_help_theme' },
      { text: '{{btn:debugMode}} — {desc}', descKey: 'browser_help_debug_mode' },
    ],
  },
  ...(BROWSER_RADAR_TOGGLES_ENABLED ? [{
    id: 'cards', headingKey: 'browser_help_cards_heading',
    items: [
      { text: '{{btn:surfaceRadar}} — {desc}', descKey: 'browser_help_surface_radar' },
      { text: '{{btn:approachRadar}} — {desc}', descKey: 'browser_help_approach_radar' },
      { text: '{{btn:flightStrips}} — {desc}', descKey: 'browser_help_flight_strips' },
    ],
  }] : []),
  {
    id: 'levels', headingKey: 'browser_help_levels_heading',
    items: [
      { text: '{desc}', descKey: 'browser_help_level_click' },
    ],
  },
];

// ─── Component ────────────────────────────────────────────
export default function BrowserHelpOverlay({ onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'browser-help-overlay') onClose();
  };

  return (
    <div id="browser-help-overlay" onClick={handleOverlayClick}>
      <div id="browser-help-box" onClick={(e) => e.stopPropagation()}>
        <div id="browser-help-header">
          <h2>{t('browser_help_title')}</h2>
          <button onClick={onClose} title={t('browser_help_close')}>
            <IoClose size={18} />
          </button>
        </div>

        <div id="browser-help-body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={'browser-help-' + s.id} className="browser-help-section">
              <h2>{t(s.headingKey)}</h2>
              {s.items.map((item, i) => (
                <div key={i} className="browser-help-item">
                  {renderContent(
                    item.text.replace('{desc}', t(item.descKey)),
                    t
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

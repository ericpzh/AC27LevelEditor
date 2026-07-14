import React, { useEffect } from 'react';
import './BrowserHelpOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { IoClose, IoFolderOpenOutline, IoBugOutline, IoRefreshOutline, IoLanguage, IoMapOutline, IoNavigateOutline, IoListOutline, IoVideocamOutline, IoCodeSlash, IoColorPaletteOutline } from 'react-icons/io5';
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';

// ─── Button registry (icon + label key + help description) ───
export const BUTTONS = {
  changeDir:      { icon: IoFolderOpenOutline, labelKey: 'browser_change_dir',      descKey: 'browser_help_change_dir' },
  refresh:        { icon: IoRefreshOutline,   labelKey: 'browser_refresh_scan',    descKey: 'browser_help_refresh' },
  debugMode:      { icon: IoCodeSlash,        labelKey: 'browser_debug_mode',      descKey: 'browser_help_debug_mode' },
  replaceBg:      { icon: IoVideocamOutline,  labelKey: 'browser_replace_background', descKey: 'browser_help_replace_bg' },
  livery:         { icon: IoColorPaletteOutline, labelKey: 'browser_livery',      descKey: 'browser_help_livery' },
  bugReport:      { icon: IoBugOutline,       labelKey: null,                      descKey: 'browser_help_bug_report' },
  lang:           { icon: IoLanguage,         labelKey: null,                      descKey: 'browser_help_lang' },
  themeDark:      { icon: IoSunnyOutline,     labelKey: null,                      descKey: 'browser_help_theme' },
  themeLight:     { icon: IoMoonOutline,      labelKey: null,                      descKey: 'browser_help_theme' },
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
      { text: '{{btn:changeDir}} — {desc}', descKey: 'browser_help_change_dir' },
      { text: '{{btn:refresh}} — {desc}', descKey: 'browser_help_refresh' },
      { text: '{{btn:debugMode}} — {desc}', descKey: 'browser_help_debug_mode' },
      { text: '{{btn:replaceBg}} — {desc}', descKey: 'browser_help_replace_bg' },
      { text: '{{btn:livery}} — {desc}', descKey: 'browser_help_livery' },
      { text: '{{btn:bugReport}} — {desc}', descKey: 'browser_help_bug_report' },
      { text: '{{btn:lang}} — {desc}', descKey: 'browser_help_lang' },
      { text: '{{btn:themeDark}} / {{btn:themeLight}} — {desc}', descKey: 'browser_help_theme' },
    ],
  },
  {
    id: 'cards', headingKey: 'browser_help_cards_heading',
    items: [
      { text: '{{btn:surfaceRadar}} — {desc}', descKey: 'browser_help_surface_radar' },
      { text: '{{btn:approachRadar}} — {desc}', descKey: 'browser_help_approach_radar' },
      { text: '{{btn:flightStrips}} — {desc}', descKey: 'browser_help_flight_strips' },
    ],
  },
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

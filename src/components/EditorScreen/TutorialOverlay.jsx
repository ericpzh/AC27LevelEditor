import React, { useEffect } from 'react';
import './TutorialOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { IoClose, IoAirplane, IoCopyOutline, IoTrashOutline, IoSearchOutline } from 'react-icons/io5';

// ─── Button registry (icon + label key) ────────────────────
const BUTTONS = {
  addArrival:     { icon: IoAirplane,       labelKey: 'toolbar_add_arrival',   iconStyle: { transform:'rotate(45deg)', display:'block' }, wrapStyle: { borderBottom:'1.5px solid var(--text-secondary)', paddingBottom:'1px', display:'inline-block', lineHeight:1 } },
  addDeparture:   { icon: IoAirplane,       labelKey: 'toolbar_add_departure', iconStyle: { transform:'rotate(-45deg)', display:'block' }, wrapStyle: { borderBottom:'1.5px solid var(--text-secondary)', paddingBottom:'1px', display:'inline-block', lineHeight:1 } },
  copy:           { icon: IoCopyOutline,    labelKey: 'toolbar_copy' },
  deleteSelected: { icon: IoTrashOutline,   labelKey: 'toolbar_delete_selected' },
  find:           { icon: IoSearchOutline,  labelKey: 'toolbar_find' },
};

// ─── Render text with {{btn:key}} / {{kbd:key}} tokens
function renderContent(text, t) {
  const parts = text.split(/(\{\{(?:btn|kbd):\w+\}\})/);
  return parts.map((part, i) => {
    const btnM = part.match(/\{\{btn:(\w+)\}\}/);
    if (btnM) {
      const btn = BUTTONS[btnM[1]];
      if (!btn) return part;
      const Icon = btn.icon;
      const iconEl = btn.wrapStyle
        ? <span style={btn.wrapStyle}><Icon size={12} style={btn.iconStyle} /></span>
        : <Icon size={12} className="btn-icon" style={btn.iconStyle} />;
      return <span key={i} className="tutorial-btn">{iconEl}{t(btn.labelKey)}</span>;
    }
    const kbdM = part.match(/\{\{kbd:(\w+)\}\}/);
    if (kbdM) {
      return <kbd key={i} className="tutorial-kbd">{kbdM[1]}</kbd>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// ─── Section definitions ──────────────────────────────────
const SECTIONS = [
  {
    id: 'editing', headingKey: 'tutorial_heading_editing',
    bodyKeys: ['tutorial_editing_p1'],
    listKeys: ['tutorial_editing_li1', 'tutorial_editing_li2', 'tutorial_editing_li3'],
    tailKeys: ['tutorial_editing_p2'],
  },
  {
    id: 'adding', headingKey: 'tutorial_heading_adding',
    bodyKeys: ['tutorial_adding_p1'],
  },
  {
    id: 'bulk', headingKey: 'tutorial_heading_bulk',
    bodyKeys: ['tutorial_bulk_p1', 'tutorial_bulk_p2'],
  },
  {
    id: 'search', headingKey: 'tutorial_heading_search',
    bodyKeys: ['tutorial_search_p1'],
  },
];

// ─── Keyboard shortcuts table ─────────────────────────────
const SHORTCUTS = [
  { win: 'Ctrl+N',           mac: '⌘N',       nameKey: 'tutorial_sc_add_arrival' },
  { win: 'Ctrl+Shift+N',     mac: '⌘⇧N',      nameKey: 'tutorial_sc_add_departure' },
  { win: 'Ctrl+S',           mac: '⌘S',        nameKey: 'tutorial_sc_save' },
  { win: 'Ctrl+D',           mac: '⌘D',        nameKey: 'tutorial_sc_copy' },
  { win: 'Delete',           mac: '⌫',         nameKey: 'tutorial_sc_delete' },
  { win: 'Ctrl+F',           mac: '⌘F',        nameKey: 'tutorial_sc_search' },
  { win: 'Esc',              mac: '⎋',         nameKey: 'tutorial_sc_deselect' },
];

// ─── Component ────────────────────────────────────────────
export default function TutorialOverlay({ onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'tutorial-overlay') onClose();
  };

  return (
    <div id="tutorial-overlay" onClick={handleOverlayClick}>
      <div id="tutorial-box" onClick={(e) => e.stopPropagation()}>
        <div id="tutorial-header">
          <h2>{t('tutorial_title')}</h2>
          <button onClick={onClose} title={t('tutorial_close')}>
            <IoClose size={18} />
          </button>
        </div>

        <div id="tutorial-body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={'tutorial-' + s.id} className="tutorial-section">
              <h2>{t(s.headingKey)}</h2>
              {s.bodyKeys && s.bodyKeys.map((bk, i) => (
                <p key={'p' + i}>{renderContent(t(bk), t)}</p>
              ))}
              {s.listKeys && (
                <ul className="tutorial-list">
                  {s.listKeys.map((lk, i) => (
                    <li key={'li' + i}>{renderContent(t(lk), t)}</li>
                  ))}
                </ul>
              )}
              {s.tailKeys && s.tailKeys.map((tk, i) => (
                <p key={'t' + i}>{renderContent(t(tk), t)}</p>
              ))}
            </section>
          ))}

          <section id="tutorial-shortcuts" className="tutorial-section">
            <h2>{t('tutorial_heading_shortcuts')}</h2>
            <table className="tutorial-shortcut-table">
              <thead>
                <tr>
                  <th>{t('tutorial_sc_action')}</th>
                  <th>{t('tutorial_sc_win')}</th>
                  <th>{t('tutorial_sc_mac')}</th>
                </tr>
              </thead>
              <tbody>
                {SHORTCUTS.map((sc) => (
                  <tr key={sc.nameKey}>
                    <td>{t(sc.nameKey)}</td>
                    <td><kbd className="tutorial-kbd">{sc.win}</kbd></td>
                    <td><kbd className="tutorial-kbd">{sc.mac}</kbd></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}

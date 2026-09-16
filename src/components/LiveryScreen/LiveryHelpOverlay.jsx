import React, { useEffect } from 'react';
import './LiveryHelpOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { IoClose } from 'react-icons/io5';
import { OWN_PACK_NAME } from '../../utils/constants/livery';

// ─── Section definitions ──────────────────────────────────
const SECTIONS = [
  {
    id: 'tabs', headingKey: 'livery_help_tabs_heading',
    items: [
      { descKey: 'livery_help_mine' },
      { descKey: 'livery_help_create' },
      { descKey: 'livery_help_install' },
    ],
  },
  {
    id: 'paint', headingKey: 'livery_help_paint_heading',
    items: [
      { descKey: 'livery_help_tool_brush' },
      { descKey: 'livery_help_tool_fill' },
      { descKey: 'livery_help_tool_shapes' },
      { descKey: 'livery_help_tool_text' },
      { descKey: 'livery_help_tool_sticker' },
    ],
  },
  {
    id: 'share', headingKey: 'livery_help_share_heading',
    items: [
      { descKey: 'livery_share_help', params: { pack: OWN_PACK_NAME } },
    ],
  },
];

// ─── Component ────────────────────────────────────────────
export default function LiveryHelpOverlay({ onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'livery-help-overlay') onClose();
  };

  return (
    <div id="livery-help-overlay" onClick={handleOverlayClick}>
      <div id="livery-help-box" onClick={(e) => e.stopPropagation()}>
        <div id="livery-help-header">
          <h2>{t('livery_help_title')}</h2>
          <button onClick={onClose} title={t('browser_help_close')}>
            <IoClose size={18} />
          </button>
        </div>

        <div id="livery-help-body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={'livery-help-' + s.id} className="livery-help-section">
              <h2>{t(s.headingKey)}</h2>
              {s.items.map((item, i) => (
                <div key={i} className="livery-help-item">
                  {t(item.descKey, item.params)}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

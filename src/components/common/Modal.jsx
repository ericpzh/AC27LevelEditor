import React from 'react';
import './Modal.css';
import { IoLanguage } from 'react-icons/io5';
import { useAppStore } from '../../store/appStore';
import { useTranslation } from '../../hooks/useTranslation';

// When title/body/actions are functions, call them with the live `t` so content
// re-translates on lang change instead of being frozen at showModal() call time.
function resolve(content, t) {
  return typeof content === 'function' ? content(t) : content;
}

export default function Modal() {
  const { open, title, body, actions, closeable = true, headerRight, showLangToggle } = useAppStore(s => s.modal);
  const hideModal = useAppStore(s => s.hideModal);
  const { t, toggleLang } = useTranslation();
  if (!open) return null;

  return (
    <div id="modal-overlay" onClick={closeable ? hideModal : undefined}>
      <div id="modal-box" onClick={e => e.stopPropagation()}>
        <div id="modal-header">
          <h3 id="modal-title">{resolve(title, t)}</h3>
          <div id="modal-header-right">
            {headerRight && (typeof headerRight === 'function' ? headerRight() : headerRight)}
            {showLangToggle && (
              <button className="btn-lang-toggle-top btn-accent" onClick={toggleLang}>
                <IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}
              </button>
            )}
          </div>
        </div>
        <div id="modal-body">{resolve(body, t)}</div>
        {actions && <div id="modal-actions">{resolve(actions, t)}</div>}
      </div>
    </div>
  );
}

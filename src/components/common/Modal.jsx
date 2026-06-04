import React from 'react';
import './Modal.css';
import { useAppStore } from '../../store/appStore';

export default function Modal() {
  const { open, title, body, actions } = useAppStore(s => s.modal);
  const hideModal = useAppStore(s => s.hideModal);
  if (!open) return null;

  return (
    <div id="modal-overlay" onClick={hideModal}>
      <div id="modal-box" onClick={e => e.stopPropagation()}>
        <h3 id="modal-title">{title}</h3>
        <div id="modal-body">{body}</div>
        {actions && <div id="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

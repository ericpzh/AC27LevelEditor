import React from 'react';
import './LanguagePicker.css';
import { useTranslation } from '../../hooks/useTranslation';

// First-launch language chooser. Rendered by the ScreenRouter when no language
// has ever been stored (no localStorage entry and no cache.json), so the user
// picks one before the rest of the UI appears.
export default function LanguagePicker() {
  const { chooseLang } = useTranslation();
  return (
    <div id="screen-language" className="screen">
      <div className="language-card">
        <h1>AC27 Editor</h1>
        <p className="language-sub">选择语言 · Choose language</p>
        <div className="language-actions">
          <button className="btn-big language-btn" onClick={() => chooseLang('zh')}>中文</button>
          <button className="btn-big language-btn" onClick={() => chooseLang('en')}>English</button>
        </div>
      </div>
    </div>
  );
}

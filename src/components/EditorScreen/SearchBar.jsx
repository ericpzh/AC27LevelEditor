import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

export default function SearchBar() {
  const { t } = useTranslation();
  return (
    <div id="search-bar" className="search-bar" style={{ display: 'none' }}>
      <input id="search-input" type="text" placeholder={t('search_placeholder')} />
      <span id="search-count" className="search-count"></span>
      <button id="search-prev" className="btn-sm">↑</button>
      <button id="search-next" className="btn-sm">↓</button>
      <button id="search-close" className="search-close">✕</button>
    </div>
  );
}

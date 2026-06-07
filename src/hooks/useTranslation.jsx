import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { T, getLang, setLang } from '../utils/i18n';

const I18nContext = createContext();

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => getLang());

  // On mount, if localStorage has no lang, try the cache JSON as fallback
  useEffect(() => {
    if (!localStorage.getItem('ac27_lang') && window.electronAPI && window.electronAPI.getCachedLang) {
      const p = window.electronAPI.getCachedLang();
      if (p && typeof p.then === 'function') {
        p.then(result => {
          if (result && result.lang && (result.lang === 'en' || result.lang === 'zh')) {
            setLangState(result.lang);
            setLang(result.lang);
            try { localStorage.setItem('ac27_lang', result.lang); } catch (_) {}
          }
        }).catch(() => {});
      }
    }
  }, []);

  const t = useCallback((key, params) => {
    return T(key, params);
  }, [lang]); // re-create when lang changes so consumers re-render

  const toggleLang = useCallback(() => {
    const next = lang === 'zh' ? 'en' : 'zh';
    setLangState(next);
    setLang(next);
    try { localStorage.setItem('ac27_lang', next); } catch (_) {}
    if (window.electronAPI && window.electronAPI.saveCachedLang) {
      const p = window.electronAPI.saveCachedLang(next);
      if (p && typeof p.then === 'function') p.catch(() => {});
    }
  }, [lang]);

  return (
    <I18nContext.Provider value={{ t, lang, toggleLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}

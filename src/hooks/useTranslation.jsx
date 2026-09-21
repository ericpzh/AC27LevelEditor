import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { T, getLang, setLang } from '../utils/i18n';
import { STORAGE_KEY_LANG } from '../utils/constants';

const I18nContext = createContext();

function isValidLang(lang) {
  return lang === 'en' || lang === 'zh';
}

function readStoredLang() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_LANG);
    return isValidLang(v) ? v : null;
  } catch (_) {
    return null;
  }
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => getLang());
  // 'loading' — resolving the cached language; 'chosen' — a language is known;
  // 'unset' — no language stored anywhere yet (first launch → show the picker).
  const [langStatus, setLangStatus] = useState(() => (readStoredLang() ? 'chosen' : 'loading'));

  const applyLang = useCallback((next) => {
    setLangState(next);
    setLang(next);
    try { localStorage.setItem(STORAGE_KEY_LANG, next); } catch (_) {}
  }, []);

  const chooseLang = useCallback((next) => {
    if (!isValidLang(next)) return;
    applyLang(next);
    setLangStatus('chosen');
    if (window.electronAPI && window.electronAPI.saveCachedLang) {
      const p = window.electronAPI.saveCachedLang(next);
      if (p && typeof p.then === 'function') p.catch(() => {});
    }
  }, [applyLang]);

  // On mount, if localStorage has no lang, fall back to the cached lang in
  // cache.json. When neither exists this is a first launch → 'unset', so the
  // renderer shows the language picker before anything else.
  useEffect(() => {
    if (langStatus !== 'loading') return;
    const api = window.electronAPI;
    if (!api || !api.getCachedLang) { setLangStatus('unset'); return; }
    let cancelled = false;
    try {
      const p = api.getCachedLang();
      if (p && typeof p.then === 'function') {
        p.then(result => {
          if (cancelled) return;
          if (result && isValidLang(result.lang)) {
            applyLang(result.lang);
            setLangStatus('chosen');
          } else {
            setLangStatus('unset');
          }
        }).catch(() => { if (!cancelled) setLangStatus('unset'); });
      } else {
        setLangStatus('unset');
      }
    } catch (_) {
      setLangStatus('unset');
    }
    return () => { cancelled = true; };
  }, [langStatus, applyLang]);

  const t = useCallback((key, params) => {
    return T(key, params);
  }, [lang]); // re-create when lang changes so consumers re-render

  const toggleLang = useCallback(() => {
    chooseLang(lang === 'zh' ? 'en' : 'zh');
  }, [lang, chooseLang]);

  return (
    <I18nContext.Provider value={{ t, lang, toggleLang, langStatus, chooseLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}

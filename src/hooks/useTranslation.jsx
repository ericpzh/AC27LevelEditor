import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { T, getLang, setLang } from '../utils/i18n';
import { STORAGE_KEY_LANG } from '../utils/constants';

const I18nContext = createContext();

function isValidLang(lang) {
  return lang === 'en' || lang === 'zh';
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => getLang());
  // 'loading' — resolving the cached language; 'chosen' — a language is
  // persisted in cache.json; 'unset' — cache.json has no language yet (first
  // launch → show the picker before anything else).
  //
  // cache.json is the single source of truth for the gate, NOT localStorage:
  // the packaged normal and workshop builds share one `file://` localStorage
  // origin and one userData dir, so a language picked in the normal build would
  // otherwise suppress the workshop build's first-run picker.
  const [langStatus, setLangStatus] = useState('loading');

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

  // Resolve the persisted language from cache.json (the gate). A cached lang
  // means 'chosen'; no lang anywhere means first launch → 'unset', so the
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

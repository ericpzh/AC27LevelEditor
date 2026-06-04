import React, { createContext, useContext, useState, useCallback } from 'react';
import { T, getLang, setLang } from '../utils/i18n';

const I18nContext = createContext();

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => getLang());

  const t = useCallback((key, params) => {
    return T(key, params);
  }, [lang]); // re-create when lang changes so consumers re-render

  const toggleLang = useCallback(() => {
    const next = lang === 'zh' ? 'en' : 'zh';
    setLangState(next);
    setLang(next);
    try { localStorage.setItem('ac27_lang', next); } catch (_) {}
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

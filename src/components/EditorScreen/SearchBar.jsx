import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';

// Module-level API so jumpToCallsign can trigger search from outside
export const searchAPI = { current: null };

export default function SearchBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const flights = useAppStore(s => s.flights);

  // Expose search controls so jumpToCallsign can trigger from outside
  // setOpen, setTerm, inputRef are all stable references (useState/useRef)
  useEffect(() => {
    searchAPI.current = { setOpen, setTerm, inputRef };
    return () => { searchAPI.current = null; };
  }, [setOpen, setTerm, inputRef]);

  const doSearch = (val) => {
    setTerm(val);
    if (!val.trim()) { setMatches([]); return; }
    const lower = val.toLowerCase();
    const results = []; // DOM rows not in React — skip for now
    setMatches(results);
  };

  // Keyboard shortcut: Ctrl+F toggles search
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey||e.metaKey) && e.key === 'f' && useAppStore.getState().screen === 'editor') {
        e.preventDefault(); setOpen(o => { if (!o) setTimeout(() => inputRef.current?.focus(), 0); return !o; });
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  return (
    <div id="search-bar" className={`search-bar${open ? '' : ' hidden'}`}>
      <input ref={inputRef} id="search-input" type="text" value={term} onChange={e => doSearch(e.target.value)} placeholder={t('search_placeholder')} />
      <span id="search-count" className="search-count">{matches.length === 0 && term ? t('search_no_matches') : matches.length > 0 ? `${idx+1}/${matches.length}` : ''}</span>
      <button id="search-prev" className="btn-sm" onClick={() => setIdx(i => (i-1+matches.length)%matches.length)}>↑</button>
      <button id="search-next" className="btn-sm" onClick={() => setIdx(i => (i+1)%matches.length)}>↓</button>
      <button id="search-close" className="search-close" onClick={() => setOpen(false)}>✕</button>
    </div>
  );
}

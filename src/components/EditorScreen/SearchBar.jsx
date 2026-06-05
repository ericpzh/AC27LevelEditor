import React, { useState, useEffect, useRef, useCallback } from 'react';
import { IoChevronUp, IoChevronDown, IoClose } from 'react-icons/io5';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';

// Module-level API so jumpToCallsign / handleFind can trigger search from outside
export const searchAPI = { current: null };

export default function SearchBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const flights = useAppStore(s => s.flights);
  const setHighlightedIdx = useAppStore(s => s.setHighlightedIdx);
  const setSearchMatches = useAppStore(s => s.setSearchMatches);

  const doSearch = useCallback((val) => {
    setTerm(val);
    if (!val.trim()) { setMatches([]); setIdx(0); setSearchMatches([]); return; }
    const lower = val.toLowerCase();
    const matchField = (f) => {
      for (const key of Object.keys(f)) {
        const v = f[key];
        if (v != null && String(v).toLowerCase().includes(lower)) return true;
      }
      return false;
    };
    // Order matches in visual table order: arrivals top-to-bottom, then departures
    const results = [];
    for (let i = 0; i < flights.length; i++) {
      const f = flights[i];
      if ((f.LandingTime || '').trim() && matchField(f)) results.push(i);
    }
    for (let i = 0; i < flights.length; i++) {
      const f = flights[i];
      if (!(f.LandingTime || '').trim() && matchField(f)) results.push(i);
    }
    setSearchMatches(results);
    setMatches(results);
    if (results.length > 0) {
      setIdx(0);
      setHighlightedIdx(results[0]);
      scrollToRow(results[0]);
    }
  }, [flights, setHighlightedIdx, setSearchMatches]);

  // Expose search controls so jumpToCallsign / handleFind can trigger from outside
  useEffect(() => {
    searchAPI.current = { setOpen, setTerm, inputRef, doSearch };
    return () => { searchAPI.current = null; };
  }, [doSearch]);

  const scrollToRow = (globalIdx) => {
    // Find the <tr> whose first <td> has data-idx matching globalIdx
    const rows = document.querySelectorAll('.flight-table tbody tr');
    for (const row of rows) {
      const td = row.querySelector('td[data-idx]');
      if (td && parseInt(td.getAttribute('data-idx')) === globalIdx) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
    }
  };

  const goTo = useCallback((newIdx) => {
    if (!matches.length) return;
    const i = ((newIdx % matches.length) + matches.length) % matches.length;
    setIdx(i);
    setHighlightedIdx(matches[i]);
    scrollToRow(matches[i]);
  }, [matches, setHighlightedIdx]);

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

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goTo(idx - 1);
      else goTo(idx + 1);
    }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div id="search-bar" className={`search-bar${open ? '' : ' hidden'}`}>
      <span id="search-count" className="search-count">{term.trim() ? (matches.length > 0 ? `${idx+1}/${matches.length}` : t('search_no_matches')) : ''}</span>
      <input ref={inputRef} id="search-input" type="text" value={term} onChange={e => doSearch(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('search_placeholder')} />
      <button id="search-prev" className="btn-sm" onClick={() => goTo(idx - 1)} disabled={!matches.length}><IoChevronUp size={14} /></button>
      <button id="search-next" className="btn-sm" onClick={() => goTo(idx + 1)} disabled={!matches.length}><IoChevronDown size={14} /></button>
      <button id="search-close" className="search-close" onClick={() => { setOpen(false); setSearchMatches([]); }}><IoClose size={16} /></button>
    </div>
  );
}

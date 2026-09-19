import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  IoClose, IoKeyOutline, IoAlertCircle,
  IoRefreshOutline, IoGlobeOutline, IoLockClosed,
} from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import { useElectronAPI } from '../../../hooks/useElectronAPI';
import { useAppStore } from '../../../store/appStore';
import { buildFlightsFromAviationstack } from '../../../utils/realtime/aviationstack';
import './RealtimeImportModal.css';

// Notes that mean "a real value was replaced with a game-valid default".
const DEFAULT_NOTE_FIELDS = {
  realtime_note_flightnum_substituted: 'realtime_field_flightnum',
  realtime_note_type_defaulted: 'realtime_field_type',
  realtime_note_reg_defaulted: 'realtime_field_reg',
};

/** Collapse the "used a default" notes into one line: "航班号、机型、注册号已使用默认值". */
function consolidateNotes(notes, t) {
  const fields = [];
  for (const n of (notes || [])) {
    const key = DEFAULT_NOTE_FIELDS[n.key];
    if (key && !fields.includes(key)) fields.push(key);
  }
  if (fields.length === 0) return '';
  return t('realtime_note_defaults_used', {
    fields: fields.map(k => t(k)).join(t('realtime_list_sep')),
  });
}

export default function RealtimeImportModal({
  onClose, airportIcao, vals, configStartTime, configEndTime,
}) {
  const { t } = useTranslation();
  const api = useElectronAPI();
  const showToast = useAppStore(s => s.showToast);

  const [step, setStep] = useState('key');       // 'key' | 'import'
  const [configPath, setConfigPath] = useState('');
  const [keyInput, setKeyInput] = useState('');

  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [fetchNonce, setFetchNonce] = useState(0);

  const [candidates, setCandidates] = useState([]);   // [{flight, keep, notes, raw}]
  const [selected, setSelected] = useState(new Set());
  const [summary, setSummary] = useState({ total: 0, matched: 0, skipped: 0, reasons: {} });

  const handleFetch = useCallback(async () => {
    setFetching(true);
    setError(null);
    setCandidates([]);
    setSelected(new Set());
    try {
      // Always fetch both directions, every status, at the API's max page size.
      const res = await api.aviationstackFetch({ icao: airportIcao, direction: 'both', limit: 100 });
      if (!res.success) {
        setError(res.error || { code: 'unknown_error', message: 'Request failed.' });
        setFetching(false);
        return;
      }
      const raw = [
        ...(Array.isArray(res.arrivals) ? res.arrivals : []),
        ...(Array.isArray(res.departures) ? res.departures : []),
      ];
      const built = buildFlightsFromAviationstack(raw, {
        airportIcao, vals, configStartTime, configEndTime,
      });

      // Validate the mappable rows against the in-game constraints and demote failures.
      const kept = built.candidates.filter(c => c.keep && c.flight);
      const issuesByCallsign = new Map();
      if (kept.length > 0 && api.validateFlights) {
        try {
          const vres = await api.validateFlights(kept.map(c => c.flight), {
            currentAirport: airportIcao,
            configStartTime,
            configEndTime,
            runwayTimeline: useAppStore.getState().runwayTimeline,
            vals,
          });
          if (vres.success && Array.isArray(vres.issues)) {
            for (const issue of vres.issues) {
              if (issue.index >= 0) {
                const cs = kept[issue.index]?.flight?.CallSign;
                if (cs) issuesByCallsign.set(cs, issue.issue);
              }
            }
          }
        } catch (_) { /* validation is best-effort; mapper output is still gated on save */ }
      }

      const nextCandidates = built.candidates.map(c => {
        if (c.keep && c.flight && issuesByCallsign.has(c.flight.CallSign)) {
          return { ...c, keep: false, notes: [...c.notes, { key: 'realtime_note_validation_failed', params: { issue: issuesByCallsign.get(c.flight.CallSign) } }] };
        }
        return c;
      });

      // Only importable rows are shown — invalid ones are hidden entirely.
      const valid = nextCandidates.filter(c => c.keep && c.flight);
      setCandidates(valid);
      setSummary({
        total: built.summary.total,
        matched: valid.length,
        skipped: built.summary.total - valid.length,
        reasons: built.summary.reasons || {},
        retimed: !!built.summary.retimed,
      });
      setSelected(new Set(valid.map((_, i) => i)));
    } catch (e) {
      setError({ code: 'internal_error', message: e.message });
    }
    setFetching(false);
  }, [api, airportIcao, vals, configStartTime, configEndTime]);

  // Load stored key on mount; auto-fetch once when the import step is reached.
  useEffect(() => {
    (async () => {
      if (!api || !api.getConfig) return;
      try {
        const res = await api.getConfig();
        if (res.success) {
          setConfigPath(res.configPath || '');
          if (res.config.aviationstackKey) setStep('import');
        }
      } catch (_) { /* stay on key step */ }
    })();
  }, [api]);

  // Auto-fetch on entering the import step and on every retry. The ref guard
  // keeps it to exactly one fetch per nonce (React StrictMode double-invokes).
  const ranNonceRef = useRef(-1);
  useEffect(() => {
    if (step !== 'import') return;
    if (ranNonceRef.current === fetchNonce) return;
    ranNonceRef.current = fetchNonce;
    handleFetch();
  }, [step, fetchNonce, handleFetch]);

  const handleSaveKey = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) return;
    try {
      await api.saveConfig({ aviationstackKey: key });
      setKeyInput('');
      setStep('import');
      showToast(t('realtime_key_saved'), 'success');
    } catch (e) {
      setError({ code: 'save_failed', message: e.message });
    }
  }, [api, keyInput, showToast, t]);

  const toggleRow = (i) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleAll = () => {
    const selectable = candidates.map((c, i) => (c.keep ? i : -1)).filter(i => i >= 0);
    if (selected.size === selectable.length) setSelected(new Set());
    else setSelected(new Set(selectable));
  };

  const handleImport = useCallback(() => {
    const flights = candidates.filter((c, i) => selected.has(i) && c.flight).map(c => c.flight);
    if (flights.length === 0) return;
    // Replace the whole schedule with the imported flights.
    useAppStore.setState({ flights, modified: true, highlightedIdx: -1, selectedIndices: new Set() });
    showToast(t('realtime_imported', { n: String(flights.length) }), 'success');
    onClose();
  }, [candidates, selected, showToast, t, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const errorText = useMemo(() => {
    if (!error) return '';
    const map = {
      missing_access_key: 'realtime_err_invalid_key',
      invalid_access_key: 'realtime_err_invalid_key',
      https_access_restricted: 'realtime_err_https',
      function_access_restricted: 'realtime_err_plan',
      usage_limit_reached: 'realtime_err_quota',
      rate_limit_reached: 'realtime_err_quota',
      network_error: 'realtime_err_network',
      invalid_icao: 'realtime_err_no_airport',
    };
    const key = map[error.code];
    return key ? t(key) : (error.message || t('realtime_err_network'));
  }, [error, t]);

  const selectableCount = candidates.length;

  const skippedDetails = useMemo(() => {
    const entries = Object.entries(summary.reasons || {}).filter(([, c]) => c > 0);
    if (entries.length === 0) return '';
    return entries.map(([k, c]) => {
      // Note labels may carry a {{placeholder}}; strip it for the summary line.
      const text = t(k).replace(/\s*[（(]\s*\{\{[^}]+\}\}\s*[)）]/g, '').replace(/\{\{[^}]+\}\}/g, '').trim();
      return `${text} ×${c}`;
    }).join(' · ');
  }, [summary, t]);

  return createPortal(
    <div id="rt-overlay" onClick={onClose}>
      <div id="rt-panel" onClick={e => e.stopPropagation()}>
        <div id="rt-header">
          <div id="rt-title"><IoGlobeOutline size={16} className="btn-icon-accent" /> {t('realtime_title')}</div>
          <div id="rt-subtitle">{t('realtime_subtitle')} · {airportIcao}</div>
          <button id="rt-close" onClick={onClose} aria-label={t('modal_btn_cancel')}><IoClose size={18} /></button>
        </div>

        {step === 'key' && (
          <div id="rt-body" className="rt-key-step">
            <div className="rt-key-title"><IoKeyOutline size={14} /> {t('realtime_key_title')}</div>
            <p className="rt-hint">{t('realtime_key_sub')}</p>
            <div className="rt-key-row">
              <input
                type="password"
                className="rt-input"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder={t('realtime_key_placeholder')}
                autoFocus
              />
              <button className="btn-confirm" onClick={handleSaveKey} disabled={!keyInput.trim()}>
                {t('realtime_key_save')}
              </button>
            </div>
            {configPath && <div className="rt-config-path">{t('realtime_key_config_path', { path: configPath })}</div>}
            {error && <div className="rt-error"><IoAlertCircle size={13} /> {errorText}</div>}
          </div>
        )}

        {step === 'import' && (
          <>
            <div id="rt-body" className="rt-controls">
              <div className="rt-key-status">
                <button className="rt-link" onClick={() => { setError(null); setStep('key'); }}>
                  <IoLockClosed size={11} /> {t('realtime_key_replace')}
                </button>
              </div>
              {error && (
                <div className="rt-error">
                  <IoAlertCircle size={13} /> {errorText}
                  <button className="rt-link" onClick={() => setFetchNonce(n => n + 1)}>
                    <IoRefreshOutline size={11} /> {t('realtime_retry')}
                  </button>
                </div>
              )}
            </div>

            <div id="rt-results">
              {fetching && <div className="rt-empty">{t('realtime_fetching')}</div>}
              {!fetching && candidates.length === 0 && !error && (
                <div className="rt-empty">
                  <div>{t('realtime_no_results')}</div>
                  {skippedDetails && (
                    <div className="rt-skipped">{t('realtime_skipped_label')}: {skippedDetails}</div>
                  )}
                </div>
              )}
              {!fetching && candidates.length > 0 && (
                <>
                  <div className="rt-summary">
                    {t('realtime_summary', { matched: String(summary.matched), total: String(summary.total), skipped: String(summary.skipped) })}
                  </div>
                  {summary.retimed && (
                    <div className="rt-skipped">{t('realtime_retimed_notice')}</div>
                  )}
                  {skippedDetails && (
                    <div className="rt-skipped">{t('realtime_skipped_label')}: {skippedDetails}</div>
                  )}
                  <table className="rt-table">
                    <thead>
                      <tr>
                        <th className="rt-col-keep">
                          <input type="checkbox" checked={selectableCount > 0 && selected.size === selectableCount}
                            onChange={toggleAll} disabled={selectableCount === 0} />
                        </th>
                        <th>{t('realtime_col_callsign')}</th>
                        <th>{t('realtime_col_airline')}</th>
                        <th>{t('realtime_col_type')}</th>
                        <th>{t('realtime_col_reg')}</th>
                        <th>{t('realtime_col_route')}</th>
                        <th>{t('realtime_col_time')}</th>
                        <th>{t('realtime_col_note')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((c, i) => {
                        const f = c.flight;
                        const route = f.isDeparture
                          ? `${airportIcao} → ${f.ArrivalAirport || '?'}`
                          : `${f.DepartureAirport || '?'} → ${airportIcao}`;
                        const note = consolidateNotes(c.notes, t);
                        return (
                          <tr key={i}>
                            <td className="rt-col-keep">
                              <input type="checkbox" checked={selected.has(i)} onChange={() => toggleRow(i)} />
                            </td>
                            <td className="rt-mono">{f.CallSign}</td>
                            <td className="rt-mono">{f.AirlineName}</td>
                            <td>{f.AircraftType}</td>
                            <td className="rt-mono">{f.Registration || '—'}</td>
                            <td className="rt-mono">{route}</td>
                            <td className="rt-mono">{f.LandingTime || f.OffBlockTime || '—'}</td>
                            <td className="rt-note">{note}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            <div id="rt-actions">
              <button className="btn-cancel" onClick={onClose}>{t('modal_btn_cancel')}</button>
              <button className="btn-confirm" onClick={handleImport} disabled={fetching || selected.size === 0}>
                {t('realtime_import', { n: String(selected.size) })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

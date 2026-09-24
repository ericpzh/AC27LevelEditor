/**
 * useLiveWeatherImport — past-24h live weather import (aviationweather.gov
 * METAR history, TAF fallback) for the editor toolbar.
 *
 * One click replaces BOTH timelines: full-day weather frames (consecutive
 * duplicates collapsed) + wind frames on a 15-minute grid across the level
 * window (see src/utils/realtime/metar.js). All params mirror
 * useEditorSaveActions so EditorScreen can wire it the same way.
 *
 * @param {object} opts
 * @param {object} opts.electronAPI — from useElectronAPI()
 * @param {function} opts.t — i18n translate function
 * @param {function} opts.showToast — store.showToast
 * @returns {{ importLiveWeather: function, liveWeatherLoading: boolean }}
 */
import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { timeToMinutes } from '../utils/timeUtils';
import { buildLiveTimelines, timezoneForIcao } from '../utils/realtime/metar';

export function useLiveWeatherImport({ electronAPI, t, showToast }) {
  const [liveWeatherLoading, setLiveWeatherLoading] = useState(false);

  const importLiveWeather = async () => {
    const pre = useAppStore.getState();
    const icao = String(pre.currentAirport || '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao)) { showToast(t('tl_live_no_airport'), 'error'); return; }
    if (!electronAPI?.fetchLiveMetar) {
      showToast(t('tl_live_failed', { icao, err: 'IPC unavailable' }), 'error');
      return;
    }
    setLiveWeatherLoading(true);
    try {
      const res = await electronAPI.fetchLiveMetar(icao);
      if (!res?.success) {
        const code = res?.error?.code;
        showToast(t(code === 'no_data' ? 'tl_live_no_data' : 'tl_live_failed',
          { icao, err: res?.error?.message || code || '?' }), 'error');
        return;
      }
      const toMin = (v) => {
        if (v == null || v === '') return null;
        const m = timeToMinutes(String(v).substring(0, 8));
        return Number.isFinite(m) ? m : null;
      };
      const st = useAppStore.getState();
      const { weatherFrames, windFrames } = buildLiveTimelines(res, {
        timeZone: timezoneForIcao(icao),
        startMin: toMin(st._configStartTime),
        endMin: toMin(st._configEndTime),
      });
      if (weatherFrames.length === 0) { showToast(t('tl_live_no_data', { icao }), 'error'); return; }
      useAppStore.setState({
        weatherTimeline: weatherFrames.map(f => ({ ...f, _isNew: true })),
        windTimeline: windFrames.map(f => ({ ...f, _isNew: true })),
      });
      st.setTimelineModified('weather', true);
      st.setTimelineModified('wind', true);
      showToast(t('tl_live_ok',
        { icao, source: res.source, n: weatherFrames.length, m: windFrames.length }), 'success');
    } catch (e) {
      showToast(t('tl_live_failed', { icao, err: e?.message || e }), 'error');
    } finally {
      setLiveWeatherLoading(false);
    }
  };

  return { importLiveWeather, liveWeatherLoading };
}

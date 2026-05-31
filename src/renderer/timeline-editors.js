// ═══════════ WEATHER EDITOR ═══════════════════════════════

const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

function renderWeatherEditor() {
  const list = document.getElementById('weather-list');
  if (!list) return;

  list.innerHTML = appState.weatherTimeline.map((entry, i) => `
    <div class="tl-row" data-idx="${i}">
      <span class="tl-idx">${i + 1}</span>
      <select class="tl-select" data-field="preset" data-idx="${i}">
        ${WEATHER_PRESETS.map(p => `<option value="${p}" ${entry.preset === p ? 'selected' : ''}>${p}</option>`).join('')}
        ${!WEATHER_PRESETS.includes(entry.preset) ? `<option value="${entry.preset}" selected>${entry.preset}</option>` : ''}
      </select>
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${i}" value="${entry.time || ''}" placeholder="HH:MM:SS" readonly>
      <button class="tl-btn-del" data-idx="${i}" title="删除">X</button>
    </div>
  `).join('');

  list.querySelectorAll('.tl-select').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      appState.weatherTimeline[i].preset = el.value;
      appState.timelineModified.weather = true;
      updateTimelineStatus();
    });
  });

  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '天气', i, el.value, (newVal) => {
        appState.weatherTimeline[i].time = newVal;
        appState.timelineModified.weather = true;
        updateTimelineStatus();
        renderWeatherEditor();
      });
    });
  });

  list.querySelectorAll('.tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.weatherTimeline.splice(i, 1);
      appState.timelineModified.weather = true;
      updateTimelineStatus();
      renderWeatherEditor();
    });
  });

  updateTimelineStatus();
}

document.getElementById('btn-weather-add').addEventListener('click', () => {
  const lastTime = appState.weatherTimeline.length > 0
    ? appState.weatherTimeline[appState.weatherTimeline.length - 1].time : '06:00:00';
  appState.weatherTimeline.push({ preset: 'Sunny', time: lastTime });
  appState.timelineModified.weather = true;
  updateTimelineStatus();
  renderWeatherEditor();
});

// ═══════════ WIND EDITOR ══════════════════════════════════

function renderWindEditor() {
  const list = document.getElementById('wind-list');
  if (!list) return;

  list.innerHTML = appState.windTimeline.map((entry, i) => `
    <div class="tl-row" data-idx="${i}">
      <span class="tl-idx">${i + 1}</span>
      <input class="tl-input tl-int" type="text" inputmode="numeric" data-field="direction" data-idx="${i}" value="${entry.direction || 0}">
      <span class="tl-label-sm">deg</span>
      <input class="tl-input tl-int" type="text" inputmode="numeric" data-field="speed" data-idx="${i}" value="${entry.speed || 0}">
      <span class="tl-label-sm">kt</span>
      <input class="tl-input tl-time-click" type="text" data-field="time" data-idx="${i}" value="${entry.time || ''}" placeholder="HH:MM:SS" readonly>
      <button class="tl-btn-del" data-idx="${i}" title="删除">X</button>
    </div>
  `).join('');

  list.querySelectorAll('.tl-input[data-field="direction"], .tl-input[data-field="speed"]').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      appState.windTimeline[i][field] = parseInt(el.value) || 0;
      appState.timelineModified.wind = true;
      updateTimelineStatus();
    });
  });

  list.querySelectorAll('.tl-time-click').forEach(el => {
    el.addEventListener('click', () => {
      if (appState.editingWidget) return;
      const i = parseInt(el.dataset.idx);
      openTimeClockPopover(el, '风向', i, el.value, (newVal) => {
        appState.windTimeline[i].time = newVal;
        appState.timelineModified.wind = true;
        updateTimelineStatus();
        renderWindEditor();
      });
    });
  });

  list.querySelectorAll('.tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.windTimeline.splice(i, 1);
      appState.timelineModified.wind = true;
      updateTimelineStatus();
      renderWindEditor();
    });
  });

  updateTimelineStatus();
}

document.getElementById('btn-wind-add').addEventListener('click', () => {
  const lastTime = appState.windTimeline.length > 0
    ? appState.windTimeline[appState.windTimeline.length - 1].time : '06:00:00';
  appState.windTimeline.push({ direction: 180, speed: 5, time: lastTime });
  appState.timelineModified.wind = true;
  updateTimelineStatus();
  renderWindEditor();
});

// ═══════════ RUNWAY EDITOR ════════════════════════════════

function renderRunwayEditor() {
  const container = document.getElementById('runway-editor');
  if (!container) return;

  const rw = appState.runwayTimeline;
  const initialStr = (rw.initialRunways || []).join(', ');

  const rwOptions = (appState.airportValues[appState.currentAirport]?.Runway) ||
    [...new Set(appState.flights.map(f => (f.Runway || '').trim()).filter(Boolean))];

  container.innerHTML = `
    <div class="rw-section">
      <div class="rw-section-title">初始跑道</div>
      <div class="rw-initial-row">
        <input id="rw-initial-input" class="tl-input" type="text" value="${escapeHtml(initialStr)}" placeholder="如: 4L, 4R, 31L, 31R">
        <button id="btn-rw-initial-save" class="btn-sm">应用</button>
      </div>
    </div>
    <div class="rw-section">
      <div class="rw-section-title">跑道变更时间线 <button id="btn-rw-change-add" class="btn-sm">+ 添加变更</button></div>
      <div id="rw-changes-list">
        ${(rw.timeline || []).map((tle, i) => `
          <div class="rw-change-card">
            <div class="rw-change-header">
              <span class="tl-idx">变更 ${i + 1}</span>
              <input class="tl-input rw-time-input" type="text" data-idx="${i}" data-field="time" value="${tle.time || ''}" placeholder="HH:MM:SS">
              <button class="tl-btn-del" data-idx="${i}" title="删除此变更">X</button>
            </div>
            <div class="rw-change-pairs">
              ${(tle.changes || []).map((ch, j) => `
                <div class="rw-pair">
                  <span class="rw-pair-label">从</span>
                  <select class="tl-select rw-pair-input" data-tli="${i}" data-idx="${j}" data-field="source">
                    <option value="">—</option>
                    ${rwOptions.map(v => `<option value="${escapeHtml(v)}" ${ch.source === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                  <span>&rarr;</span>
                  <span class="rw-pair-label">到</span>
                  <select class="tl-select rw-pair-input" data-tli="${i}" data-idx="${j}" data-field="dest">
                    <option value="">—</option>
                    ${rwOptions.map(v => `<option value="${escapeHtml(v)}" ${ch.dest === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                  </select>
                  <button class="tl-btn-del-sm" data-tli="${i}" data-idx="${j}" title="删除此对">&times;</button>
                </div>
              `).join('')}
              <button class="btn-sm rw-add-pair" data-tli="${i}">+ 添加跑道对</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Initial runways save
  document.getElementById('btn-rw-initial-save').addEventListener('click', () => {
    const val = document.getElementById('rw-initial-input').value;
    appState.runwayTimeline.initialRunways = val.split(',').map(s => s.trim()).filter(Boolean);
    appState.timelineModified.runway = true;
    updateTimelineStatus();
  });

  // Change time
  container.querySelectorAll('.rw-time-input').forEach(el => {
    el.addEventListener('change', () => {
      const i = parseInt(el.dataset.idx);
      appState.runwayTimeline.timeline[i].time = el.value;
      appState.timelineModified.runway = true;
      updateTimelineStatus();
    });
  });

  // Pair fields
  container.querySelectorAll('.rw-pair-input').forEach(el => {
    el.addEventListener('change', () => {
      const tli = parseInt(el.dataset.tli);
      const idx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      appState.runwayTimeline.timeline[tli].changes[idx][field] = el.value;
      appState.timelineModified.runway = true;
      updateTimelineStatus();
    });
  });

  // Delete pair
  container.querySelectorAll('.tl-btn-del-sm').forEach(btn => {
    btn.addEventListener('click', () => {
      const tli = parseInt(btn.dataset.tli);
      const idx = parseInt(btn.dataset.idx);
      appState.runwayTimeline.timeline[tli].changes.splice(idx, 1);
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Delete change card
  container.querySelectorAll('.rw-change-card .tl-btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      appState.runwayTimeline.timeline.splice(i, 1);
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Add pair button
  container.querySelectorAll('.rw-add-pair').forEach(btn => {
    btn.addEventListener('click', () => {
      const tli = parseInt(btn.dataset.tli);
      appState.runwayTimeline.timeline[tli].changes.push({ source: '', dest: '' });
      appState.timelineModified.runway = true;
      updateTimelineStatus();
      renderRunwayEditor();
    });
  });

  // Add change button
  document.getElementById('btn-rw-change-add').addEventListener('click', () => {
    appState.runwayTimeline.timeline.push({ time: '12:00:00', changes: [] });
    appState.timelineModified.runway = true;
    updateTimelineStatus();
    renderRunwayEditor();
  });

  updateTimelineStatus();
}

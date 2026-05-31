// ─── Add Arrival Flight ──────────────────────────────────
document.getElementById('btn-add-arrival').addEventListener('click', addArrivalFlight);

function addArrivalFlight() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const audioData = appState.audioCallsigns;
  const newFlight = {};
  for (const [fn] of ALL_FIELDS) newFlight[fn] = '';

  let airlineCode = 'NEW';
  if (audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
  else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);
  newFlight.CallSign = airlineCode + String(nextFlightNumber++);
  newFlight.ArrivalAirport = appState.currentAirport || '';
  newFlight.LandingTime = '06:00:00';
  newFlight.InBlockTime = '06:05:00';
  newFlight.Language = 'en';
  if (values.AircraftType && values.AircraftType.length > 0) newFlight.AircraftType = values.AircraftType[0];
  if (values.AirlineName && values.AirlineName.length > 0) newFlight.AirlineName = values.AirlineName[0];
  if (values.Stand && values.Stand.length > 0) newFlight.Stand = values.Stand[0];
  if (values.Runway && values.Runway.length > 0) newFlight.Runway = values.Runway[0];

  appState.flights.push(newFlight);
  appState.modified = true;
  appState.selectedIndices = new Set([appState.flights.length - 1]);
  renderAllSections();
  showToast('已添加进港航班 ' + newFlight.CallSign, 'success');
}

// ─── Add Departure Flight ────────────────────────────────
document.getElementById('btn-add-departure').addEventListener('click', addDepartureFlight);

function addDepartureFlight() {
  const values = appState.airportValues[appState.currentAirport] || {};
  const audioData = appState.audioCallsigns;
  const newFlight = {};
  for (const [fn] of ALL_FIELDS) newFlight[fn] = '';

  let airlineCode = 'NEW';
  if (audioData.allAirlines.length > 0) airlineCode = audioData.allAirlines[0];
  else if (values.AirlineName && values.AirlineName.length > 0) airlineCode = getAirlineCode(values.AirlineName[0]);
  newFlight.CallSign = airlineCode + String(nextFlightNumber++);
  newFlight.DepartureAirport = appState.currentAirport || '';
  newFlight.OffBlockTime = '06:00:00';
  newFlight.TakeoffTime = '06:05:00';
  newFlight.Language = 'en';
  if (values.AircraftType && values.AircraftType.length > 0) newFlight.AircraftType = values.AircraftType[0];
  if (values.AirlineName && values.AirlineName.length > 0) newFlight.AirlineName = values.AirlineName[0];
  if (values.Stand && values.Stand.length > 0) newFlight.Stand = values.Stand[0];
  if (values.Runway && values.Runway.length > 0) newFlight.Runway = values.Runway[0];

  appState.flights.push(newFlight);
  appState.modified = true;
  appState.selectedIndices = new Set([appState.flights.length - 1]);
  renderAllSections();
  showToast('已添加离港航班 ' + newFlight.CallSign, 'success');
}

// ─── Delete Selected ─────────────────────────────────────
document.getElementById('btn-delete-selected').addEventListener('click', deleteSelected);

function deleteSelected() {
  if (appState.selectedIndices.size === 0) { showToast('请先勾选要删除的航班', 'error'); return; }

  const indices = [...appState.selectedIndices].sort((a, b) => b - a);
  const names = indices.map(i => appState.flights[i].CallSign || '#' + (i + 1));

  showModal('确认删除', `<p>确定要删除以下 <strong>${indices.length}</strong> 个航班吗？</p>
    <p style="font-size:12px;color:var(--text-muted);max-height:120px;overflow-y:auto;word-break:break-all">
      ${names.map(n => escapeHtml(n)).join(', ')}
    </p>
    <p style="font-size:11px;color:var(--red)">此操作不可撤销。</p>`,
    `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-danger" id="modal-confirm">删除 ${indices.length} 个</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    hideModal();
    for (const idx of indices) appState.flights.splice(idx, 1);
    appState.selectedIndices = new Set();
    appState.highlightedIdx = -1;
    autoSort();
    appState.modified = true;
    renderAllSections();
    showToast(`已删除 ${indices.length} 个航班`, 'success');
  };
}

// ─── Delete All ──────────────────────────────────────────
document.getElementById('btn-delete-all').addEventListener('click', deleteAll);

function deleteAll() {
  if (appState.flights.length === 0) { showToast('没有航班可删除', 'error'); return; }
  const count = appState.flights.length;
  showModal('确认全部删除', `<p>确定要删除全部 <strong>${count}</strong> 个航班吗？此操作不可撤销。</p>`,
    `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-danger" id="modal-confirm">全部删除</button>`);
  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = () => {
    hideModal();
    appState.flights = [];
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    appState.modified = true;
    document.querySelectorAll('.section-block').forEach(s => {
      s.classList.remove('collapsed');
      const arrow = s.querySelector('.collapse-arrow');
      if (arrow) arrow.textContent = '▾';
    });
    renderAllSections();
    showToast(`已删除全部 ${count} 个航班`, 'success');
  };
}

// ─── Copy Row ────────────────────────────────────────────
document.getElementById('btn-copy').addEventListener('click', copyHighlighted);

function copyHighlighted() {
  if (appState.highlightedIdx < 0) { showToast('请先点击选择要复制的航班', 'error'); return; }
  const idx = appState.highlightedIdx;
  const source = appState.flights[idx];
  const copy = { ...source };
  copy.CallSign = (source.CallSign || '') + '_CP';
  appState.flights.splice(idx + 1, 0, copy);
  appState.highlightedIdx = idx + 1;
  appState.modified = true;
  renderAllSections();
  showToast('已复制航班，插入到下方', 'success');
}

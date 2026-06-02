// ═══════════ SCREEN 1: BROWSER ═════════════════════════

// Closable browser note (persists across sessions)
document.getElementById('browser-note-close').addEventListener('click', () => {
  document.getElementById('browser-note').classList.add('hidden');
  try { localStorage.setItem('browser-note-dismissed', '1'); } catch (_) {}
});

async function showBrowser() {
  showScreen('browser');
  document.getElementById('browser-root-path').textContent = appState.rootPath || '';

  // Show info note unless previously dismissed
  if (!localStorage.getItem('browser-note-dismissed')) {
    document.getElementById('browser-note').classList.remove('hidden');
  }

  const loading = document.getElementById('browser-loading');
  const list = document.getElementById('browser-list');
  loading.classList.remove('hidden');
  list.innerHTML = '';

  if (appState.airports.length === 0 && appState.rootPath) {
    const scan = await window.electronAPI.scanAcls(appState.rootPath);
    if (!scan.error) appState.airports = scan.airports || [];
  }

  // Sort by hardcode ID, unknown airports go last
  appState.airports.sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));

  for (const airport of appState.airports) {
    const infos = await window.electronAPI.getAirportFilesInfo(airport.icao, appState.rootPath);
    // Classify & tag every file
    for (const info of infos) {
      const name = info.filename.toLowerCase();
      info._hidden = false;
      info._metaLabels = [];
      if (info.error) {
        info._hidden = true;
        info._metaLabels.push({ label: '解析失败', type: 'error' });
      } else if (/tutorial/i.test(name)) {
        info._hidden = true;
        info._metaLabels.push({ label: '教程', type: 'tutorial' });
      } else if (/demo/i.test(name)) {
        info._hidden = true;
        info._metaLabels.push({ label: 'Demo', type: 'demo' });
      } else if (/bench|test|crossrunway|dev|\.prod/i.test(name)) {
        info._hidden = true;
        info._metaLabels.push({ label: '测试', type: 'test' });
      } else if (/endless/i.test(name)) {
        info._hidden = true;
        info._metaLabels.push({ label: '无尽', type: 'endless' });
      }
      // Time range label (from .aclcfg startTime/endTime) — all from file CONTENT, not filename
      if (!info._hidden && info.startTime && info.endTime) {
        const toHHMM = s => String(s).substring(0, 5);
        info._metaLabels.push({ label: toHHMM(info.startTime) + '-' + toHHMM(info.endTime), type: 'timerange' });
        // Infer time-of-day from start hour
        const startH = parseInt(String(info.startTime).substring(0, 2));
        let todLabel;
        if (startH >= 5 && startH < 7) todLabel = '黎明';
        else if (startH >= 7 && startH < 12) todLabel = '上午';
        else if (startH >= 12 && startH < 17) todLabel = '下午';
        else if (startH >= 17 && startH < 19) todLabel = '黄昏';
        else todLabel = '夜晚';
        info._metaLabels.push({ label: todLabel, type: 'tod' });
      }
    }
    // Sort: Tutorial always first, then by startTime ascending
    infos.sort((a, b) => {
      const aTutorial = /tutorial/i.test(a.filename) ? 0 : 1;
      const bTutorial = /tutorial/i.test(b.filename) ? 0 : 1;
      if (aTutorial !== bTutorial) return aTutorial - bTutorial;
      const aTime = a.startTime || '99:99';
      const bTime = b.startTime || '99:99';
      return aTime.localeCompare(bTime);
    });
    airport._fileInfos = infos || [];
  }

  loading.classList.add('hidden');

  const showAll = _showHiddenFiles;

  if (appState.airports.length === 0) {
    list.innerHTML = '<div class="browser-empty">未找到任何 .acl 关卡文件</div>';
    return;
  }

  list.innerHTML = appState.airports.map(airport => {
    const infos = airport._fileInfos || [];
    const dispName = airportDisplayName(airport.icao);

    const rows = infos.map(info => {
      // Filter hidden rows unless toggle is on
      if (info._hidden && !showAll) return '';

      if (info.error) {
        const labelTags = (info._metaLabels || []).map(l =>
          `<span class="level-tag tag-${l.type}">${escapeHtml(l.label)}</span>`
        ).join('');
        return `<div class="level-row level-row-error">
          <span class="level-name">${info.filename}</span>
          ${labelTags ? `<span class="level-tags">${labelTags}</span>` : ''}
          <span class="level-stats" style="color:var(--red)">${info.error}</span>
          <span class="level-arrow">&rarr;</span>
        </div>`;
      }
      const displayName = stripSuffixes(info.filename);
      const allTags = info._metaLabels || [];
      // Build primary row title: tod + time range, fallback to filename
      const todTag = allTags.find(t => t.type === 'tod');
      const trTag = allTags.find(t => t.type === 'timerange');
      const timeTag = allTags.find(t => t.type === 'time');
      let rowTitle = displayName;
      if (todTag && trTag) {
        rowTitle = `${todTag.label} ${trTag.label}`;
      } else if (todTag && timeTag) {
        rowTitle = `${todTag.label} ${timeTag.label}`;
      }
      // Remove display-oriented tags from badge list (tod/time/timerange are now in row title)
      const badgeTags = allTags.filter(t => t.type !== 'tod' && t.type !== 'time' && t.type !== 'timerange');
      const tagsHtml = badgeTags.length > 0
        ? `<span class="level-tags">${badgeTags.map(t => `<span class="level-tag tag-${t.type}">${escapeHtml(t.label)}</span>`).join('')}</span>`
        : '';
      const hasCustomTitle = rowTitle !== displayName;
      return `<div class="level-row" data-path="${escapeHtml(info.path)}" data-airport="${escapeHtml(airport.icao)}">
        <span class="level-name">${rowTitle}</span>
        ${hasCustomTitle ? `<span class="level-filename">${displayName}</span>` : ''}
        ${tagsHtml}
        <span class="level-stats">
          <span class="level-stat"><span class="level-stat-dot arrival"></span>进港 ${info.arrivals || 0}</span>
          <span class="level-stat"><span class="level-stat-dot departure"></span>离港 ${info.departures || 0}</span>
        </span>
        <span class="level-arrow">&rarr;</span>
      </div>`;
    }).join('');

    return `<div class="airport-card">
      <div class="airport-card-header">
        <span class="airport-icao">${dispName}</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  list.querySelectorAll('.level-row[data-path]').forEach(row => {
    row.addEventListener('click', async () => {
      const filePath = row.dataset.path;
      const airportIcao = row.dataset.airport;
      await openEditor(filePath, airportIcao);
    });
  });
}

document.getElementById('btn-change-root').addEventListener('click', () => {
  showScreen('setup');
});

let _showHiddenFiles = false;

document.getElementById('btn-toggle-hidden').addEventListener('click', () => {
  _showHiddenFiles = !_showHiddenFiles;
  const btn = document.getElementById('btn-toggle-hidden');
  btn.textContent = _showHiddenFiles ? '隐藏文件' : '显示隐藏';
  btn.classList.toggle('active', _showHiddenFiles);
  showBrowser();
});

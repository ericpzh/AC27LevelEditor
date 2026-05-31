// ─── Screen Navigation ──────────────────────────────────
function showScreen(name) {
  appState.screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.remove('hidden');
}

// ─── Toast ──────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = type; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Modal ──────────────────────────────────────────────
function showModal(title, bodyHtml, actionsHtml) {
  const o = document.getElementById('modal-overlay');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-actions').innerHTML = actionsHtml;
  o.classList.remove('hidden');
}
function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

function showAlert(title, msg) {
  showModal(title, `<p>${msg}</p>`, `<button class="btn-confirm" id="modal-ok">确定</button>`);
  document.getElementById('modal-ok').onclick = hideModal;
}

// ─── HTML escaping ──────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strip .Prod.acl, .Stage.Prod.acl etc. to show clean filename
function stripSuffixes(name) {
  return name.replace(/(\.[a-zA-Z0-9]+)+\.acl$/i, '.acl');
}

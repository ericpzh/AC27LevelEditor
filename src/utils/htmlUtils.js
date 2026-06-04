export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function stripSuffixes(name) {
  return name
    .replace(/^flight_schedule_/i, '')
    .replace(/\.acl$/i, '')
    .replace(/_/g, ' ');
}

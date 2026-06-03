// i18n — language switch, pure JS, no dependencies
var LANG = (function(){ try { return localStorage.getItem('ac27_lang') || 'zh'; } catch(_) { return 'zh'; } })();

// Alias: t() = T() for backward compat with existing code
function t(key, params) { return T(key, params); }

var STR = {
  zh: {},
  en: {}
};

function T(key, params) {
  var s = (STR[LANG] && STR[LANG][key]) || STR.zh[key] || key;
  if (params) for (var k in params) s = s.split('{{'+k+'}}').join(params[k]);
  return s;
}

// ── Set string by key + Chinese fallback ──
function S(id, key, fallback) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = T(key) || fallback || '';
}
function SH(id, key, fallback) {
  var el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = T(key) || fallback || '';
}
function SP(id, key, fallback) {
  var el = document.getElementById(id);
  if (!el) return;
  el.placeholder = T(key) || fallback || '';
}

// ═══════════════════════════════════════════
//  TRANSLATIONS
// ═══════════════════════════════════════════
STR.zh = {
setup_title:'AC27 Level Editor',
setup_sub:'请先定位游戏安装目录以扫描所有关卡文件',
setup_steam_title:'如何通过 Steam 找到游戏目录',
setup_steam_step1:'打开 Steam 库 → 找到 <strong>Airport Control 27</strong>',
setup_steam_step2:'右键 → <strong>管理</strong> → <strong>浏览本地文件</strong>',
setup_steam_step3:'在弹出的文件夹中复制路径，或直接选择',
setup_steam_path_label:'通常路径如：',
setup_nightly:'请切换到<strong>nightly</strong>游戏版本（属性 → 游戏版本及测试版 → nightly）',
setup_select_root:'选择游戏根目录',
browser_title:'关卡列表', browser_change_dir:'更换目录',
browser_toggle_hidden:'显示隐藏', browser_hide_hidden:'隐藏文件',
browser_note:'⚠ 部分关卡的时间线已整合到更大范围关卡的时间线中（如 05:45-06:15 整合到 05:00-07:00 中）',
browser_loading:'正在扫描关卡文件…', browser_no_files:'未找到任何 .acl 关卡文件',
browser_parse_error:'解析失败', browser_tag_tutorial:'教程', browser_tag_test:'测试', browser_tag_endless:'无尽',
browser_tod_dawn:'黎明', browser_tod_morning:'上午', browser_tod_afternoon:'下午', browser_tod_dusk:'黄昏', browser_tod_night:'夜晚',
toolbar_back:'← 返回', toolbar_add_arrival:'+ 添加进港', toolbar_add_departure:'+ 添加离港',
toolbar_copy:'复制', toolbar_delete_selected:'删除选中', toolbar_delete_all:'全部删除',
toolbar_time_range:'时间段：', toolbar_backup:'备份', toolbar_restore:'还原备份',
toolbar_import:'导入', toolbar_save_as:'另存为', toolbar_save:'保存',
search_placeholder:'查找航班… (Enter/↓ 下一个, Shift+Enter/↑ 上一个)',
tl_weather:'天气', tl_wind:'风向', tl_runway:'跑道', tl_add:'+ 添加',
table_arrivals:'进港', table_departures:'离港', table_no_flights:'无匹配的航班记录',
lang_switch_to:'English',
airport_ZSJN:'ZSJN — 济南遥墙机场', airport_KJFK:'KJFK — 约翰·肯尼迪国际机场', airport_EGLC:'EGLC — 伦敦城市机场',
field_AirlineCode:'航司代码', field_FlightNum:'航班号', field_CallSign:'呼号',
field_DepartureAirport:'出发', field_ArrivalAirport:'到达', field_Stand:'停机位', field_Runway:'跑道',
field_OffBlockTime:'推出', field_TakeoffTime:'起飞', field_LandingTime:'落地', field_InBlockTime:'入位',
field_AirlineName:'航司', field_AircraftType:'机型', field_Airway:'进场程序',
field_Registration:'注册号', field_Voice:'语音', field_Language:'语言',
modal_duplicate_title:'呼号重复',
modal_duplicate_body:'以下呼号出现了多次，请修正后再保存：',
modal_duplicate_save_cancelled:'保存已取消。',
modal_duplicate_export_cancelled:'导出已取消。',
modal_issues_title:'{{n}} 个问题需要修复后才能保存',
modal_issues_export_title:'{{n}} 个问题需要修复后才能导出',
modal_issues_fix_hint_save:'请在修复所有问题后再保存。',
modal_issues_fix_hint_export:'请在修复所有问题后再导出。',
modal_backup_title:'保存前备份', modal_backup_checkbox:'创建 .bak 备份',
modal_btn_cancel:'取消', modal_btn_confirm_save:'确定保存', modal_btn_close:'关闭', modal_btn_ok:'确定',
modal_save_success:'保存成功', modal_save_failed:'保存失败',
modal_delete_confirm:'确认删除', modal_delete_irreversible:'此操作不可撤销。', modal_delete_btn:'删除 {{n}} 个',
modal_delete_all_confirm:'确认全部删除', modal_delete_all_btn:'全部删除',
modal_unsaved_title:'未保存的更改',
modal_unsaved_body:'当前文件有未保存的更改，确定要返回吗？',
modal_unsaved_body_full:'当前文件有未保存的更改（航班或时间线），确定要返回关卡列表吗？',
modal_btn_discard:'放弃更改',
modal_import_backup_title:'导入前备份',
modal_import_body:'导入将覆盖当前所有关卡文件（.acl / .csv / 时间线）。',
modal_import_checkbox:'导入前创建 .bak 备份', modal_btn_import:'确定导入',
modal_import_failed:'导入失败', modal_import_success:'导入成功 ✓',
modal_import_success_body:'已成功导入关卡文件', modal_import_count:'共 <strong>{{n}}</strong> 个航班',
modal_restore_title:'还原备份确认',
modal_restore_body:'将从最新的 <code>.bak</code> 备份文件还原：',
modal_restore_acl:'.acl.bak → .acl', modal_restore_csv:'.csv.bak → .csv',
modal_restore_json:'.json.bak → .json（天气/风力/跑道时间线）',
modal_restore_warning:'⚠ 当前未保存的更改将丢失。',
modal_btn_restore:'确认还原', modal_restore_failed:'还原失败',
val_airline_not_in_whitelist:'{{cs}}: 航司代码 "{{code}}" 不在有效白名单中',
val_flightnum_not_valid:'{{cs}}: 航班号 "{{num}}" 不在航司 {{code}} 的有效列表中',
val_field_not_in_options:'{{cs}}: {{field}} "{{val}}" 不在有效选项中',
val_time_out_of_range:'{{cs}}: {{field}} "{{time}}" 超出范围 ({{hint}})',
val_inblock_after_landing:'{{cs}}: 入位 "{{ib}}" 应晚于落地 "{{ld}}"',
val_offblock_before_takeoff:'{{cs}}: 推出 "{{ob}}" 应早于起飞 "{{to}}"',
val_runway_change_bounds:'跑道变更 #{{i}}: 时间 "{{time}}" 不在关卡范围内 ({{min}} ~ {{max}})（须严格介于起止时间之间）',
val_runway_not_active:'{{cs}}: 在 {{time}} 时刻，跑道 "{{rwy}}" 不在活跃跑道列表中',
toast_no_file:'没有打开的文件', toast_no_flight_data:'没有航班数据可保存',
toast_copied_n:'已复制 {{n}} 个航班', toast_deleted_n:'已删除 {{n}} 个航班', toast_deleted_all:'已删除全部 {{n}} 个航班',
toast_no_flights_selected:'请先勾选要删除的航班', toast_no_flights_to_delete:'没有航班可删除',
toast_select_to_copy:'请先点击选择要复制的航班',
toast_added_arrival:'已添加进港航班 {{cs}}', toast_added_departure:'已添加离港航班 {{cs}}',
toast_exported:'已导出: {{name}}', toast_backup_saved:'备份已保存: {{name}}',
toast_restored_n:'已还原 {{n}} 个航班（{{items}}）', toast_imported_n:'已导入 {{n}} 个航班',
};

STR.en = {
setup_title:'AC27 Level Editor',
setup_sub:'Select the game installation directory to scan all level files',
setup_steam_title:'How to find the game directory via Steam',
setup_steam_step1:'Steam Library → right-click <strong>Airport Control 27</strong>',
setup_steam_step2:'Right-click → <strong>Manage</strong> → <strong>Browse local files</strong>',
setup_steam_step3:'Copy the folder path, or select it directly',
setup_steam_path_label:'Typical path:',
setup_nightly:'Switch to the <strong>nightly</strong> game version (Properties → Betas → nightly)',
setup_select_root:'Select Game Root',
browser_title:'Levels', browser_change_dir:'Change Folder',
browser_toggle_hidden:'Show Hidden', browser_hide_hidden:'Hide Files',
browser_note:'⚠ Some level timelines are incorporated into larger levels (e.g. 05:45-06:15 is part of 05:00-07:00)',
browser_loading:'Scanning level files…', browser_no_files:'No .acl level files found',
browser_parse_error:'Parse Error', browser_tag_tutorial:'Tutorial', browser_tag_test:'Test', browser_tag_endless:'Endless',
browser_tod_dawn:'Dawn', browser_tod_morning:'Morning', browser_tod_afternoon:'Afternoon', browser_tod_dusk:'Dusk', browser_tod_night:'Night',
toolbar_back:'← Back', toolbar_add_arrival:'+ Add Arrival', toolbar_add_departure:'+ Add Departure',
toolbar_copy:'Copy', toolbar_delete_selected:'Delete Selected', toolbar_delete_all:'Delete All',
toolbar_time_range:'Time: ', toolbar_backup:'Backup', toolbar_restore:'Restore',
toolbar_import:'Import', toolbar_save_as:'Save As', toolbar_save:'Save',
search_placeholder:'Find flight… (Enter/↓ next, Shift+Enter/↑ prev)',
tl_weather:'Weather', tl_wind:'Wind', tl_runway:'Runway', tl_add:'+ Add',
table_arrivals:'Arrivals', table_departures:'Departures', table_no_flights:'No matching flights',
lang_switch_to:'中文',
airport_ZSJN:'ZSJN — Jinan Yaoqiang', airport_KJFK:'KJFK — JFK International', airport_EGLC:'EGLC — London City',
field_AirlineCode:'Airline', field_FlightNum:'Flight #', field_CallSign:'Callsign',
field_DepartureAirport:'From', field_ArrivalAirport:'To', field_Stand:'Stand', field_Runway:'Runway',
field_OffBlockTime:'Off-Block', field_TakeoffTime:'Takeoff', field_LandingTime:'Landing', field_InBlockTime:'In-Block',
field_AirlineName:'Airline', field_AircraftType:'Aircraft', field_Airway:'STAR',
field_Registration:'Reg', field_Voice:'Voice', field_Language:'Lang',
modal_duplicate_title:'Duplicate Callsign',
modal_duplicate_body:'The following callsigns appear multiple times. Please fix before saving:',
modal_duplicate_save_cancelled:'Save cancelled.',
modal_duplicate_export_cancelled:'Export cancelled.',
modal_issues_title:'{{n}} issue(s) to fix before saving',
modal_issues_export_title:'{{n}} issue(s) to fix before exporting',
modal_issues_fix_hint_save:'Please fix all issues before saving.',
modal_issues_fix_hint_export:'Please fix all issues before exporting.',
modal_backup_title:'Backup Before Save', modal_backup_checkbox:'Create .bak backup',
modal_btn_cancel:'Cancel', modal_btn_confirm_save:'Save', modal_btn_close:'Close', modal_btn_ok:'OK',
modal_save_success:'Save Successful', modal_save_failed:'Save Failed',
modal_delete_confirm:'Confirm Delete', modal_delete_irreversible:'This action cannot be undone.', modal_delete_btn:'Delete {{n}}',
modal_delete_all_confirm:'Confirm Delete All', modal_delete_all_btn:'Delete All',
modal_unsaved_title:'Unsaved Changes',
modal_unsaved_body:'There are unsaved changes. Return anyway?',
modal_unsaved_body_full:'There are unsaved changes (flights or timelines). Return to level list?',
modal_btn_discard:'Discard Changes',
modal_import_backup_title:'Backup Before Import',
modal_import_body:'Import will overwrite all current level files (.acl / .csv / timelines).',
modal_import_checkbox:'Create .bak backup before import', modal_btn_import:'Import',
modal_import_failed:'Import Failed', modal_import_success:'Import Successful',
modal_import_success_body:'Level files imported successfully', modal_import_count:'<strong>{{n}}</strong> flight(s) total',
modal_restore_title:'Confirm Restore',
modal_restore_body:'Restore from the latest <code>.bak</code> backup files:',
modal_restore_acl:'.acl.bak → .acl', modal_restore_csv:'.csv.bak → .csv',
modal_restore_json:'.json.bak → .json (weather/wind/runway timelines)',
modal_restore_warning:'⚠ Unsaved changes will be lost.',
modal_btn_restore:'Restore', modal_restore_failed:'Restore Failed',
val_airline_not_in_whitelist:'{{cs}}: airline code "{{code}}" not in whitelist',
val_flightnum_not_valid:'{{cs}}: flight number "{{num}}" not in valid list for {{code}}',
val_field_not_in_options:'{{cs}}: {{field}} "{{val}}" not in valid options',
val_time_out_of_range:'{{cs}}: {{field}} "{{time}}" out of range ({{hint}})',
val_inblock_after_landing:'{{cs}}: in-block "{{ib}}" must be after landing "{{ld}}"',
val_offblock_before_takeoff:'{{cs}}: off-block "{{ob}}" must be before takeoff "{{to}}"',
val_runway_change_bounds:'Runway change #{{i}}: time "{{time}}" outside level range ({{min}} ~ {{max}})',
val_runway_not_active:'{{cs}}: at {{time}}, runway "{{rwy}}" not in active set',
toast_no_file:'No file open', toast_no_flight_data:'No flight data to save',
toast_copied_n:'Copied {{n}} flight(s)', toast_deleted_n:'Deleted {{n}} flight(s)', toast_deleted_all:'Deleted all {{n}} flights',
toast_no_flights_selected:'Select flights to delete first', toast_no_flights_to_delete:'No flights to delete',
toast_select_to_copy:'Click a flight to copy first',
toast_added_arrival:'Added arrival {{cs}}', toast_added_departure:'Added departure {{cs}}',
toast_exported:'Exported: {{name}}', toast_backup_saved:'Backup saved: {{name}}',
toast_restored_n:'Restored {{n}} flight(s) ({{items}})', toast_imported_n:'Imported {{n}} flights',
};

// ═══════════════════════════════════════════

function initUI() {
  // Setup
  S('setup-title','setup_title','AC27 Level Editor');
  S('setup-sub','setup_sub','请先定位游戏安装目录以扫描所有关卡文件');
  S('setup-steam-title','setup_steam_title','如何通过 Steam 找到游戏目录');
  SH('setup-steam-step1','setup_steam_step1','打开 Steam 库 → 找到 <strong>Airport Control 27</strong>');
  SH('setup-steam-step2','setup_steam_step2','右键 → <strong>管理</strong> → <strong>浏览本地文件</strong>');
  S('setup-steam-step3','setup_steam_step3','在弹出的文件夹中复制路径，或直接选择');
  S('setup-steam-path-label','setup_steam_path_label','通常路径如：');
  SH('setup-nightly','setup_nightly','请切换到<strong>nightly</strong>游戏版本（属性 → 游戏版本及测试版 → nightly）');
  S('btn-select-root','setup_select_root','选择游戏根目录');
  // Browser
  S('browser-title-text','browser_title','关卡列表');
  S('btn-change-root','browser_change_dir','更换目录');
  S('btn-toggle-hidden',(typeof _showHiddenFiles!=='undefined'&&_showHiddenFiles)?'browser_hide_hidden':'browser_toggle_hidden','显示隐藏');
  S('browser-note-text','browser_note','⚠ 部分关卡的时间线已整合到更大范围关卡的时间线中');
  S('browser-loading-text','browser_loading','正在扫描关卡文件…');
  // Editor toolbar
  S('btn-back','toolbar_back','← 返回');
  S('btn-add-arrival','toolbar_add_arrival','+ 添加进港');
  S('btn-add-departure','toolbar_add_departure','+ 添加离港');
  S('btn-copy','toolbar_copy','复制');
  S('btn-delete-selected','toolbar_delete_selected','删除选中');
  S('btn-delete-all','toolbar_delete_all','全部删除');
  S('btn-backup-only','toolbar_backup','备份');
  S('btn-restore-backup','toolbar_restore','还原备份');
  S('btn-import-acl','toolbar_import','导入');
  S('btn-save-as','toolbar_save_as','另存为');
  S('btn-save','toolbar_save','保存');
  SP('search-input','search_placeholder','查找航班…');
  // Timeline titles
  S('tl-weather-title','tl_weather','天气');
  S('tl-wind-title','tl_wind','风向');
  S('tl-runway-title','tl_runway','跑道');
  S('btn-weather-add','tl_add','+ 添加');
  S('btn-wind-add','tl_add','+ 添加');
  // Section titles
  S('section-arrivals-title','table_arrivals','进港');
  S('section-departures-title','table_departures','离港');
  S('empty-editor-text','table_no_flights','无匹配的航班记录');
  // Lang buttons
  var toggles = document.querySelectorAll('.btn-lang-toggle-top');
  for (var i = 0; i < toggles.length; i++) toggles[i].textContent = T('lang_switch_to');
}

function switchLang() {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('ac27_lang', LANG); } catch(_) {}
  try { initUI(); } catch(e) { alert('initUI error: ' + e.message); }
  if (typeof renderAllSections === 'function') try { renderAllSections(); } catch(e) {}
  if (typeof appState !== 'undefined' && appState.screen === 'browser' && typeof renderBrowserCards === 'function') {
    try { renderBrowserCards(); } catch(e) { alert('renderBrowserCards error: ' + e.message); }
  }
  alert('Language switched to: ' + LANG);
}

document.addEventListener('click', function(e) {
  var btn = e.target.closest('.btn-lang-toggle-top');
  if (btn) {
    console.log('[i18n] TOGGLE CLICKED');
    try { switchLang(); } catch(err) { console.error('[i18n] switchLang error:', err.message); }
  }
});

try { initUI(); } catch(e) { console.error('[i18n] initUI crashed:', e.message); }
console.log('[i18n] LANG=' + LANG + ', buttons=' + document.querySelectorAll('.btn-lang-toggle-top').length);

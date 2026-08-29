import React, { useRef, useState, useEffect } from 'react';
import { IoRemoveOutline, IoAirplaneOutline, IoAddOutline, IoRemove, IoScanOutline, IoTrashOutline, IoArrowUndoOutline, IoImageOutline, IoClose } from 'react-icons/io5';
import { PiPolygon, PiSelectionDuotone, PiSelectionThin } from 'react-icons/pi';
import { FaParking, FaBuilding } from 'react-icons/fa';
import { FaArrowPointer } from 'react-icons/fa6';
import { MdDeselect, MdRoundedCorner, MdRotateLeft, MdRotateRight } from 'react-icons/md';
import { MAP_ICON_PATH } from '../../../utils/constants';
import useTooltip from '../../BrowserScreen/useTooltip';

const PLANE_THUMB_URI =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="${MAP_ICON_PATH}" fill="currentColor"/></svg>`
  );

// Tool icons (Select handled specially as a toggle). Line is rotated 45°.
// Runway uses bold "27" marking (runway designation) instead of text label.
const Runway27Icon = () => <span style={{ fontWeight: 900, fontSize: 13, lineHeight: 1, letterSpacing: '-0.5px' }}>27</span>;
const TOOLS = [
  ['taxiwayLine', IoRemoveOutline, '滑行道直线', true, 'ground_painter_tool_taxiway_line', 'D'],
  ['taxiwayCurve', MdRoundedCorner, '滑行道圆角', false, 'ground_painter_tool_taxiway_curve', 'F'],
  ['runwayLine', Runway27Icon, '跑道', false, 'ground_painter_tool_runway_line', 'R'],
  ['area', PiPolygon, '区域多边形', false, 'ground_painter_tool_area', 'G'],
  ['stand', IoAirplaneOutline, '停机位（飞机）', false, 'ground_painter_tool_stand', 'H'],
];

// Keyboard shortcuts shown on each tool button's hover hint (and wired in the
// painter's keydown handler). Single-letter, no modifier.
const TOOL_SHORTCUTS = { select: 'A', boxSelect: 'S', taxiwayLine: 'D', taxiwayCurve: 'F', runwayLine: 'R', area: 'G', stand: 'H' };
// Shortcut suffix helper — "" when no key, otherwise " (X)".
const shortcutSuffix = (key) => (key ? ` (${key})` : '');

// Area-type toggle group shown popping above the highlighted polygon button when
// the Area tool is active. Only one is active at a time.
const AREA_TYPES = [
  { value: 0, Icon: PiSelectionThin, i18nKey: 'ground_painter_area_boundary', fallback: '边界' },
  { value: 1, Icon: FaParking, i18nKey: 'ground_painter_area_apron', fallback: '停机坪' },
  { value: 2, Icon: FaBuilding, i18nKey: 'ground_painter_area_building', fallback: '建筑' },
];

// Editable numeric value shown next to a slider. The slider stays controlled by
// the parent; the text is a typeable input that commits on blur/Enter. A draft
// is held locally while typing so the controlled value doesn't fight the caret,
// and the draft resyncs from `value` once the user stops editing.
function BgValueInput({ value, min, max, step, unit, disabled, onCommit, className }) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

  const clamp = (n) => {
    let v = Number(n);
    if (!Number.isFinite(v)) return value;
    v = Math.round(v / step) * step;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
  };

  const commit = () => {
    onCommit(clamp(draft));
    setEditing(false);
  };

  return (
    <div className={'gp-bg-num ' + (className || '')}>
      <input
        className="gp-bg-num-input"
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => { setEditing(true); setDraft(e.target.value); }}
        onFocus={() => { setEditing(true); setDraft(String(value)); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } }}
      />
      <span className="gp-bg-num-unit">{unit}</span>
    </div>
  );
}


export default function GroundPainterToolbar({ tool, onTool, selectEnabled, onToggleSelect, selected, multiSelected, onDeselect, onDelete, onRotateLeft, onRotateRight, onUndo, canUndo, hasEdited, onSave, onCancel, areaType, onAreaType, heading, onHeading, zoomPercent, onZoomIn, onZoomOut, onZoomReset, t, bgPanelOpen, onToggleBgPanel, hasBgImage, bgOffsetX, bgOffsetY, bgScale, bgRotation, bgOpacity, onBgOffsetX, onBgOffsetY, onBgScale, onBgRotation, onBgOpacity, onImportImage, onClearBgImage, onResetBgImage }) {
  const { bind, TooltipPortal } = useTooltip();
  const importFileRef = useRef(null);

  // Tooltip texts — use i18n where available, fallback to hardcoded Chinese.
  // Each carries its keyboard shortcut (e.g. " (A)") so the hover hint advertises it.
  const tipSelect = (t('ground_painter_tool_select') || '选择 / 移动（拖动选中项，否则平移）') + shortcutSuffix(TOOL_SHORTCUTS.select);
  const tipBoxSelect = (t('ground_painter_tool_select_all') || t('ground_painter_tool_box_select') || '多选') + shortcutSuffix(TOOL_SHORTCUTS.boxSelect);
  const tipDeselect = t('ground_painter_tool_deselect') || '取消选择';
  const tipZoomOut = t('ground_painter_zoom_out') || '缩小';
  const tipZoomIn = t('ground_painter_zoom_in') || '放大';
  const tipZoomReset = t('ground_painter_zoom_reset') || '适应';
  const tipCancel = t('ground_painter_btn_cancel') || '取消';
  const tipSave = t('ground_painter_btn_save') || '保存';
  const tipUndo = t('ground_painter_tool_undo') || '撤销 (Ctrl+Z)';
  const tipRotateL = t('ground_painter_tool_rotate_left') || '左旋 45° ( [ )';
  const tipRotateR = t('ground_painter_tool_rotate_right') || '右旋 45° ( ] )';
  const tipBg = t('ground_painter_bg_toggle') || '背景图';
  const tipImport = t('ground_painter_bg_import') || '导入背景图';

  return (
    <div className="ground-painter-toolbar">
      <div className="gp-tools">
        <button {...bind(tipSelect)} className={tool === 'select' && selectEnabled ? 'gp-active' : ''} onClick={onToggleSelect}>
          <FaArrowPointer size={16} />
        </button>
        <button {...bind(tipBoxSelect)} className={tool === 'boxSelect' ? 'gp-active' : ''} onClick={() => onTool('boxSelect')}>
          <PiSelectionDuotone size={16} />
        </button>
        {/* Deselect — wrapper keeps tooltip alive even when button is disabled */}
        <span {...bind(tipDeselect)} style={{ display: 'inline-flex' }}>
          <button onClick={onDeselect} disabled={!selected && (!multiSelected || multiSelected.length === 0)} className="gp-deselect"><MdDeselect size={16} /></button>
        </span>
        {TOOLS.map(([id, Icon, label, rotate45, i18nKey, shortcut]) => {
          const tip = ((i18nKey && t(i18nKey)) || label) + shortcutSuffix(shortcut);
          const btn = (
            <button key={id} {...bind(tip)} className={tool === id ? 'gp-active' : ''} onClick={() => onTool(id)}>
              {Icon ? <span className={rotate45 ? 'gp-line-45' : ''}><Icon size={16} /></span> : label}
            </button>
          );
          if (id !== 'area') return btn;
          // Area tool: the 3 area-type toggles pop up on top of the highlighted polygon button.
          return (
            <span key={id} className="gp-area-wrap">
              {btn}
              {tool === 'area' && (
                <div className="gp-areatype-group">
                  {AREA_TYPES.map(({ value, Icon: TIcon, i18nKey: k, fallback }) => {
                    const tipText = t(k) || fallback;
                    return (
                      <button
                        key={value}
                        {...bind(tipText)}
                        className={areaType === value ? 'gp-areatype-active' : ''}
                        onClick={() => onAreaType(value)}
                        title={tipText}
                      >
                        <TIcon size={16} />
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          );
        })}
        {/* Rotate (multi-)selection around its center — ↺ / ↻ 45° steps */}
        <span {...bind(tipRotateL)} style={{ display: 'inline-flex' }}>
          <button onClick={onRotateLeft} disabled={!selected && (!multiSelected || multiSelected.length === 0)} className="gp-rotate"><MdRotateLeft size={16} /></button>
        </span>
        <span {...bind(tipRotateR)} style={{ display: 'inline-flex' }}>
          <button onClick={onRotateRight} disabled={!selected && (!multiSelected || multiSelected.length === 0)} className="gp-rotate"><MdRotateRight size={16} /></button>
        </span>
        {/* Delete selected — action button, not a tool mode (same as Delete key) */}
        <span {...bind(t('ground_painter_tool_delete') || '删除选中')} style={{ display: 'inline-flex' }}>
          <button onClick={onDelete} disabled={!selected && (!multiSelected || multiSelected.length === 0)} className="gp-delete"><IoTrashOutline size={16} /></button>
        </span>
        {/* Undo (Ctrl+Z) — enabled only when there is a depth-1 history to revert */}
        <span {...bind(tipUndo)} style={{ display: 'inline-flex' }}>
          <button onClick={onUndo} disabled={!canUndo} className="gp-undo"><IoArrowUndoOutline size={16} /></button>
        </span>
      </div>
      {tool === 'stand' && (
        <label className="gp-heading">
          {t('ground_painter_heading') || '航向'}
          <input
            type="range"
            min={1}
            max={360}
            value={heading}
            className="gp-heading-range gp-plane-thumb"
            style={{ '--hdg': `${heading}deg`, '--thumb-plane': `url("${PLANE_THUMB_URI}")` }}
            onChange={(e) => onHeading(Math.max(1, Math.min(360, Math.round(Number(e.target.value)) || 360)))}
          />
          <span className="gp-heading-val">{String(heading).padStart(3, '0')}°</span>
        </label>
      )}

      {/* Scale group moved to the right, left of Cancel — keeps instant tooltips in both select and non-select modes */}
      <div className="gp-zoom" style={{ marginLeft: 'auto' }}>
        <button {...bind(tipBg)} className={bgPanelOpen ? 'gp-active' : ''} onClick={onToggleBgPanel}><IoImageOutline size={16} /></button>
        <button {...bind(tipZoomOut)} onClick={onZoomOut}><IoRemove size={16} /></button>
        <span className="gp-zoom-pct">{zoomPercent}%</span>
        <button {...bind(tipZoomIn)} onClick={onZoomIn}><IoAddOutline size={16} /></button>
        <button {...bind(tipZoomReset)} onClick={onZoomReset}><IoScanOutline size={16} /></button>
      </div>
      <div className="gp-actions" style={{ marginLeft: 0 }}>
        <button {...bind(tipCancel)} onClick={onCancel}>{t('ground_painter_btn_cancel') || '取消'}</button>
        <span {...bind(tipSave)} style={{ display: 'inline-flex' }}>
          <button disabled={!hasEdited} onClick={onSave} className="gp-save">{t('ground_painter_btn_save') || '保存'}</button>
        </span>
      </div>
      {/* Background image control panel — pops up above the toolbar */}
      {bgPanelOpen && (
        <div className="gp-bg-panel">
          <div className="gp-bg-panel-head">
            <span>{t('ground_painter_bg_title') || '背景图'}</span>
            <button className="gp-bg-close" onClick={onToggleBgPanel} title={t('ground_painter_btn_close') || '关闭'}><IoClose size={14} /></button>
          </div>
          <div className="gp-bg-panel-body">
            <button className="gp-bg-import" {...bind(tipImport)} onClick={() => importFileRef.current?.click()}>
              <IoImageOutline size={16} /> {t('ground_painter_bg_import') || '导入背景图'}
            </button>
            <input ref={importFileRef} type="file" accept="image/*" hidden onChange={(e) => { onImportImage(e.target.files && e.target.files[0]); e.target.value = ''; }} />
            {hasBgImage && (
              <div className="gp-bg-row">
                <button className="gp-bg-remove" onClick={onClearBgImage}>{t('ground_painter_bg_remove') || '移除'}</button>
                <button className="gp-bg-reset" onClick={onResetBgImage}>{t('ground_painter_bg_reset') || '重置'}</button>
              </div>
            )}
            <div className="gp-bg-ctrl" style={{ opacity: hasBgImage ? 1 : 0.45 }}>
              <span className="gp-bg-ctrl-label">{t('ground_painter_bg_offset_x') || '左右'}</span>
              <input type="range" aria-label={t('ground_painter_bg_offset_x') || '左右'} min={-100} max={100} step={1} value={bgOffsetX} disabled={!hasBgImage} onChange={(e) => onBgOffsetX(Number(e.target.value))} />
              <BgValueInput value={Math.round(bgOffsetX)} min={-100} max={100} step={1} unit="%" disabled={!hasBgImage} onCommit={(v) => onBgOffsetX(v)} className="gp-bg-ctrl-val" />
            </div>
            <div className="gp-bg-ctrl" style={{ opacity: hasBgImage ? 1 : 0.45 }}>
              <span className="gp-bg-ctrl-label">{t('ground_painter_bg_offset_y') || '上下'}</span>
              <input type="range" aria-label={t('ground_painter_bg_offset_y') || '上下'} min={-100} max={100} step={1} value={bgOffsetY} disabled={!hasBgImage} onChange={(e) => onBgOffsetY(Number(e.target.value))} />
              <BgValueInput value={Math.round(bgOffsetY)} min={-100} max={100} step={1} unit="%" disabled={!hasBgImage} onCommit={(v) => onBgOffsetY(v)} className="gp-bg-ctrl-val" />
            </div>
            <div className="gp-bg-ctrl" style={{ opacity: hasBgImage ? 1 : 0.45 }}>
              <span className="gp-bg-ctrl-label">{t('ground_painter_bg_scale') || '缩放'}</span>
              <input type="range" aria-label={t('ground_painter_bg_scale') || '缩放'} min={10} max={1000} step={1} value={Math.round(bgScale * 100)} disabled={!hasBgImage} onChange={(e) => onBgScale(Number(e.target.value) / 100)} />
              <BgValueInput value={Math.round(bgScale * 100)} min={10} max={1000} step={1} unit="%" disabled={!hasBgImage} onCommit={(v) => onBgScale(v / 100)} className="gp-bg-ctrl-val" />
            </div>
            <div className="gp-bg-ctrl" style={{ opacity: hasBgImage ? 1 : 0.45 }}>
              <span className="gp-bg-ctrl-label">{t('ground_painter_bg_rotation') || '旋转'}</span>
              <input type="range" aria-label={t('ground_painter_bg_rotation') || '旋转'} min={-180} max={180} step={1} value={Math.round(bgRotation ?? 0)} disabled={!hasBgImage} onChange={(e) => onBgRotation(Number(e.target.value))} />
              <BgValueInput value={Math.round(bgRotation ?? 0)} min={-180} max={180} step={1} unit="°" disabled={!hasBgImage} onCommit={(v) => onBgRotation(v)} className="gp-bg-ctrl-val" />
            </div>
            <div className="gp-bg-ctrl" style={{ opacity: hasBgImage ? 1 : 0.45 }}>
              <span className="gp-bg-ctrl-label">{t('ground_painter_bg_opacity') || '透明度'}</span>
              <input type="range" aria-label={t('ground_painter_bg_opacity') || '透明度'} min={0} max={100} step={1} value={Math.round((bgOpacity ?? 0.6) * 100)} disabled={!hasBgImage} onChange={(e) => onBgOpacity(Number(e.target.value) / 100)} />
              <BgValueInput value={Math.round((bgOpacity ?? 0.6) * 100)} min={0} max={100} step={1} unit="%" disabled={!hasBgImage} onCommit={(v) => onBgOpacity(v / 100)} className="gp-bg-ctrl-val" />
            </div>
          </div>
        </div>
      )}
      {TooltipPortal}
    </div>
  );
}

import React, { useEffect } from 'react';
import './LiveryHelpOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import {
  IoClose,
  IoArrowBack,
  IoCloudDownloadOutline,
  IoCheckmarkDone,
  IoTrashOutline,
  IoSearchOutline,
  IoImageOutline,
  IoBrushOutline,
  IoEyedropOutline,
  IoColorFillOutline,
  IoRemoveOutline,
  IoSquareOutline,
  IoEllipseOutline,
  IoTextOutline,
  IoArrowUndoOutline,
  IoArrowRedoOutline,
  IoAddOutline,
  IoRemove,
  IoScanOutline,
  IoColorPaletteOutline,
  IoSaveOutline,
} from 'react-icons/io5';
import { FaFileImport, FaFileExport, FaArrowPointer } from 'react-icons/fa6';
import { FaEraser } from 'react-icons/fa';
import { MdAdd, MdSaveAs } from 'react-icons/md';
import { TbSticker2 } from 'react-icons/tb';
import { HiDocumentDuplicate } from 'react-icons/hi';
import { CiBookmarkRemove } from 'react-icons/ci';

// ─── Button registry: icon + label key + short description key ──
const BUTTONS = {
  back: { icon: IoArrowBack, labelKey: 'livery_back', descKey: 'livery_help_d_back' },
  pack: { icon: IoCloudDownloadOutline, labelKey: 'livery_tab_install', descKey: 'livery_help_d_pack' },
  create: { icon: MdAdd, labelKey: 'livery_tab_create', descKey: 'livery_help_d_create' },
  selectAll: { icon: IoCheckmarkDone, labelKey: 'toolbar_select_all', descKey: 'livery_help_d_select_all' },
  exportSelected: { icon: FaFileExport, labelKey: 'livery_export', descKey: 'livery_help_d_export_selected' },
  delete: { icon: IoTrashOutline, labelKey: 'toolbar_delete_selected', descKey: 'livery_help_d_delete' },
  search: { icon: IoSearchOutline, labelKey: 'livery_search', descKey: 'livery_help_d_search' },
  importImage: { icon: IoImageOutline, labelKey: 'livery_import_image', descKey: 'livery_help_d_import_image' },
  importZip: { icon: FaFileImport, labelKey: 'livery_import_zip', descKey: 'livery_help_d_import_zip' },
  exportZip: { icon: FaFileExport, labelKey: 'livery_export_zip', descKey: 'livery_help_d_export_zip' },
  save: { icon: IoSaveOutline, labelKey: 'livery_save', descKey: 'livery_help_d_save' },
  saveAs: { icon: MdSaveAs, labelKey: 'livery_save_as', descKey: 'livery_help_d_save_as' },
  color: { icon: IoColorPaletteOutline, labelKey: 'livery_paint_color', descKey: 'livery_help_d_color' },
  brush: { icon: IoBrushOutline, labelKey: 'livery_paint_brush', descKey: 'livery_help_d_brush' },
  eraser: { icon: FaEraser, labelKey: 'livery_paint_eraser', descKey: 'livery_help_d_eraser' },
  eyedropper: { icon: IoEyedropOutline, labelKey: 'livery_paint_eyedropper', descKey: 'livery_help_d_eyedropper' },
  fill: { icon: IoColorFillOutline, labelKey: 'livery_paint_fill', descKey: 'livery_help_d_fill' },
  line: { icon: IoRemoveOutline, labelKey: 'livery_paint_line', descKey: 'livery_help_d_line' },
  rect: { icon: IoSquareOutline, labelKey: 'livery_paint_rect', descKey: 'livery_help_d_rect' },
  ellipse: { icon: IoEllipseOutline, labelKey: 'livery_paint_ellipse', descKey: 'livery_help_d_ellipse' },
  text: { icon: IoTextOutline, labelKey: 'livery_paint_text', descKey: 'livery_help_d_text' },
  sticker: { icon: TbSticker2, labelKey: 'livery_paint_import_sticker', descKey: 'livery_help_d_sticker' },
  select: { icon: FaArrowPointer, labelKey: 'livery_paint_select', descKey: 'livery_help_d_select' },
  duplicate: { icon: HiDocumentDuplicate, labelKey: 'livery_paint_duplicate_sticker', descKey: 'livery_help_d_duplicate' },
  removeSticker: { icon: CiBookmarkRemove, labelKey: 'livery_paint_delete_sticker', descKey: 'livery_help_d_remove_sticker' },
  undo: { icon: IoArrowUndoOutline, labelKey: 'livery_paint_undo' },
  redo: { icon: IoArrowRedoOutline, labelKey: 'livery_paint_redo' },
  clear: { icon: IoTrashOutline, labelKey: 'livery_paint_clear', descKey: 'livery_help_d_clear' },
  zoomOut: { icon: IoRemove, labelKey: 'livery_paint_zoom_out' },
  zoomIn: { icon: IoAddOutline, labelKey: 'livery_paint_zoom_in' },
  fit: { icon: IoScanOutline, labelKey: 'livery_paint_fit' },
};

// ─── Section definitions — one button per line, "button — description" ──
const SECTIONS = [
  { id: 'tabs', headingKey: 'livery_help_tabs_heading', items: ['create', 'back'] },
  { id: 'bar', headingKey: 'livery_help_bar_heading', items: ['pack', 'selectAll', 'exportSelected', 'delete', 'search'] },
  { id: 'painter', headingKey: 'livery_help_painter_heading', items: ['importImage', 'importZip', 'exportZip', 'save', 'saveAs'] },
  {
    id: 'paint', headingKey: 'livery_help_paint_heading',
    items: [
      'color', 'brush', 'eraser', 'eyedropper', 'fill', 'line', 'rect', 'ellipse', 'text',
      'sticker', 'select', 'duplicate', 'removeSticker', 'undo', 'redo', 'clear', 'zoomOut', 'zoomIn', 'fit',
    ],
  },
];

// ─── Component ────────────────────────────────────────────
export default function LiveryHelpOverlay({ onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'livery-help-overlay') onClose();
  };

  return (
    <div id="livery-help-overlay" onClick={handleOverlayClick}>
      <div id="livery-help-box" onClick={(e) => e.stopPropagation()}>
        <div id="livery-help-header">
          <h2>{t('livery_help_title')}</h2>
          <button onClick={onClose} title={t('browser_help_close')}>
            <IoClose size={18} />
          </button>
        </div>

        <div id="livery-help-body">
          {SECTIONS.map((s) => (
            <section key={s.id} id={'livery-help-' + s.id} className="livery-help-section">
              <h2>{t(s.headingKey)}</h2>
              {s.items.map((key) => {
                const b = BUTTONS[key];
                if (!b) return null;
                const Icon = b.icon;
                return (
                  <div key={key} className="livery-help-item">
                    <span className="livery-help-btn">
                      <Icon size={12} className="btn-icon" />
                      {t(b.labelKey)}
                    </span>
                    {b.descKey && <span className="livery-help-text">{t(b.descKey)}</span>}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

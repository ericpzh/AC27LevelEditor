import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../hooks/useTranslation';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from '../../utils/liveryPaint';

// ─── Custom RGBA colour picker popover ───────────────────────
// The browser's native <input type="color"> dialog is opaque to the app and
// has no alpha channel, so the painter ships its own picker: a saturation/
// value square, a hue rail, an alpha rail (checkerboard-backed) and a hex
// field. It renders in a portal anchored to the swatch's client rect, because
// the tool rail scrolls and would otherwise clip it.
export default function LiveryColorPicker({ color, opacity, onChange, onClose, anchor }) {
  const { t } = useTranslation();
  // Hue is kept locally: it cannot be recovered from an achromatic colour, so
  // deriving it from every hex change would make the square jump to red while
  // the user drags down the value/black edge.
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(color)));
  const svRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const next = rgbToHsv(hexToRgb(color));
    setHsv(prev => ({ h: next.s === 0 ? prev.h : next.h, s: next.s, v: next.v }));
  }, [color]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const alpha = opacity == null ? 1 : opacity;
  const raw = hsvToRgb(hsv);
  const rgb = { r: Math.round(raw.r), g: Math.round(raw.g), b: Math.round(raw.b) };
  const hex = rgbToHex(rgb);
  const opaqueHex = rgbToHex(hexToRgb(color));

  const emit = (nextHsv, nextAlpha) => {
    setHsv(nextHsv);
    onChange({ color: rgbToHex(hsvToRgb(nextHsv)), opacity: nextAlpha == null ? alpha : nextAlpha });
  };

  // Saturation/value square: x → saturation, y (inverted) → value.
  const pickSV = (clientX, clientY) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
    const v = Math.max(0, Math.min(1, 1 - (clientY - r.top) / (r.height || 1)));
    emit({ h: hsv.h, s, v });
  };

  const onSvDown = (e) => {
    draggingRef.current = true;
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    pickSV(e.clientX, e.clientY);
  };
  const onSvMove = (e) => { if (draggingRef.current) pickSV(e.clientX, e.clientY); };
  const onSvUp = () => { draggingRef.current = false; };

  const commitHex = (raw) => {
    const value = String(raw || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(value) && !/^[0-9a-fA-F]{3}$/.test(value)) return;
    const next = rgbToHsv(hexToRgb('#' + value));
    emit({ h: next.s === 0 ? hsv.h : next.h, s: next.s, v: next.v });
  };

  const popStyle = { left: anchor && anchor.x, top: anchor && anchor.y };
  const hueColor = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;

  return createPortal(
    <>
      <div
        className="lp-color-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div className="lp-color-pop" role="dialog" aria-label={t('livery_paint_color')} style={popStyle}>
        <div
          ref={svRef}
          className="lp-color-sv"
          style={{
            backgroundColor: hueColor,
            backgroundImage: 'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
          }}
          onPointerDown={onSvDown}
          onPointerMove={onSvMove}
          onPointerUp={onSvUp}
          onPointerCancel={onSvUp}
          role="slider"
          aria-label={t('livery_paint_color_area')}
          aria-valuenow={Math.round(hsv.v * 100)}
          tabIndex={0}
        >
          <span
            className="lp-color-sv-knob"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
          />
        </div>

        <label className="lp-color-row">
          <input
            type="range"
            className="lp-color-rail lp-color-hue"
            aria-label={t('livery_paint_hue')}
            min={0}
            max={360}
            value={Math.round(hsv.h)}
            onChange={(e) => emit({ ...hsv, h: Number(e.target.value) }, alpha)}
          />
        </label>

        <label className="lp-color-row">
          <input
            type="range"
            className="lp-color-rail lp-color-alpha"
            aria-label={t('livery_paint_opacity')}
            min={0}
            max={1}
            step={0.01}
            value={alpha}
            style={{
              // Current colour fading to transparent over a checkerboard, so
              // the transparent end reads as alpha rather than a colour.
              backgroundImage: `linear-gradient(to right, rgba(${rgb.r},${rgb.g},${rgb.b},0), rgba(${rgb.r},${rgb.g},${rgb.b},1)), repeating-conic-gradient(#2a2d38 0 25%, #23262f 0 50%)`,
              backgroundSize: '100% 100%, 12px 12px',
            }}
            onChange={(e) => emit(hsv, Number(e.target.value))}
          />
          <span className="lp-color-alpha-val">{Math.round(alpha * 100)}%</span>
        </label>

        <div className="lp-color-row">
          <input
            className="lp-hex"
            aria-label={t('livery_paint_hex')}
            defaultValue={opaqueHex}
            key={opaqueHex}
            spellCheck={false}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitHex(e.target.value);
              if (e.key === 'Escape') onClose();
            }}
          />
          <span className="lp-color-preview" aria-hidden="true">
            <span style={{ background: hex, opacity: alpha }} />
          </span>
        </div>
      </div>
    </>,
    document.body,
  );
}

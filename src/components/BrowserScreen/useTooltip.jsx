import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './useTooltip.css';

/**
 * Portal-based tooltip hook.
 *
 * Width is computed per-character (same 12px font, known text):
 * each glyph has a known pixel width — no averaging.
 *
 * - Tooltip box sits entirely above the button (arrow at button top)
 * - Falls below if no room above
 * - Centred on the button, or pinned to left / right viewport edge
 *
 * Usage:
 *   const { bind, TooltipPortal } = useTooltip();
 *   <button {...bind(text)}>...</button>
 *   {TooltipPortal}
 */

const ARROW_H = 6;
const MIN_PAD = 10;
const EST_BOX_H = 40;
const BASE = 10;
const CJK = 12.0; // full-width CJK fallback
const MAX_W = 600;

// Per-glyph widths at 12px system-ui / Segoe UI (~Inter metrics)
const CW = {
  // ── narrow (~4 px) ──
  ' ':4, '.':4, ',':4, ':':4, ';':4, '\'':3.5, 'i':4, 'l':4, '|':4,
  // ── medium-narrow (5 – 5.5 px) ──
  'f':5.5, 'j':5, 'r':5, 't':5.5, '1':5.5, '!':5, '/':5.5, '\\':5.5,
  'I':4.5,
  // ── medium (6 – 6.5 px) ──
  'a':6.5, 'c':6.5, 'e':6.5, 'g':6.5, 'n':6.5, 'o':6.5, 'u':6.5, 'v':6.5, 'x':6.5,
  's':6, 'z':6,
  '2':6.5, '3':6.5, '4':6.5, '5':6.5, '6':6.5, '7':6.5, '8':6.5, '9':6.5, '0':6.5,
  '?':6.5, 'J':6.5, '-':5.5, '_':6.5,
  // ── medium-wide (7 px) ──
  'b':7, 'd':7, 'h':7, 'k':7, 'p':7, 'q':7, 'y':7,
  // ── uppercase (7.5 – 8.5 px) ──
  'A':8, 'B':8, 'C':8.5, 'D':8, 'E':7.5, 'F':7.5, 'G':8.5, 'H':8,
  'K':8, 'L':7.5, 'N':8, 'P':7.5, 'R':8, 'S':7.5, 'T':7.5, 'U':8, 'V':8,
  'X':8, 'Y':8, 'Z':7.5, 'O':8.5, 'Q':8.5,
  // ── wide (9 px) ──
  'm':9, 'w':9,
  // ── extra-wide (10.5 px) ──
  'M':10.5, 'W':10.5,
};

function charW(ch) {
  if (CW.hasOwnProperty(ch)) return CW[ch];
  if (ch.codePointAt(0) > 0x2000) return CJK;
  return 7; // unknown Latin default
}

function calcWidth(text) {
  let w = BASE;
  let hasCjk = false;
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2000) { hasCjk = true; w += CJK; }
    else w += charW(ch);
  }
  if (hasCjk) w += 10; // extra breathing room for CJK (on top of BASE)
  return Math.ceil(Math.min(MAX_W, w));
}

export default function useTooltip() {
  const [tip, setTip] = useState(null);

  const show = useCallback((text, ev) => {
    const el = ev.currentTarget;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const tw = calcWidth(text);

    // ── Vertical ──
    let top = rect.top - EST_BOX_H - ARROW_H;
    let arrowUp = false;
    if (top < MIN_PAD) {
      top = rect.bottom + ARROW_H;
      arrowUp = true;
    }
    if (top < MIN_PAD) top = MIN_PAD;
    if (top + EST_BOX_H > vh - MIN_PAD) top = vh - EST_BOX_H - MIN_PAD;

    // ── Horizontal ──
    const btnCenter = rect.left + rect.width / 2;
    const halfW = tw / 2;

    let left, transform, arrowPx;

    if (btnCenter - halfW < MIN_PAD) {
      left = MIN_PAD;
      transform = 'translateX(0)';
      arrowPx = btnCenter - MIN_PAD;
    } else if (btnCenter + halfW > vw - MIN_PAD) {
      left = vw - tw - MIN_PAD;
      transform = 'translateX(0)';
      arrowPx = btnCenter - left;
    } else {
      left = btnCenter;
      transform = 'translateX(-50%)';
      arrowPx = halfW;
    }

    if (arrowPx < 8) arrowPx = 8;
    if (arrowPx > tw - 8) arrowPx = tw - 8;

    setTip({ text, top, left, transform, arrowUp, arrowPx, width: tw });
  }, []);

  const hide = useCallback(() => setTip(null), []);

  const bind = useCallback(
    (text) => ({
      onMouseEnter: (e) => show(text, e),
      onMouseLeave: hide,
    }),
    [show, hide],
  );

  const TooltipPortal = tip
    ? createPortal(
        <div
          className="tooltip-popup"
          style={{
            top: tip.top,
            left: tip.left,
            width: tip.width,
            transform: tip.transform,
          }}
        >
          {tip.text}
          <div
            className={'tooltip-arrow' + (tip.arrowUp ? ' up' : '')}
            style={{ left: `${tip.arrowPx}px` }}
          />
        </div>,
        document.body,
      )
    : null;

  return { bind, TooltipPortal };
}

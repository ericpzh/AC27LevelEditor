/**
 * useKnobPositions — map the current SVG viewBox to 0-1 knob gauge positions.
 *
 * Computes normalized zoom / panH / panV values that the ControlSidebar's
 * SpinKnob gauges display.  Initial viewBox acts as the reference for 0.5 pan
 * centre and 0.5 zoom midpoint.
 *
 * Used by: AirMapWindow, GroundMapWindow.
 */
import { useMemo } from 'react';

/**
 * @param {{ x:number, y:number, w:number, h:number }} viewBox — current SVG viewBox
 * @param {{ x:number, y:number, w:number, h:number }} initialViewBox — initial viewBox (reference)
 * @returns {{ zoom: number, panH: number, panV: number }} 0-1 knob positions
 */
export function useKnobPositions(viewBox, initialViewBox) {
  return useMemo(() => {
    if (!viewBox || !initialViewBox) return { zoom: 0.5, panH: 0.5, panV: 0.5 };

    // Zoom knob: higher value = zoomed in (smaller w/h)
    const minW = initialViewBox.w * 0.15;
    const maxW = initialViewBox.w * 1.5;
    const zoom = 1 - Math.max(0, Math.min(1, (viewBox.w - minW) / (maxW - minW)));

    // Pan knobs: centre of viewBox relative to initial centre
    const initCx = initialViewBox.x + initialViewBox.w / 2;
    const initCy = initialViewBox.y + initialViewBox.h / 2;
    const curCx = viewBox.x + viewBox.w / 2;
    const curCy = viewBox.y + viewBox.h / 2;
    const panRange = initialViewBox.w * 0.4;
    const panH = 0.5 + Math.max(-0.5, Math.min(0.5, (curCx - initCx) / panRange));
    const panV = 0.5 + Math.max(-0.5, Math.min(0.5, (curCy - initCy) / panRange));

    return { zoom, panH, panV };
  }, [viewBox, initialViewBox]);
}

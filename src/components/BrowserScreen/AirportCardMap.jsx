import React, { useMemo } from 'react';
import './AirportCardMap.css';

function svgY(z) { return -z; }

function computeRunwayCorners(a, b, halfWidth) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9) return null;
  const px = dz / len;
  const pz = -dx / len;
  const hx = px * halfWidth;
  const hz = pz * halfWidth;
  return [
    { x: a.x - hx, z: a.z - hz },
    { x: a.x + hx, z: a.z + hz },
    { x: b.x + hx, z: b.z + hz },
    { x: b.x - hx, z: b.z - hz },
  ];
}

const AREA_TYPE_STYLES = {
  0: { fill: '#1a3a6a', stroke: '#2a5a9a', opacity: 0.20 },
  1: { fill: '#444', stroke: 'none', opacity: 1.0 },
  2: { fill: '#000', stroke: 'none', opacity: 1.0 },
};

const HEADER_H = 46;
const ROW_H    = 35;

export default function AirportCardMap({ areaData, taxiwayPaths, runwayData, numRows }) {
  const cardH = HEADER_H + (numRows || 0) * ROW_H;

  const viewBox = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    const addPoint = (x, z) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    };

    Object.values(areaData || {}).forEach(areas => {
      (areas || []).forEach(area => {
        if (area.points) area.points.forEach(p => addPoint(p.x, p.z));
      });
    });
    (taxiwayPaths || []).forEach(tp => {
      if (tp.points) tp.points.forEach(p => addPoint(p.x, p.z));
    });
    Object.values(runwayData || {}).forEach(rw => {
      if (rw.thresholds) rw.thresholds.forEach(p => addPoint(p.x, p.z));
    });

    if (!isFinite(minX)) return null;

    const rawW = maxX - minX;
    const rawH = maxZ - minZ;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;

    const padZ = Math.max(rawH * 0.05, 1);
    const vbH = rawH + padZ * 2;

    // Match viewBox aspect ratio to the card so slice doesn't crop.
    // Card width ≈ window content area minus padding; 984px is a safe floor.
    const cardAR = 984 / Math.max(cardH, 1);
    const vbW = vbH * cardAR;

    return {
      x: centerX - vbW / 2,
      y: svgY(centerZ + vbH / 2),
      w: vbW,
      h: vbH,
    };
  }, [areaData, taxiwayPaths, runwayData, cardH]);

  // ── SVG pixel size, centered behind card ──
  const bgPx = cardH / 0.30;  // 30% visible
  const offsetY = -(bgPx - cardH) / 2;

  const areaElements = useMemo(() => {
    const els = [];
    Object.entries(areaData || {}).forEach(([areaTypeStr, areas]) => {
      const areaType = parseInt(areaTypeStr, 10);
      const style = AREA_TYPE_STYLES[areaType] || { fill: '#444', stroke: '#444', opacity: 0.20 };
      (areas || []).forEach(area => {
        if (!area.enabled || !area.points || area.points.length < 3) return;
        const pointsStr = area.points.map(p => `${p.x},${svgY(p.z)}`).join(' ');
        els.push(
          <polygon key={'area-' + area.guid} points={pointsStr}
            fill={style.fill} fillOpacity={style.opacity}
            stroke={style.stroke}
            strokeWidth={style.stroke === 'none' ? 0 : 0.5}
            strokeOpacity={style.stroke === 'none' ? 0 : 0.5} />
        );
      });
    });
    return els;
  }, [areaData]);

  const taxiwayElements = useMemo(() => {
    return (taxiwayPaths || []).map((tp, i) => {
      if (!tp.points || tp.points.length < 2) return null;
      return (
        <polyline key={'twy-' + i}
          points={tp.points.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
          fill="none" stroke="#444" strokeWidth={0.6}
          strokeLinecap="round" strokeLinejoin="round" />
      );
    });
  }, [taxiwayPaths]);

  const runwayElements = useMemo(() => {
    return Object.entries(runwayData || {}).map(([name, rw]) => {
      if (!rw.thresholds || rw.thresholds.length < 2) return null;
      const a = rw.thresholds[0];
      const b = rw.thresholds[1];
      const halfW = (rw.width || 0.50) / 2;
      const corners = computeRunwayCorners(a, b, halfW);
      if (!corners) return null;
      return (
        <polygon key={'rwy-' + name}
          points={corners.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
          fill="#000" stroke="#000" strokeWidth={0.4} />
      );
    });
  }, [runwayData]);

  if (!viewBox) {
    return (
      <div className="airport-card-map">
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"
          style={{ width: '100%', height: '100%' }}>
          <rect x="0" y="0" width="100" height="100" fill="#0a1628" />
        </svg>
      </div>
    );
  }

  return (
    <div className="airport-card-map">
      <div style={{
        position: 'absolute',
        left: 0,
        top: offsetY,
        width: '100%',
        height: bgPx,
      }}>
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid slice"
          style={{ width: '100%', height: '100%' }}
        >
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="#0a1628" />
          {taxiwayElements}
          {areaElements}
          {runwayElements}
        </svg>
      </div>
    </div>
  );
}

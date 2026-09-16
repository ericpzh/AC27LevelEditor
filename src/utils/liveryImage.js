// ─── Livery image helpers (renderer, pure — no IPC, no store) ───
// Shrink-to-fit normalize: images larger than 2048 in either dimension are
// scaled down (aspect preserved) and centered over a base fill; smaller
// images are drawn as-is (never upscaled). Output is always a 2048×2048 PNG
// data-URL so the main process only writes bytes + checks IHDR dimensions.

import { TEXTURE_SIZE } from './constants/livery';

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('READ_FAILED'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('BAD_IMAGE'));
    img.src = dataUrl;
  });
}

export async function normalizeToTexture(dataUrl, fillColor = '#ffffff') {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('BAD_IMAGE');
  const size = TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, size, size);
  // Contain-fit, shrink only (never upscale).
  const scale = Math.min(1, size / w, size / h);
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
  return canvas.toDataURL('image/png');
}

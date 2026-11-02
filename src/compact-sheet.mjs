import { createPipeline } from '../vendor/dsh-see-now/pipeline.js';
import { BACKGROUND, badgeScale, blit, drawBadgePlain, fillRect } from '../vendor/dsh-see-now/sheet.js';

// Rendering only: the upstream selector still decides which frames belong to
// each batch and when to flush it. A row contains real frames, never empty cells.
export function compactLayout(count, width, height) {
  if (!Number.isInteger(count) || count < 1 || count > 40 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('Invalid compact storyboard size.');
  }
  const ratio = width / height, budget = width * height, longest = Math.max(width, height);
  let best;
  for (let rows = 1; rows <= count; rows++) {
    const counts = Array.from({ length: rows }, (_, i) => Math.floor(count / rows) + (i < count % rows ? 1 : 0));
    const heightFactor = counts.reduce((sum, n) => sum + 1 / n, 0) / ratio;
    // Keep the original pixel budget and longest-side limit. Do not upscale
    // any source frame. Different row counts trade width for height.
    let w = Math.floor(Math.min(longest, Math.sqrt(budget / heightFactor),
      longest / heightFactor, width * Math.min(...counts)));
    const dimensions = () => counts.map(n => Math.max(1, Math.round(w / n / ratio)));
    let heights = dimensions(), h = heights.reduce((a, b) => a + b, 0);
    while (w > 0 && (w * h > budget || h > longest)) {
      w--; heights = dimensions(); h = heights.reduce((a, b) => a + b, 0);
    }
    if (w < Math.max(...counts)) continue;
    const rects = [];
    let y = 0;
    counts.forEach((n, row) => {
      for (let col = 0; col < n; col++) {
        const x = Math.round(col * w / n), right = Math.round((col + 1) * w / n);
        rects.push({ px: x, py: y, pw: right - x, ph: heights[row], index: rects.length + 1 });
      }
      y += heights[row];
    });
    // Maximise the smallest frame, so sparse batches do not shrink all frames
    // into a thin strip. Near ties prefer a less elongated whole image.
    const minimum = Math.min(...rects.map(r => r.pw * r.ph));
    const shape = Math.abs(Math.log(w / h));
    if (!best || minimum > best.minimum * 1.01 ||
        (minimum >= best.minimum / 1.01 && shape < best.shape)) {
      best = { width: w, height: h, rects, minimum, shape };
    }
  }
  if (!best) throw new RangeError('Storyboard canvas is too small for its frames.');
  return best;
}

// Area downsampling over the ENTIRE source frame. Unlike coverInto, this never
// crops a source edge. Integer sizing and seams introduce only pixel rounding.
function resizeWholeFrame(src, sw, sh, dw, dh) {
  if (!src || src.length !== sw * sh * 3) throw new RangeError('Invalid source RGB frame.');
  if (sw === dw && sh === dh) return src;
  const dst = Buffer.alloc(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * sw + sx) * 3;
          r += src[p]; g += src[p + 1]; b += src[p + 2];
        }
      }
      const n = (x1 - x0) * (y1 - y0), p = (y * dw + x) * 3;
      dst[p] = r / n; dst[p + 1] = g / n; dst[p + 2] = b / n;
    }
  }
  return dst;
}

export function renderCompactSheet({ frames, tiers, width, height }) {
  const layout = compactLayout(frames.length, width, height);
  const outW = layout.width, outH = layout.height;
  const buffer = Buffer.alloc(outW * outH * 3);
  fillRect(buffer, outW, outH, 0, 0, outW, outH, BACKGROUND);
  let pixels = 0;
  const rects = layout.rects.map((r, i) => {
    // A one-pixel seam is inside the allocated cell; resize the entire frame
    // into its remaining area instead of discarding its right/bottom edges.
    const seam = frames.length > 1 ? 1 : 0;
    const cw = Math.max(1, r.pw - seam), ch = Math.max(1, r.ph - seam);
    const resized = resizeWholeFrame(frames[i].buf, width, height, cw, ch);
    // Draw in a cell-local buffer so tiny cells cannot paint their badge into
    // a neighbouring frame. A single unscaled frame must remain immutable.
    const cell = resized === frames[i].buf ? Buffer.from(resized) : resized;
    const scale = Math.min(badgeScale(outW), Math.max(1, Math.floor((ch - 12) / 7)),
      Math.max(1, Math.floor((cw - 12) / (String(r.index).length * 6))));
    drawBadgePlain(cell, cw, ch, 6, 6, r.index, scale);
    blit(buffer, outW, outH, r.px, r.py, cw, ch, cell);
    pixels += cw * ch;
    return { ...r, t: tiers[i] };
  });
  return { buffer, width: outW, height: outH, rects, area: pixels / (outW * outH), layout: 'compact-rows-v1' };
}

export function createEvidencePipeline(options) {
  return createPipeline({ ...options, renderSheet: renderCompactSheet });
}

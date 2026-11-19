// Fills masked pixels from their surroundings.
// Method: a multi-scale "push-pull" fill (average known pixels down a pyramid,
// then interpolate back up), a Laplace smoothing pass inside the hole, and a
// light grain matched to the surrounding texture so the patch does not look
// plastic. Works on RGBA ImageData in place. Written for Peelback.

/**
 * @param {ImageData} img   pixels to edit in place
 * @param {Uint8Array} mask 1 where pixels should be replaced (length w*h)
 * @param {{dilate?: number, grain?: number}} [opts]
 * @returns {boolean} true if anything was filled
 */
export function inpaint(img, mask, opts = {}) {
  const { width: W, height: H, data } = img;
  const dilate = opts.dilate ?? 3;
  const grain = opts.grain ?? 0.7;

  const m = dilateMask(mask, W, H, dilate);

  // Bounding box of the hole, padded so the fill has context to draw from.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (m[row + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return false;
  const pad = Math.max(24, Math.round(Math.max(x1 - x0, y1 - y0) * 0.6));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;

  // Crop into float channels.
  const ch = [0, 1, 2, 3].map(() => new Float32Array(n));
  const hole = new Uint8Array(n);
  let known = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, gi = (y + y0) * W + (x + x0), p = gi * 4;
      hole[i] = m[gi];
      if (!hole[i]) known++;
      for (let c = 0; c < 4; c++) ch[c][i] = data[p + c];
    }
  }
  if (known === 0) return false; // nothing to borrow from

  const filled = pushPull(ch, hole, w, h);
  smooth(filled, hole, w, h, 60);
  if (grain > 0) addGrain(filled, hole, w, h, grain);

  // Write back only the hole pixels.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const p = ((y + y0) * W + (x + x0)) * 4;
      for (let c = 0; c < 4; c++) data[p + c] = clamp255(filled[c][i]);
    }
  }
  return true;
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

export function dilateMask(mask, W, H, r) {
  if (r <= 0) return mask.slice();
  // Separable square dilation (two passes), cheap and good enough at small radii.
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = -1e9; // last x where mask was set
    const row = y * W;
    for (let x = 0; x < W; x++) { if (mask[row + x]) run = x; if (x - run <= r) tmp[row + x] = 1; }
    run = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (mask[row + x]) run = x; if (run - x <= r) tmp[row + x] = 1; }
  }
  for (let x = 0; x < W; x++) {
    let run = -1e9;
    for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; if (y - run <= r) out[y * W + x] = 1; }
    run = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) out[y * W + x] = 1; }
  }
  return out;
}

function pushPull(ch, hole, w, h) {
  // Level 0
  const levels = [];
  let wt = new Float32Array(w * h);
  for (let i = 0; i < wt.length; i++) wt[i] = hole[i] ? 0 : 1;
  let cur = { w, h, wt, ch: ch.map((a) => a.slice()) };
  for (let i = 0; i < wt.length; i++) if (!wt[i]) for (const a of cur.ch) a[i] = 0;
  levels.push(cur);

  // Push: average known values down until every pixel has some weight.
  while (cur.w > 1 || cur.h > 1) {
    const cw = Math.max(1, (cur.w + 1) >> 1), chh = Math.max(1, (cur.h + 1) >> 1);
    const nwt = new Float32Array(cw * chh);
    const nch = cur.ch.map(() => new Float32Array(cw * chh));
    let allKnown = true;
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        let sw = 0; const s = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy; if (yy >= cur.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx; if (xx >= cur.w) continue;
            const j = yy * cur.w + xx, q = cur.wt[j];
            if (q > 0) { sw += q; for (let c = 0; c < 4; c++) s[c] += cur.ch[c][j] * q; }
          }
        }
        const i = y * cw + x;
        if (sw > 0) { for (let c = 0; c < 4; c++) nch[c][i] = s[c] / sw; nwt[i] = Math.min(1, sw); }
        else allKnown = false;
      }
    }
    cur = { w: cw, h: chh, wt: nwt, ch: nch };
    levels.push(cur);
    if (allKnown && cur.wt.every((v) => v >= 1)) break;
  }

  // Pull: blend each level with the bilinear upsample of the coarser one.
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l], coarse = levels[l + 1];
    const sx = coarse.w / fine.w, sy = coarse.h / fine.h;
    for (let y = 0; y < fine.h; y++) {
      const cy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(cy), y1 = Math.min(coarse.h - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x, q = fine.wt[i];
        if (q >= 1) continue;
        const cx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(cx), x1 = Math.min(coarse.w - 1, x0 + 1), fx = cx - x0;
        const a = y0 * coarse.w + x0, b = y0 * coarse.w + x1, c2 = y1 * coarse.w + x0, d = y1 * coarse.w + x1;
        for (let c = 0; c < 4; c++) {
          const C = coarse.ch[c];
          const up = (C[a] * (1 - fx) + C[b] * fx) * (1 - fy) + (C[c2] * (1 - fx) + C[d] * fx) * fy;
          fine.ch[c][i] = q * fine.ch[c][i] + (1 - q) * up;
        }
        fine.wt[i] = 1;
      }
    }
  }
  return levels[0].ch;
}

function smooth(ch, hole, w, h, iters) {
  const idx = [];
  for (let i = 0; i < hole.length; i++) if (hole[i]) idx.push(i);
  for (let it = 0; it < iters; it++) {
    for (const a of ch) {
      for (const i of idx) {
        const x = i % w, y = (i / w) | 0;
        let s = 0, k = 0;
        if (x > 0) { s += a[i - 1]; k++; }
        if (x < w - 1) { s += a[i + 1]; k++; }
        if (y > 0) { s += a[i - w]; k++; }
        if (y < h - 1) { s += a[i + w]; k++; }
        a[i] = s / k; // Gauss-Seidel in place converges faster than Jacobi
      }
    }
  }
}

function addGrain(ch, hole, w, h, strength) {
  // Measure fine-detail noise in a ring of known pixels around the hole.
  const ring = dilateMask(hole, w, h, 8);
  let sum = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ring[i] || hole[i]) continue;
      if (hole[i - 1] || hole[i + 1] || hole[i - w] || hole[i + w]) continue;
      for (let c = 0; c < 3; c++) {
        const a = ch[c];
        const d = a[i] - (a[i - 1] + a[i + 1] + a[i - w] + a[i + w]) / 4;
        sum += d * d; cnt++;
      }
    }
  }
  if (!cnt) return;
  const sigma = Math.min(18, Math.sqrt(sum / cnt)) * strength;
  if (sigma < 0.5) return;
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue;
    // Box-Muller
    const g = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(6.2831853 * rand()) * sigma;
    for (let c = 0; c < 3; c++) ch[c][i] += g;
  }
}

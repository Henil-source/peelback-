import { inpaint } from './inpaint.js';

const MAX_SIDE = 4096;       // larger uploads are scaled down to keep memory sane
const HISTORY_LIMIT = 20;
// Cutout models, run on-device. dtype is chosen per backend: full precision on the GPU,
// 8-bit on the CPU to keep the download and memory small.
// RMBG-1.4 weights are free for non-commercial use (BRIA licence); MODNet is Apache-2.0.
const MODELS = {
  best: { id: 'briaai/RMBG-1.4', dtype: { webgpu: 'fp32', wasm: 'q8' }, input: 'input', sigmoid: false },
  fast: { id: 'Xenova/modnet', dtype: { webgpu: 'fp32', wasm: 'q8' }, input: 'input', sigmoid: false },
};

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file-input'), drop: $('dropzone'), wrap: $('canvas-wrap'), box: $('canvas-box'),
  view: $('view'), paint: $('paint'), cursor: $('brush-cursor'), busy: $('busy'), busyText: $('busy-text'),
  status: $('status'), removeBg: $('btn-remove-bg'), bgFill: $('bg-fill'), bgCustom: $('bg-custom'),
  modePaint: $('mode-paint'), modeUnpaint: $('mode-unpaint'), size: $('brush-size'), sizeOut: $('brush-out'),
  erase: $('btn-erase'), clearMask: $('btn-clear-mask'), undo: $('btn-undo'), redo: $('btn-redo'),
  compare: $('btn-compare'), toggleBg: $('btn-toggle-bg'), quality: $('cut-quality'), download: $('btn-download'), newImg: $('btn-new'),
};
const vctx = el.view.getContext('2d', { willReadFrequently: true });
const pctx = el.paint.getContext('2d', { willReadFrequently: true });

const state = {
  name: 'image',
  original: null,   // ImageData as uploaded
  cur: null,        // the photo being edited (erases change this)
  cut: null,        // cutout alpha (Uint8ClampedArray) or null
  showCut: true,    // false shows the photo with its background back
  undo: [], redo: [],
  mode: 'paint',
  hasMask: false,
  comparing: false,
  busy: false,
  bgRemoved: false,
};
window.__peelback = state; // handy for debugging and automated tests

// ---------- Loading images ----------
el.file.addEventListener('change', () => { if (el.file.files[0]) loadFile(el.file.files[0]); el.file.value = ''; });
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/')); if (f) loadFile(f); });
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});
el.newImg.addEventListener('click', () => el.file.click());

async function loadFile(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setStatus('That file type is not supported. Try a PNG, JPG or WebP.', true);
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { return setStatus('That image could not be opened. It may be damaged.', true); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, w, h);
  state.name = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  state.original = x.getImageData(0, 0, w, h);
  state.cur = new ImageData(new Uint8ClampedArray(state.original.data), w, h);
  state.undo = []; state.redo = []; state.bgRemoved = false; state.cut = null; state.showCut = true;
  el.view.width = el.paint.width = w; el.view.height = el.paint.height = h;
  clearMask();
  el.drop.hidden = true; el.wrap.hidden = false; el.newImg.hidden = false;
  enableTools(true);
  render(); fit();
  setStatus(scale < 1 ? `Loaded and scaled to ${w} × ${h} px to keep things fast.` : `Loaded ${w} × ${h} px.`);
}

// ---------- Rendering ----------
function fillValue() {
  const v = document.querySelector('input[name=bg]:checked').value;
  return v === 'custom' ? el.bgCustom.value : v;
}
function compose(ctx, img) {
  const fill = fillValue();
  ctx.putImageData(img, 0, 0);
  if (fill !== 'transparent') {
    ctx.save(); ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = fill; ctx.fillRect(0, 0, img.width, img.height); ctx.restore();
  }
}
function render() {
  if (!state.cur) return;
  compose(vctx, state.comparing ? state.original : display());
}
// The photo with the cutout applied (when there is one and it is switched on).
function display() {
  const { cur, cut } = state;
  if (!cut || !state.showCut) return cur;
  const d = new Uint8ClampedArray(cur.data);
  for (let i = 0, n = cut.length; i < n; i++) { const a = i * 4 + 3; if (cut[i] < d[a]) d[a] = cut[i]; }
  return new ImageData(d, cur.width, cur.height);
}
function fit() {
  if (!state.cur) return;
  const r = el.wrap.getBoundingClientRect();
  const availW = r.width - 32, availH = Math.max(240, r.height - 32);
  const s = Math.min(availW / state.cur.width, availH / state.cur.height, 1);
  el.view.style.width = `${Math.floor(state.cur.width * s)}px`;
  el.view.style.height = `${Math.floor(state.cur.height * s)}px`;
}
new ResizeObserver(fit).observe(el.wrap);
el.bgFill.addEventListener('change', render);
el.bgCustom.addEventListener('input', () => { el.bgFill.querySelector('input[value=custom]').checked = true; render(); });

// ---------- History ----------
function snapshot() {
  state.undo.push(takeSnap());
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
  state.redo = [];
  syncButtons();
}
function takeSnap() {
  return { px: new Uint8ClampedArray(state.cur.data), cut: state.cut && new Uint8ClampedArray(state.cut), showCut: state.showCut };
}
function step(from, to) {
  if (!from.length) return;
  to.push(takeSnap());
  const s = from.pop();
  state.cur.data.set(s.px); state.cut = s.cut; state.showCut = s.showCut; state.bgRemoved = !!s.cut;
  render(); syncButtons();
}
el.undo.addEventListener('click', () => step(state.undo, state.redo));
el.redo.addEventListener('click', () => step(state.redo, state.undo));

// ---------- Compare ----------
const startCompare = () => { if (!state.cur) return; state.comparing = true; el.compare.setAttribute('aria-pressed', 'true'); render(); };
const endCompare = () => { if (!state.comparing) return; state.comparing = false; el.compare.setAttribute('aria-pressed', 'false'); render(); };
el.compare.addEventListener('pointerdown', startCompare);
['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((t) => el.compare.addEventListener(t, endCompare));
el.compare.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startCompare(); } });
el.compare.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') endCompare(); });

// ---------- Background removal ----------
const segmenters = {};
async function hasWebGPU() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}
function makeRun(T, model, processor, cfg) {
  return async (raw) => {
    const { pixel_values } = await processor(raw);
    const out = await model({ [cfg.input]: pixel_values });
    let t = out[Object.keys(out)[0]][0];
    if (t.type === 'float16') t = t.to('float32');
    if (cfg.sigmoid) t = t.sigmoid();
    return T.RawImage.fromTensor(t.mul(255).to('uint8'));
  };
}
async function getSegmenter(key) {
  if (segmenters[key]) return segmenters[key];
  const cfg = MODELS[key];
  const T = await import('./vendor/transformers.min.js');
  T.env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
  const p = new URLSearchParams(location.search);
  if (p.has('localModels')) { // offline testing: serve the model from ./models/
    T.env.allowRemoteModels = false; T.env.allowLocalModels = true;
    T.env.localModelPath = new URL('./models/', location.href).href;
  }
  const progress = (info) => {
    if (info.status === 'progress' && info.total > 1e6) setBusy(`Downloading cutout model (first time only)… ${Math.round((info.loaded / info.total) * 100)}%`);
  };
  const devices = (await hasWebGPU()) && !p.has('wasm') ? ['webgpu', 'wasm'] : ['wasm'];
  const processor = await T.AutoProcessor.from_pretrained(cfg.id);
  let lastErr;
  for (const device of devices) {
    try {
      const model = await T.AutoModel.from_pretrained(cfg.id, { dtype: cfg.dtype[device], device, progress_callback: progress });
      const seg = { T, model, processor, cfg, device, run: makeRun(T, model, processor, cfg) };
      segmenters[key] = seg;
      return seg;
    } catch (e) { lastErr = e; console.warn(`Cutout model failed on ${device}`, e); }
  }
  throw lastErr;
}

el.removeBg.addEventListener('click', async () => {
  if (state.busy || !state.cur) return;
  const key = el.quality.value in MODELS ? el.quality.value : 'best';
  setBusy('Loading cutout model…');
  try {
    let seg = await getSegmenter(key);
    setBusy('Finding the subject…');
    await nextFrame();
    const { width: w, height: h } = state.cur;
    // Run on the original pixels so earlier erases never confuse the model's view of the edges.
    const raw = new seg.T.RawImage(new Uint8ClampedArray(state.cur.data), w, h, 4).rgb();
    let mask;
    try { mask = await seg.run(raw); }
    catch (e) {
      if (seg.device === 'wasm') throw e;
      console.warn('GPU run failed, retrying on CPU', e);
      delete segmenters[key];
      const T = seg.T;
      const model = await T.AutoModel.from_pretrained(seg.cfg.id, { dtype: seg.cfg.dtype.wasm, device: 'wasm' });
      seg = { ...seg, model, device: 'wasm', run: makeRun(T, model, seg.processor, seg.cfg) };
      segmenters[key] = seg;
      setBusy('Finding the subject (this computer has no usable GPU, so it may take a little longer)…');
      mask = await seg.run(raw);
    }
    mask = await mask.resize(w, h);
    snapshot();
    state.cut = new Uint8ClampedArray(mask.data.length === w * h ? mask.data : mask.grayscale().data);
    state.showCut = true; state.bgRemoved = true;
    render(); syncButtons();
    setStatus('Background removed. Pick a fill colour, keep it transparent, or download.');
  } catch (err) {
    console.warn(err);
    setStatus(navigator.onLine === false
      ? 'You appear to be offline. The cutout model needs to download once before it can run.'
      : 'Background removal failed. Try the Fast option, or check your connection and try again.', true);
  } finally { setBusy(null); }
});

el.toggleBg.addEventListener('click', () => {
  if (!state.cut) return;
  state.showCut = !state.showCut;
  render(); syncButtons();
});

// ---------- Brush ----------
function setMode(m) {
  state.mode = m;
  el.modePaint.setAttribute('aria-pressed', String(m === 'paint'));
  el.modeUnpaint.setAttribute('aria-pressed', String(m === 'unpaint'));
}
el.modePaint.addEventListener('click', () => setMode('paint'));
el.modeUnpaint.addEventListener('click', () => setMode('unpaint'));
el.size.addEventListener('input', () => { el.sizeOut.textContent = el.size.value; updateCursorSize(); });

let drawing = false, last = null;
const imgScale = () => el.paint.width / el.paint.getBoundingClientRect().width;
function toImg(e) {
  const r = el.paint.getBoundingClientRect();
  return { x: (e.clientX - r.left) * imgScale(), y: (e.clientY - r.top) * imgScale() };
}
function stroke(a, b) {
  pctx.save();
  pctx.globalCompositeOperation = state.mode === 'paint' ? 'source-over' : 'destination-out';
  // Paint opaque, show translucent via CSS opacity, so overlapping strokes stay even.
  pctx.strokeStyle = pctx.fillStyle = '#ec4899';
  pctx.lineWidth = el.size.value * imgScale();
  pctx.lineCap = pctx.lineJoin = 'round';
  pctx.beginPath(); pctx.moveTo(a.x, a.y); pctx.lineTo(b.x, b.y); pctx.stroke();
  pctx.beginPath(); pctx.arc(b.x, b.y, pctx.lineWidth / 2, 0, Math.PI * 2); pctx.fill();
  pctx.restore();
}
el.paint.style.opacity = '0.5';
el.paint.addEventListener('pointerdown', (e) => {
  if (state.busy || !state.cur || e.button > 0) return;
  try { el.paint.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  drawing = true; last = toImg(e); stroke(last, last);
});
el.paint.addEventListener('pointermove', (e) => {
  moveCursor(e);
  if (!drawing) return;
  const p = toImg(e); stroke(last, p); last = p;
});
const endStroke = () => { if (!drawing) return; drawing = false; refreshMaskFlag(); };
el.paint.addEventListener('pointerup', endStroke);
el.paint.addEventListener('pointercancel', endStroke);
el.paint.addEventListener('pointerenter', (e) => { el.cursor.hidden = false; moveCursor(e); });
el.paint.addEventListener('pointerleave', () => { el.cursor.hidden = true; });
function moveCursor(e) {
  const r = el.box.getBoundingClientRect();
  el.cursor.style.left = `${e.clientX - r.left}px`; el.cursor.style.top = `${e.clientY - r.top}px`;
  updateCursorSize();
}
function updateCursorSize() { el.cursor.style.width = el.cursor.style.height = `${el.size.value}px`; }

function readMask() {
  const { width: w, height: h } = el.paint;
  const a = pctx.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < m.length; i++) if (a[i * 4 + 3] > 20) { m[i] = 1; any = true; }
  return any ? m : null;
}
function refreshMaskFlag() { state.hasMask = !!readMask(); syncButtons(); }
function clearMask() { pctx.clearRect(0, 0, el.paint.width, el.paint.height); state.hasMask = false; syncButtons(); }
el.clearMask.addEventListener('click', clearMask);

el.erase.addEventListener('click', async () => {
  const mask = readMask();
  if (!mask || state.busy) return;
  setBusy('Erasing…');
  await nextFrame();
  try {
    const t = performance.now();
    snapshot();
    inpaint(state.cur, mask);
    if (state.cut) {
      // Keep the cutout consistent: fill its alpha in the brushed area from the surroundings too.
      const { width: w, height: h } = state.cur;
      const a = new ImageData(w, h);
      for (let i = 0; i < w * h; i++) { const v = state.cut[i]; a.data[i * 4] = a.data[i * 4 + 1] = a.data[i * 4 + 2] = v; a.data[i * 4 + 3] = 255; }
      inpaint(a, mask, { grain: 0 });
      for (let i = 0; i < w * h; i++) state.cut[i] = a.data[i * 4];
    }
    clearMask(); render();
    const ms = Math.round(performance.now() - t);
    setStatus(state.cut && state.showCut
      ? `Erased in ${ms} ms. The background is hidden right now, so changes there only show after "Bring background back".`
      : `Erased in ${ms} ms. Brush again to touch up, or Undo.`);
  } catch (err) {
    console.warn(err); setStatus('Something went wrong while erasing. Try a smaller area.', true);
  } finally { setBusy(null); }
});

// ---------- Download ----------
el.download.addEventListener('click', () => {
  if (!state.cur) return;
  const c = document.createElement('canvas');
  c.width = state.cur.width; c.height = state.cur.height;
  compose(c.getContext('2d'), display());
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${state.name}-peelback.png`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus('Saved a PNG to your downloads.');
  }, 'image/png');
});

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  if (!state.cur || e.target.matches('input[type=color]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? el.redo.click() : el.undo.click(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); el.redo.click(); }
  else if (e.key === '[' || e.key === ']') {
    el.size.value = Math.max(4, Math.min(200, +el.size.value + (e.key === ']' ? 8 : -8)));
    el.size.dispatchEvent(new Event('input'));
  }
});

// ---------- UI helpers ----------
function enableTools(on) {
  [el.removeBg, el.modePaint, el.modeUnpaint, el.size, el.compare, el.download].forEach((b) => (b.disabled = !on));
  syncButtons();
}
function syncButtons() {
  const ready = !!state.cur && !state.busy;
  el.erase.disabled = !(ready && state.hasMask);
  el.clearMask.disabled = !(ready && state.hasMask);
  el.undo.disabled = !(ready && state.undo.length);
  el.redo.disabled = !(ready && state.redo.length);
  el.removeBg.disabled = !ready;
  el.download.disabled = !ready;
  el.bgFill.disabled = !(ready && state.cut && state.showCut);
  el.toggleBg.disabled = !(ready && state.cut);
  el.toggleBg.textContent = state.cut && !state.showCut ? 'Hide background again' : 'Bring background back';
}
function setBusy(text) {
  state.busy = !!text;
  el.busy.hidden = !text;
  if (text) el.busyText.textContent = text;
  el.paint.classList.toggle('off', !!text);
  syncButtons();
}
function setStatus(msg, isError = false) {
  el.status.textContent = msg; el.status.classList.toggle('error', isError);
}
// Let the busy overlay paint before heavy work. The timeout covers background tabs, where rAF never fires.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });

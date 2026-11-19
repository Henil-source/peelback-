# Peelback

An original, private, in-browser photo cleanup tool:

- **Remove background**: one click cuts out the subject, run locally via Transformers.js. "Best" uses RMBG-1.4 (any subject; GPU via WebGPU when available, about 1 s, otherwise CPU). "Fast" uses MODNet (people only, 7 MB). Fill behind it with transparent, white, charcoal, butter or any colour, or bring the background back at any time.
- **Erase a logo or object**: paint over it, press Erase, and the area is filled from its surroundings. Erasing edits the full photo, so it works before or after a cutout (multi-scale fill written for this app, in `inpaint.js`). For images you own or have rights to edit.
- Undo/redo (Ctrl/Cmd+Z, Shift+Z), hold to compare with the original, `[` and `]` change brush size, paste or drag and drop to load, download as PNG.

Live at https://henil-source.github.io/peelback-/

Nothing is uploaded. The only network call is the one-time model download from Hugging Face (about 176 MB for Best on a GPU, 44 MB on CPU, 7 MB for Fast), cached by the browser.

## Run it

The page uses JavaScript modules, so serve the repo folder over HTTP rather than double-clicking the file:

```
cd peelback-
python3 -m http.server 8000     # or: npx serve .
```

Then open http://localhost:8000. Any static host works too (GitHub Pages, Netlify, Cloudflare Pages, Vercel).

## Known limits (v1)

- **Licence note:** RMBG-1.4 weights are free for non-commercial use only (BRIA licence). Before selling Peelback, switch "Best" to an MIT/Apache model or get a BRIA licence. MODNet is Apache-2.0.
- Fast mode (MODNet) is tuned for people.
- The eraser blends rather than copies texture, so it is great on plain or gently varying backgrounds and soft on strong patterns (wood grain, text, faces). A patch-based or AI inpainting pass is the next upgrade.
- Images larger than 4096 px on a side are scaled down.

## Files

- `index.html`, `styles.css`, `app.js`: UI
- `inpaint.js`: the eraser fill
- `vendor/`: Transformers.js 3.7.6 and ONNX Runtime Web (Apache-2.0, from npm)
- `replica/`: planning notes from the build

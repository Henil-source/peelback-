# Peelback

An original, private, in-browser photo cleanup tool:

- **Remove background**: one click cuts out the subject with the open MODNet model (Apache-2.0), run locally via Transformers.js. Fill behind it with transparent, white, charcoal, butter or any colour.
- **Erase a logo or object**: paint over it, press Erase, and the area is filled from its surroundings (multi-scale fill written for this app, in `inpaint.js`). For images you own or have rights to edit.
- Undo/redo (Ctrl/Cmd+Z, Shift+Z), hold to compare with the original, `[` and `]` change brush size, paste or drag and drop to load, download as PNG.

Live at https://henil-source.github.io/peelback-/

Nothing is uploaded. The only network call is the one-time model download (~7 MB from Hugging Face), cached by the browser.

## Run it

The page uses JavaScript modules, so serve the repo folder over HTTP rather than double-clicking the file:

```
cd peelback-
python3 -m http.server 8000     # or: npx serve .
```

Then open http://localhost:8000. Any static host works too (GitHub Pages, Netlify, Cloudflare Pages, Vercel).

## Known limits (v1)

- MODNet is tuned for people. Products and animals can come out with rough edges or missed parts.
- The eraser blends rather than copies texture, so it is great on plain or gently varying backgrounds and soft on strong patterns (wood grain, text, faces). A patch-based or AI inpainting pass is the next upgrade.
- Images larger than 4096 px on a side are scaled down.

## Files

- `index.html`, `styles.css`, `app.js`: UI
- `inpaint.js`: the eraser fill
- `vendor/`: Transformers.js 3.7.6 and ONNX Runtime Web (Apache-2.0, from npm)
- `replica/`: planning notes from the build

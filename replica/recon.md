# Recon (category build, no single target app)

Scope: core loop of a photo cleanup tool. Upload, cut out background, brush to erase an object, download. Web, desktop and phone. For people editing their own photos (product shots, profile pictures, social posts).

Screens: S01 empty/drop (states: idle, drag-over, bad file), S02 editor (loading model, working, filled, error, mobile).
Flows: F01 remove background (3 clicks: choose file, Remove background, Download). F02 erase object (choose file, brush, Erase, Download). F03 change fill colour (1 click).
Components: dropzone, primary/ghost button, swatch picker, segmented toggle, range slider, busy overlay, status line.
Data model: none stored. Everything lives in memory in the tab.
Skip: server-side processing, accounts, batch/API, HD credits and billing (not in v1).
Size: S.

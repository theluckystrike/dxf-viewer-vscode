# Changelog

## 0.1.1 (2026-11-06)

- The bar under the drawing ends with two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `dxfViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "DXF Viewer: Support the developer" and "DXF Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.0 (2026-11-06)

- First release. Opens ASCII and binary DXF files (R12 to AutoCAD 2018) in a read-only editor.
- Layers panel with show and hide, entity counts by type, drawing facts (version, units, size).
- Pan, zoom, fit, measure distance with snapping, dark or white background.
- Blocks and nested inserts, insert arrays, attributes, text, MTEXT, dimensions, hatches, splines, ellipses and linetypes.
- Export the view as PNG or SVG.
- DWG files show a page that explains how to save them as DXF.
- Files over 500 MB show a message and are not read (setting `dxfViewer.maxFileMB`).
- One-time rating prompt (setting `dxfViewer.askForRating`).

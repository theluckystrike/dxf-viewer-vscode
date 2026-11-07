# Changelog

## 0.1.3 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.

## 0.1.2 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first in each group.

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

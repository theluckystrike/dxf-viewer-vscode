# Changelog

## 0.2.0 (2026-11-07)

- Sheets: drawings with paper space get a Sheet list. Each layout shows its title block and its viewports at their scale and twist, clipped to the frame, without the layers frozen in that viewport.
- Hatch patterns are drawn as their pattern lines (angle, spacing, dashes and dots from the file), cut at the boundary and around islands. Far out, or above 4,000 lines in one hatch, they show as a light tint.
- Find text: Ctrl+F or Cmd+F finds text, MTEXT and block attributes on the sheet on screen, zooms to each match and frames it. Enter and Shift+Enter step through the matches.
- Live reload: the view reads the file again when it changes on disk and keeps the zoom, the sheet and the hidden layers. Setting `dxfViewer.liveReload` (default `true`).
- PNG and SVG export include the sheet on screen with its viewports.

## 0.1.4 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

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

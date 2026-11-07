"""Builds house-sheets.dxf for the README pictures and the release check with ezdxf (MIT): a small ground floor
plan with blocks, dimensions, room labels and pattern hatches, plus two paper space sheets with viewports.
usage: python3 scripts/make_sheet_sample.py <samplesDir>   (needs `pip install ezdxf` in a venv)"""
import sys, os
import ezdxf
d = sys.argv[1]
doc = ezdxf.new('R2018', setup=True)
doc.units = ezdxf.units.MM
for name, color in [('WALLS', 7), ('DOORS', 3), ('WINDOWS', 4), ('FURNITURE', 30), ('DIMENSIONS', 1), ('TEXT', 2), ('PATTERNS', 8), ('TITLE', 7), ('VIEWPORTS', 4), ('GRID', 9)]:
    doc.layers.add(name, color=color)
doc.layers.get('GRID').dxf.linetype = 'DASHED'
msp = doc.modelspace()
W, H, t = 14000, 9000, 250
door = doc.blocks.new('DOOR'); door.add_line((0, 0), (900, 0)); door.add_line((0, 0), (0, 900)); door.add_arc((0, 0), 900, 0, 90)
win = doc.blocks.new('WINDOW'); win.add_lwpolyline([(0, 0), (1200, 0), (1200, t), (0, t)], close=True); win.add_line((0, t / 2), (1200, t / 2))
bed = doc.blocks.new('BED'); bed.add_lwpolyline([(0, 0), (1600, 0), (1600, 2000), (0, 2000)], close=True); bed.add_line((0, 1500), (1600, 1500))
bed.add_lwpolyline([(100, 1650), (750, 1650), (750, 1900), (100, 1900)], close=True); bed.add_lwpolyline([(850, 1650), (1500, 1650), (1500, 1900), (850, 1900)], close=True)
chair = doc.blocks.new('CHAIR', base_point=(225, 225)); chair.add_lwpolyline([(0, 0), (450, 0), (450, 450), (0, 450)], close=True); chair.add_line((40, 400), (410, 400))
tag = doc.blocks.new('TAG'); tag.add_circle((0, 0), 260); tag.add_attdef('ID', (0, -60), dxfattribs={'height': 140, 'halign': 1})
msp.add_lwpolyline([(0, 0), (W, 0), (W, H), (0, H)], close=True, dxfattribs={'layer': 'WALLS'})
msp.add_lwpolyline([(t, t), (W - t, t), (W - t, H - t), (t, H - t)], close=True, dxfattribs={'layer': 'WALLS'})
ring = msp.add_hatch(color=256, dxfattribs={'layer': 'WALLS'})
ring.paths.add_polyline_path([(0, 0), (W, 0), (W, H), (0, H)], is_closed=True, flags=1)
ring.paths.add_polyline_path([(t, t), (W - t, t), (W - t, H - t), (t, H - t)], is_closed=True, flags=16)
for x1, y1, x2, y2 in [(6000, t, 6000, 5200), (6000, 6200, 6000, H - t), (t, 5200, 3600, 5200), (4500, 5200, 6000, 5200), (9800, t, 9800, 3600), (9800, 4500, 9800, H - t)]:
    if x1 == x2: msp.add_lwpolyline([(x1 - 60, y1), (x1 + 60, y1), (x2 + 60, y2), (x2 - 60, y2)], close=True, dxfattribs={'layer': 'WALLS'})
    else: msp.add_lwpolyline([(x1, y1 - 60), (x2, y1 - 60), (x2, y2 + 60), (x1, y2 + 60)], close=True, dxfattribs={'layer': 'WALLS'})
for x, y, r in [(3600, 5200, 0), (6000, 5200, 90), (9800, 3600, 90), (2000, 0, 0)]:
    msp.add_blockref('DOOR', (x, y), dxfattribs={'layer': 'DOORS', 'rotation': r})
for x in [1500, 3800, 7200, 11000]: msp.add_blockref('WINDOW', (x, 0), dxfattribs={'layer': 'WINDOWS'})
for x in [1500, 7200, 11500]: msp.add_blockref('WINDOW', (x, H - t), dxfattribs={'layer': 'WINDOWS'})
msp.add_blockref('BED', (7200, 6400), dxfattribs={'layer': 'FURNITURE'})
msp.add_lwpolyline([(2100, 2150), (3900, 2150), (3900, 3050), (2100, 3050)], close=True, dxfattribs={'layer': 'FURNITURE'})
for x, y, r in [(2550, 1850, 0), (3450, 1850, 0), (2550, 3350, 180), (3450, 3350, 180)]:
    msp.add_blockref('CHAIR', (x, y), dxfattribs={'layer': 'FURNITURE', 'rotation': r})
def hatch(pts, pattern, scale, angle=0):
    h = msp.add_hatch(color=256, dxfattribs={'layer': 'PATTERNS'})
    h.set_pattern_fill(pattern, scale=scale, angle=angle)
    h.paths.add_polyline_path(pts, is_closed=True, flags=1)
hatch([(t, 5260), (3600, 5260), (3600, H - t), (t, H - t)], 'ANSI37', 60)
hatch([(6060, t), (9740, t), (9740, 4740), (6060, 4740)], 'NET', 40)
hatch([(9860, t), (W - t, t), (W - t, 4440), (9860, 4440)], 'ANSI32', 50, 90)
for x, y, name, area in [(3000, 4300, 'LIVING / DINING', '31.2'), (1900, 7200, 'BATH', '12.0'), (7900, 2400, 'KITCHEN', '19.6'), (9500, 7700, 'BEDROOM', '30.4'), (11900, 2500, 'STUDY', '15.3')]:
    msp.add_mtext(f'{name}\\P{area} m²', dxfattribs={'layer': 'TEXT', 'char_height': 280, 'insert': (x, y), 'attachment_point': 5})
msp.add_text('PUMP P-1 (UNDER SINK)', height=150, dxfattribs={'layer': 'TEXT'}).set_placement((6250, 500))
for x, y, ident in [(6400, 4200, 'V-7'), (13200, 8400, 'DB-1')]:
    msp.add_blockref('TAG', (x, y), dxfattribs={'layer': 'TEXT'}).add_auto_attribs({'ID': ident})
for x, s in [(0, 'A'), (6000, 'B'), (9800, 'C'), (W, 'D')]:
    msp.add_line((x, -1500), (x, H + 1100), dxfattribs={'layer': 'GRID'})
    msp.add_circle((x, H + 1500), 400, dxfattribs={'layer': 'GRID', 'linetype': 'CONTINUOUS'})
    msp.add_text(s, height=350, dxfattribs={'layer': 'GRID'}).set_placement((x, H + 1500), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
for p1, p2, base in [((0, 0), (6000, 0), (0, -900)), ((6000, 0), (9800, 0), (0, -900)), ((9800, 0), (W, 0), (0, -900))]:
    dim = msp.add_linear_dim(base=base, p1=p1, p2=p2, dimstyle='EZDXF', override={'dimtxt': 250, 'dimasz': 200, 'dimexe': 100, 'dimexo': 100, 'dimlfac': 1}, dxfattribs={'layer': 'DIMENSIONS'})
    dim.render()
dim = msp.add_linear_dim(base=(W + 900, 0), p1=(W, 0), p2=(W, H), angle=90, dimstyle='EZDXF', override={'dimtxt': 250, 'dimasz': 200, 'dimlfac': 1}, dxfattribs={'layer': 'DIMENSIONS'}); dim.render()
a3 = doc.layouts.new('A-101 Ground floor')
a3.page_setup(size=(420, 297), margins=(0, 0, 0, 0), units='mm')
a3.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True, dxfattribs={'layer': 'TITLE'})
a3.add_lwpolyline([(290, 10), (410, 10), (410, 50), (290, 50)], close=True, dxfattribs={'layer': 'TITLE'})
a3.add_text('GROUND FLOOR PLAN', height=6, dxfattribs={'layer': 'TITLE'}).set_placement((295, 38))
a3.add_text('SHEET A-101   SCALE 1:100', height=3.5, dxfattribs={'layer': 'TITLE'}).set_placement((295, 28))
a3.add_text('DRAWN JD   CHECKED MK   REV C', height=3, dxfattribs={'layer': 'TITLE'}).set_placement((295, 18))
a3.add_viewport(center=(150, 160), size=(260, 230), view_center_point=(7000, 4300), view_height=13500, dxfattribs={'layer': 'VIEWPORTS'})
det = doc.layouts.new('A-501 Bath detail')
det.page_setup(size=(297, 210), margins=(0, 0, 0, 0), units='mm')
det.add_lwpolyline([(10, 10), (287, 10), (287, 200), (10, 200)], close=True, dxfattribs={'layer': 'TITLE'})
det.add_text('BATH DETAIL   SCALE 1:25', height=5, dxfattribs={'layer': 'TITLE'}).set_placement((20, 18))
v = det.add_viewport(center=(105, 112), size=(170, 160), view_center_point=(1900, 7100), view_height=4000, dxfattribs={'layer': 'VIEWPORTS'})
v.freeze('FURNITURE')
det.add_viewport(center=(240, 130), size=(80, 100), view_center_point=(7000, 4500), view_height=12500, dxfattribs={'layer': 'VIEWPORTS'})
det.add_text('KEY PLAN', height=4, dxfattribs={'layer': 'TITLE'}).set_placement((205, 70))
doc.layouts.delete('Layout1')
doc.saveas(os.path.join(d, 'house-sheets.dxf'))
print('wrote', os.path.join(d, 'house-sheets.dxf'), os.path.getsize(os.path.join(d, 'house-sheets.dxf')))

"""Writes test/fixtures/ezdxf-layouts.dxf with ezdxf (MIT), an independent DXF writer: model space with an
ANSI31 pattern hatch (with a hole), text to search for, and two paper space layouts with viewports.
Also writes ezdxf-layouts-expected.json with what ezdxf put in each layout.
usage: python3 scripts/make_layout_fixture.py <outDir>   (needs `pip install ezdxf` in a venv)"""
import sys, os, json
import ezdxf
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
doc = ezdxf.new('R2018', setup=True)
doc.units = ezdxf.units.MM
doc.layers.add('WALLS', color=7); doc.layers.add('HATCH', color=8); doc.layers.add('NOTES', color=2); doc.layers.add('DIMS', color=3)
doc.layers.add('VIEWPORTS', color=4)
msp = doc.modelspace()
msp.add_lwpolyline([(0, 0), (10000, 0), (10000, 6000), (0, 6000)], close=True, dxfattribs={'layer': 'WALLS'})
msp.add_lwpolyline([(4000, 2000), (6000, 2000), (6000, 4000), (4000, 4000)], close=True, dxfattribs={'layer': 'WALLS'})
h = msp.add_hatch(color=256, dxfattribs={'layer': 'HATCH'})
h.set_pattern_fill('ANSI31', scale=200, angle=0)
h.paths.add_polyline_path([(0, 0), (10000, 0), (10000, 6000), (0, 6000)], is_closed=True, flags=1)
h.paths.add_polyline_path([(4000, 2000), (6000, 2000), (6000, 4000), (4000, 4000)], is_closed=True, flags=16)
msp.add_text('PUMP-101', height=250, dxfattribs={'layer': 'NOTES'}).set_placement((1000, 5000))
msp.add_mtext('Valve V-7 check weekly', dxfattribs={'layer': 'NOTES', 'char_height': 200, 'insert': (7000, 1000)})
blk = doc.blocks.new('TAG')
blk.add_circle((0, 0), 300)
blk.add_attdef('ID', (0, 0), dxfattribs={'height': 150})
ins = msp.add_blockref('TAG', (8500, 5000))
ins.add_auto_attribs({'ID': 'T-42'})
msp.add_line((0, -1000), (10000, -1000), dxfattribs={'layer': 'DIMS'})
# layout 1: A3 sheet, one viewport at 1:50 showing the whole plan, title block text
a3 = doc.layouts.new('A3 Plan')
a3.page_setup(size=(420, 297), margins=(10, 10, 10, 10), units='mm')
a3.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True)
a3.add_text('SHEET A-101 GROUND FLOOR', height=6).set_placement((20, 20))
a3.add_viewport(center=(210, 160), size=(380, 220), view_center_point=(5000, 2500), view_height=11000, dxfattribs={'layer': 'VIEWPORTS'})
# layout 2: detail with 2 viewports, the second freezes the HATCH layer
det = doc.layouts.new('Detail')
det.page_setup(size=(297, 210), margins=(10, 10, 10, 10), units='mm')
det.add_text('DETAIL D-1', height=5).set_placement((20, 15))
det.add_viewport(center=(80, 110), size=(120, 160), view_center_point=(5000, 3000), view_height=2400, dxfattribs={'layer': 'VIEWPORTS'})
vp2 = det.add_viewport(center=(220, 110), size=(120, 160), view_center_point=(5000, 3000), view_height=8000, dxfattribs={'layer': 'VIEWPORTS'})
vp2.freeze('HATCH')
doc.layouts.delete('Layout1')
doc.saveas(os.path.join(out, 'ezdxf-layouts.dxf'))
exp = {'layouts': []}
for name in doc.layout_names_in_taborder():
    if name == 'Model': continue
    lay = doc.layouts.get(name)
    vps = [e for e in lay if e.dxftype() == 'VIEWPORT']
    exp['layouts'].append({'name': name, 'entities': sorted(e.dxftype() for e in lay if e.dxftype() != 'VIEWPORT'),
                           'viewports': [{'center': list(v.dxf.center)[:2], 'w': v.dxf.width, 'h': v.dxf.height, 'id': v.dxf.id,
                                          'view_center': list(v.dxf.view_center_point)[:2], 'view_height': v.dxf.view_height,
                                          'frozen': list(v.frozen_layers)} for v in vps]})
pat = h.pattern
exp['hatch'] = {'pattern': h.dxf.pattern_name, 'lines': [[l.angle, list(l.base_point), list(l.offset), list(l.dash_length_items)] for l in pat.lines]}
json.dump(exp, open(os.path.join(out, 'ezdxf-layouts-expected.json'), 'w'), indent=1)
print(json.dumps(exp, indent=1))

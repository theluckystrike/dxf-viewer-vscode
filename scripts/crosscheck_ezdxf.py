"""Cross-check with ezdxf (MIT), an independent DXF library: it writes a reference drawing as
ASCII R2018 and as binary DXF, and lists what it put in model space. The tests compare our parser with it.
usage: python3 scripts/crosscheck_ezdxf.py <outDir>   (needs `pip install ezdxf` in a venv)"""
import sys, os, json, collections, math
import ezdxf
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
doc = ezdxf.new('R2018', setup=True)
doc.units = ezdxf.units.MM
doc.layers.add('WALLS', color=7); doc.layers.add('DOORS', color=3); doc.layers.add('NOTES', color=2)
doc.layers.add('HIDDEN-OFF', color=5).off()
blk = doc.blocks.new('DOOR', base_point=(0, 0))
blk.add_line((0, 0), (900, 0)); blk.add_arc((0, 0), 900, 0, 90)
msp = doc.modelspace()
msp.add_lwpolyline([(0, 0), (8000, 0), (8000, 5000), (0, 5000)], close=True, dxfattribs={'layer': 'WALLS'})
msp.add_lwpolyline([(1000, 1000, 0, 0, 0.5), (3000, 1000), (3000, 2000)], format='xyseb', dxfattribs={'layer': 'WALLS'})
msp.add_line((4000, 0), (4000, 5000), dxfattribs={'layer': 'WALLS'})
msp.add_circle((6000, 2500), 600, dxfattribs={'layer': 'NOTES'})
msp.add_arc((2000, 4000), 500, 30, 210, dxfattribs={'layer': 'NOTES'})
msp.add_ellipse((6000, 4000), major_axis=(800, 0), ratio=0.5, dxfattribs={'layer': 'NOTES'})
msp.add_spline([(0, -500), (1000, -1000), (2000, -200), (3000, -900)], dxfattribs={'layer': 'NOTES'})
msp.add_text('ROOM 1', height=250, dxfattribs={'layer': 'NOTES'}).set_placement((2000, 2500), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
msp.add_mtext('Line one\\PLine two', dxfattribs={'layer': 'NOTES', 'char_height': 200, 'insert': (5000, 1000)})
for i in range(3):
    msp.add_blockref('DOOR', (500 + i * 1500, 0), dxfattribs={'layer': 'DOORS', 'rotation': 90 * i})
h = msp.add_hatch(color=1); h.paths.add_polyline_path([(100, 100), (900, 100), (900, 900), (100, 900)], is_closed=True)
dim = msp.add_linear_dim(base=(0, -1500), p1=(0, 0), p2=(8000, 0), dxfattribs={'layer': 'NOTES'}); dim.render()
msp.add_point((7000, 4500), dxfattribs={'layer': 'HIDDEN-OFF'})
counts = collections.Counter(e.dxftype() for e in msp)
a = os.path.join(out, 'ezdxf-r2018.dxf'); b = os.path.join(out, 'ezdxf-r2018-binary.dxf')
doc.saveas(a); doc.saveas(b, fmt='bin')
print(json.dumps({"ezdxf": ezdxf.__version__, "counts": dict(counts), "layers": sorted(l.dxf.name for l in doc.layers),
                  "files": {os.path.basename(a): os.path.getsize(a), os.path.basename(b): os.path.getsize(b)}}, indent=1, sort_keys=True))

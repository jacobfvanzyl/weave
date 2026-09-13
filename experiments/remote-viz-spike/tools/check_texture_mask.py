#!/usr/bin/env python3
"""Native output and fail-closed checks for the observed texture/mask subset."""
import copy
import json
import pathlib
import subprocess
import sys
from png_pixels import read_png

root = pathlib.Path(__file__).resolve().parents[1]
build = root / '.build'
base = json.loads((build / 'synthetic/frame-1.json').read_text())
output = build / 'texture-mask-tests'
output.mkdir(exist_ok=True)
(output / 'tile.bgra').write_bytes((build / 'synthetic/tile.bgra').read_bytes())

def texture_frame():
    frame = copy.deepcopy(base)
    frame['resources'][0]['origin_top_left'] = True
    quad = frame['render_passes'][0]['quad_list'][0]
    quad.update(material=9, tex_coord_rect=[0, 0, 1, 1], is_normalized_coords=True,
                force_rgbx=False, secure_output_only=False, is_video_frame=False,
                protected_video_type=0, rounded_display_masks_info='0,0,is_horizontally_positioned=1')
    frame['render_passes'][0]['quad_extensions'][0]['texture_background_rgba'] = [0, 0, 0, 0]
    return frame

def run(name, frame, rejection=None):
    path = output / (name + '.json')
    path.write_text(json.dumps(frame))
    image = output / (name + '.png')
    image.unlink(missing_ok=True)
    result = subprocess.run([str(build / 'viz-replay'), str(output), str(path)], capture_output=True, text=True)
    if rejection:
        assert result.returncode and rejection in result.stderr, result.stderr
        assert not image.exists(), 'rejected input produced an image'
        return
    assert result.returncode == 0, result.stderr
    return read_png(image)[2]

normalized = run('normalized-texture', texture_frame())
original = read_png(build / 'synthetic-rendered/frame-1.png')[2]
for y in range(100):
    for x in range(160):
        assert normalized(x, y) == original(x, y), ('texture/tile equivalence', x, y)
scaled = texture_frame()
q = scaled['render_passes'][0]['quad_list'][0]
q.update(is_normalized_coords=False, tex_coord_rect=[0, 0, 16, 12], nearest_neighbor=False)
pixel = run('strict-scaled-source', scaled)
assert pixel(41, 43) == (99, 120, 60, 255), ('source-bound texel bleed', pixel(41, 43))

masked = texture_frame()
extra = masked['render_passes'][0]['quad_extensions'][0]
extra.update(mask_filter_is_empty=False, mask={'has_gradient':False, 'bounds':[0, 0, 32, 24], 'radii':[4]*8})
pixel = run('native-rounded-mask', masked)
assert pixel(10, 20) == (255, 0, 0, 255), 'rounded corner not clipped'
assert pixel(15, 25) == normalized(15, 25), 'mask clipped interior'
assert pixel(15, 40) == normalized(15, 40), 'mask vertical origin'

for name, mutate, message in [
    ('bottom-left', lambda f:f['resources'][0].update(origin_top_left=False), 'resource origin'),
    ('gradient', lambda f:f['render_passes'][0]['quad_extensions'][0]['mask'].update(has_gradient=True), 'unsupported mask'),
    ('complex-corners', lambda f:f['render_passes'][0]['quad_extensions'][0]['mask'].update(radii=[2, 2, 4, 4, 4, 4, 4, 4]), 'unsupported mask'),
    ('masked-translucent-src', lambda f:f['render_passes'][0]['quad_list'][0].update(needs_blending=False), 'masked Src'),
]:
    frame = copy.deepcopy(masked)
    mutate(frame)
    run(name, frame, message)
print(json.dumps({'synthetic':True, 'passed':True, 'checks':['normalized texture matches tile pixels', 'strict scaled source bounds', 'native rounded mask interior/corner/origin', 'bottom-left resource rejection', 'gradient rejection', 'unequal radius rejection', 'translucent masked Src rejection']}))

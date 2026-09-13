#!/usr/bin/env python3
"""Synthetic native affine/blur checks, independent of screenshot comparisons."""
import copy
import json
import pathlib
import subprocess
from png_pixels import read_png
root=pathlib.Path(__file__).resolve().parents[1];build=root/'.build';output=build/'affine-blur-tests';output.mkdir(exist_ok=True)
base=json.loads((build/'synthetic/frame-1.json').read_text())
(output/'tile.bgra').write_bytes((build/'synthetic/tile.bgra').read_bytes())
def run(name,frame,rejection=None):
    path=output/(name+'.json');path.write_text(json.dumps(frame));image=output/(name+'.png');image.unlink(missing_ok=True)
    result=subprocess.run([str(build/'viz-replay'),str(output),str(path)],capture_output=True,text=True)
    if rejection:
        assert result.returncode!=0 and rejection in result.stderr,result.stderr
        assert not image.exists(),'rejected state wrote image'
        return
    assert result.returncode==0,result.stderr
    return read_png(image)[2]
for name,(a,b,c,d,tx,ty,px,py) in {
    'rotate90':(0,-1,1,0,60,10,54,15),
    'scale2':(2,0,0,2,20,10,31,21),
    'shear':(1,.5,0,1,20,20,28,25),
}.items():
    frame=copy.deepcopy(base);state=frame['render_passes'][1]['shared_quad_state_list'][1]
    state['quad_to_target_transform']=[a,b,0,tx,c,d,0,ty,0,0,1,0,0,0,0,1]
    frame['render_passes'][1]['quad_list'][1]['nearest_neighbor']=True
    pixel=run(name,frame)
    assert pixel(px,py)==(45,120,20,255),(name,pixel(px,py))
# Blur a colored child pass over a transparent destination: check spread, symmetry,
# premultiplication and expanded bounds. These are not assertions of Skia identity.
frame=copy.deepcopy(base);frame['resources']=[]
child,outer=frame['render_passes']
child['output_rect']=[0,0,32,24]
child['quad_list']=[dict(material=5,rect=[0,0,32,24],visible_rect=[0,0,32,24],needs_blending=True,shared_quad_state={'index':0})]
child['quad_extensions']=[dict(resource_id_unsigned='0',mask_filter_is_empty=True,solid_color_rgba=[1,0,0,1])]
child['has_transparent_background']=True
outer['has_transparent_background']=True
outer['quad_list']=[copy.deepcopy(outer['quad_list'][1])]
outer['quad_extensions']=[dict(resource_id_unsigned='0',mask_filter_is_empty=True,blur_uses_decal=True,filter_output_rect=[-6,-6,44,36])]
outer['quad_list'][0].update(filters=[dict(type=8,amount=2)],filters_scale=[1,1],filters_origin=[0,0])
outer['shared_quad_state_list'][1]['quad_to_target_transform'][3]=40
outer['shared_quad_state_list'][1]['quad_to_target_transform'][7]=30
pixel=run('blur',frame)
assert pixel(55,41)==(255,0,0,255),pixel(55,41)
left,right=pixel(38,41),pixel(73,41)
assert 0<left[3]<128 and left==right,(left,right)
assert left[0]==255 and left[1:3]==(0,0),'premultiplied colored edge'
assert pixel(33,41)[3]==0,'blur escaped expanded output bounds'
assert pixel(55,28)==pixel(55,55),'vertical blur symmetry'
for name,mutate,error in [
    ('perspective',lambda f:f['render_passes'][1]['shared_quad_state_list'][1]['quad_to_target_transform'].__setitem__(12,.01),'perspective'),
    ('singular',lambda f:f['render_passes'][1]['shared_quad_state_list'][1]['quad_to_target_transform'].__setitem__(0,0),'singular'),
    ('filter-chain',lambda f:f['render_passes'][1]['quad_list'][0]['filters'].append(dict(type=8,amount=1)),'one unit-scale'),
    ('backdrop',lambda f:f['render_passes'][1]['quad_list'][0].update(backdrop_filters=[dict(type=8,amount=2)]),'backdrop'),
    ('scaled-filter',lambda f:f['render_passes'][1]['quad_list'][0].update(filters_scale=[2,2]),'one unit-scale'),
    ('clamped-blur',lambda f:f['render_passes'][1]['quad_extensions'][0].update(blur_uses_decal=False),'one unit-scale'),
]:
    candidate=copy.deepcopy(frame);mutate(candidate);run(name,candidate,error)
print(json.dumps({'synthetic':True,'passed':True,'checks':['90-degree transform coordinates','2x scaling coordinates','shear coordinates','blur expansion/symmetry/premultiplication','perspective rejection','singular-transform rejection','filter-chain rejection','backdrop rejection','scaled-filter rejection','non-decal rejection']}))

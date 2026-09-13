#!/usr/bin/env python3
"""Synthetic decoder/Metal fixtures. These are NOT captured Chromium output."""
import copy
import json
import pathlib
import sys
out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
pixels=bytearray()
for y in range(24):
    for x in range(32):
        pixels.extend([90,60,30,128] if x>=16 and y>=12 else [x*4,120,y*9,255])
(out/'tile.bgra').write_bytes(pixels)
identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
def state(x=0,y=0,opacity=1,clip=None):
    m=identity.copy(); m[3]=x; m[7]=y
    d=dict(quad_to_target_transform=m,opacity=opacity,blend_mode='SrcOver',sorting_context_id=0)
    if clip is not None:d['clip_rect']=clip
    return d
def quad(material,rect,index=0,**fields):
    fields.setdefault('needs_blending',True)
    return dict(material=material,rect=rect,visible_rect=rect,shared_quad_state={'index':index},**fields)
def extra(resource='0',color=None):
    d=dict(resource_id_unsigned=resource,mask_filter_is_empty=True)
    if color is not None:d['solid_color_rgba']=color
    return d
for sequence,x in enumerate([10,50,90],1):
    child=dict(id='AggregatedRenderPass/0x1',output_rect=[0,0,32,24],damage_rect=[0,0,32,24],
        shared_quad_state_list=[state()],quad_list=[quad(10,[0,0,32,24],tex_coord_rect=[0,0,32,24],nearest_neighbor=True)],quad_extensions=[extra('42')])
    # Front-to-back: clipped half-opacity blue, moved textured child pass, red background.
    root=dict(id='AggregatedRenderPass/0x2',output_rect=[0,0,160,100],damage_rect=[0,0,160,100],
        shared_quad_state_list=[state(0,0,.5,[120,10,10,20]),state(x,20),state()],
        quad_list=[quad(5,[120,10,30,20]),quad(4,[0,0,32,24],1,render_pass_id={'id_ref':'0x1'},filters=[],backdrop_filters=[]),quad(5,[0,0,160,100],2)],
        quad_extensions=[extra(color=[0,0,1,1]),extra(),extra(color=[1,0,0,1])])
    frame=dict(capture_schema=1,capture_session="synthetic-only",synthetic=True,frame=sequence,all_referenced_resource_pixels_copied=True,
        resources=[dict(id='42',generation=1,width=32,height=24,row_bytes=128,file='tile.bgra',uploaded=sequence==1)],
        render_passes=[child,root],deleted_resources=[])
    (out/f'frame-{sequence}.json').write_text(json.dumps(frame))
crop=copy.deepcopy(frame)
crop['render_passes'][0]['output_rect']=[10,20,32,24]
crop['render_passes'][0]['quad_list'][0]['rect']=[10,20,32,24]
crop['render_passes'][0]['quad_list'][0]['visible_rect']=[10,20,32,24]
crop['render_passes'][1]['quad_list'][1]['rect']=[0,0,16,12]
crop['render_passes'][1]['quad_list'][1]['visible_rect']=[0,0,16,12]
(out/'pass-crop.json').write_text(json.dumps(crop))
source=copy.deepcopy(frame)
source['render_passes'][1]['quad_list'][1]['needs_blending']=False
(out/'source-copy.json').write_text(json.dumps(source))
print(json.dumps({'synthetic':True,'movementFrames':3,'additionalSamplingAndBlendFixtures':2,'resourcePayloadBytes':3072,'laterResourcePayloadBytes':0}))

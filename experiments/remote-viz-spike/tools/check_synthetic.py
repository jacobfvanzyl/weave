#!/usr/bin/env python3
"""Verify actual Metal output pixels without third-party Python packages."""
import json
import pathlib
import sys
from png_pixels import read_png
root=pathlib.Path(sys.argv[1])
for n,x in enumerate([10,50,90],1):
    _,_,pixel=read_png(root/'synthetic-rendered'/f'frame-{n}.png')
    assert pixel(x+5,25)==(45,120,20,255),(n,pixel(x+5,25))
    assert pixel(x+5,40)==(180,120,20,255),'vertical texture orientation'
    assert pixel(x+28,25)==(45,120,112,255),'horizontal texture coordinates'
    assert pixel(x+20,37)==(157,60,90,255),'premultiplied texture alpha'
    assert pixel(5,5)==(255,0,0,255)
    assert pixel(135,15)==(255,0,0,255),'scissor leaked'
    blend=pixel(125,15)
    assert abs(blend[0]-127)<=1 and abs(blend[2]-128)<=1 and blend[1]==0 and blend[3]==255,blend
rows=[json.loads(s) for s in pathlib.Path(sys.argv[2]).read_text().splitlines()]
assert [r['uploadedBytes'] for r in rows]==[3072,0,0]
assert [r['reusedResources'] for r in rows]==[0,1,1]
_,_,crop=read_png(root/'synthetic-rendered'/'pass-crop.png')
assert crop(95,25)==(45,120,20,255),'child pass crop or nonzero target origin'
assert crop(107,25)==(255,0,0,255),'child pass crop size'
_,_,source=read_png(root/'synthetic-rendered'/'source-copy.png')
rgba=source(110,37)
assert rgba[:2]==(60,120) and abs(rgba[2]-180)<=1 and rgba[3]==128,'Src replacement vs SrcOver'
print(json.dumps({'synthetic':True,'pixelChecks':'pass','checks':['movement','render-pass dependency','front-to-back ordering','scissor','premultiplied opacity','persistent MTLTexture reuse','BGRA channel order','texture orientation','premultiplied texture alpha','child pass crop','nonzero pass origin','Src replacement'],'uploadedBytes':[3072,0,0]}))

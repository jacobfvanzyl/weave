#!/usr/bin/env python3
"""Compare decoded sRGB fixture pixels; emits metrics and an amplified RGB diff."""
import argparse
import json
import pathlib
import struct
import zlib
from png_pixels import read_png

p=argparse.ArgumentParser()
p.add_argument('reference',type=pathlib.Path)
p.add_argument('replay',type=pathlib.Path)
p.add_argument('--diff',type=pathlib.Path,required=True)
p.add_argument('--tolerance',type=int,default=2)
a=p.parse_args()
assert 0<=a.tolerance<=255
w,h,left=read_png(a.reference)
rw,rh,right=read_png(a.replay)
assert (w,h)==(rw,rh),f'image dimensions differ: {(w,h)} vs {(rw,rh)}'
total=0;maximum=0;maximum_rgb=0;maximum_alpha=0;changed=0;raw=bytearray();bounds=[w,h,-1,-1]
for y in range(h):
    raw.append(0)
    for x in range(w):
        errors=[abs(l-r) for l,r in zip(left(x,y),right(x,y))]
        total+=sum(errors);maximum=max(maximum,max(errors))
        maximum_rgb=max(maximum_rgb,max(errors[:3]));maximum_alpha=max(maximum_alpha,errors[3])
        if max(errors)>a.tolerance:
            changed+=1
            bounds=[min(bounds[0],x),min(bounds[1],y),max(bounds[2],x),max(bounds[3],y)]
        raw.extend(min(255,e*8) for e in errors[:3])
def chunk(kind,data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
encoded=b'\x89PNG\r\n\x1a\n'
encoded+=chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))
encoded+=chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
a.diff.write_bytes(encoded)
print(json.dumps({'reference':str(a.reference),'replay':str(a.replay),'width':w,'height':h,
    'tolerancePerChannel':a.tolerance,'maxChannelError':maximum,
    'maxRGBChannelError':maximum_rgb,'maxAlphaError':maximum_alpha,
    'meanAbsoluteRGBAError':total/(w*h*4),'pixelsOverTolerance':changed,
    'fractionOverTolerance':changed/(w*h),'differenceBoundsInclusive':bounds if changed else None,
    'diffGain':8,'comparison':'decoded RGB/RGBA values; not a perceptual or color-profile comparison'},indent=2))

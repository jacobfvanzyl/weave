"""Small RGB/RGBA PNG decoder for spike artifacts; no color-profile conversion."""
import struct
import zlib

def read_png(path):
    data=path.read_bytes(); assert data[:8]==b'\x89PNG\r\n\x1a\n'
    offset=8; compressed=b''
    while offset<len(data):
        n=struct.unpack('>I',data[offset:offset+4])[0]
        kind=data[offset+4:offset+8]; payload=data[offset+8:offset+8+n];offset+=n+12
        if kind==b'IHDR':w,h,depth,color,_,_,interlace=struct.unpack('>IIBBBBB',payload)
        if kind==b'IDAT':compressed+=payload
    assert depth==8 and color in (2,6) and interlace==0,(depth,color,interlace)
    bpp=4 if color==6 else 3; stride=w*bpp; raw=zlib.decompress(compressed);rows=[];prev=bytearray(stride)
    def paeth(a,b,c):
        p=a+b-c;pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
        return a if pa<=pb and pa<=pc else b if pb<=pc else c
    for y in range(h):
        base=y*(stride+1);f=raw[base];row=bytearray(raw[base+1:base+stride+1])
        for i in range(stride):
            a=row[i-bpp] if i>=bpp else 0;b=prev[i];c=prev[i-bpp] if i>=bpp else 0
            add=[0,a,b,(a+b)//2,paeth(a,b,c)][f]
            row[i]=(row[i]+add)%256
        rows.append(row);prev=row
    def pixel(x,y):
        p=tuple(rows[y][x*bpp:(x+1)*bpp]);return p if bpp==4 else p+(255,)
    return w,h,pixel

"""Verify continuing encoder output with Python's independent stock zlib decoder."""
import subprocess, struct, sys, zlib
raw=subprocess.check_output([sys.argv[1]])
at=0;count=0;decoded=0;compressed=0;stream=zlib.decompressobj()
while at<len(raw):
    size=struct.unpack_from('>I',raw,at)[0];at+=4
    expected=raw[at:at+size];at+=size
    size=struct.unpack_from('>I',raw,at)[0];at+=4
    encoded=raw[at:at+size];at+=size
    assert stream.decompress(encoded)==expected, f'Update {count} changed bytes'
    assert not stream.unused_data and not stream.unconsumed_tail
    decoded+=len(expected);compressed+=len(encoded);count+=1
assert at==len(raw) and count==80 and not stream.eof
print(f'Stock zlib {zlib.ZLIB_RUNTIME_VERSION}: {count} continuing updates, {decoded} exact bytes, {compressed} encoded bytes')

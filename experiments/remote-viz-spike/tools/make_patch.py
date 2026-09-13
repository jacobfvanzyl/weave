#!/usr/bin/env python3
"""Regenerate the diagnostic patch from exact pinned original display.cc."""
import difflib
import hashlib
import pathlib
import sys
root=pathlib.Path(__file__).resolve().parents[1]
original=pathlib.Path(sys.argv[1]).read_text()
expected='c187058eb0039135194c2576b7e7bd5a64b09db4f5c87be95e11f55b0731af3f'
assert hashlib.sha256(original.encode()).hexdigest()==expected,'display.cc is not the pinned original'
path='components/viz/service/display/display.cc'
modified=original.replace('#include "components/viz/service/display/display.h"','#include "components/viz/service/display/display.h"\n#include "components/viz/service/display/viz_remote_capture.h"',1).replace('  DebugDrawFrame(frame, resource_provider_);','  remote_capture_spike::Capture(frame, resource_provider_.get(), this,\n                                device_scale_factor_);\n  DebugDrawFrame(frame, resource_provider_);',1)
patch=''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
header=root/'server/chromium-patches/viz_remote_capture.h'
patch+=''.join(difflib.unified_diff([],header.read_text().splitlines(True),fromfile='/dev/null',tofile='b/components/viz/service/display/viz_remote_capture.h'))
(root/'server/chromium-patches/0001-capture-software-aggregated-frame.patch').write_text(patch)

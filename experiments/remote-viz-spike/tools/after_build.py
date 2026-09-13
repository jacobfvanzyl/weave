#!/usr/bin/env python3
"""Run the first owned-browser capture only after the owned build succeeds."""
import json
import os
import pathlib
import subprocess
import sys
import time

root=pathlib.Path(sys.argv[1]).resolve()
pid=int(sys.argv[2])
log=root/sys.argv[3]
while True:
    try:
        command=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
    except FileNotFoundError:
        break
    if b'headless_shell' not in command or b'autoninja' not in command:
        break
    time.sleep(5)
text=log.read_text()
if 'Build Succeeded:' not in text.split('build start:')[-1]:
    raise SystemExit('BUILD_NOT_SUCCESSFUL: capture was not started')
binary=root/'src/out/VizSpike/headless_shell'
assert binary.is_file()
capture=root/'captures/transforms-first'
capture.mkdir(parents=True,exist_ok=False)
env=dict(os.environ,CHROME_BINARY=str(binary),WEAVE_VIZ_CAPTURE_DIR=str(capture),
         CHROME_STDERR=str(root/'first-capture-chrome.log'),CAPTURE_ANIMATE='1')
bun='/tmp/wve79-spike-aZTsp6/bun-linux-x64/bun'
with (root/'first-capture-driver.json').open('w') as output:
    result=subprocess.run([bun,str(root/'tools/stock-layer-probe.ts')],env=env,stdout=output)
if result.returncode:
    raise SystemExit(f'CAPTURE_DRIVER_FAILED: {result.returncode}')
with (root/'first-capture-analysis.json').open('w') as output:
    result=subprocess.run([sys.executable,str(root/'tools/inspect_capture.py'),str(capture)],stdout=output)
if result.returncode:
    raise SystemExit(f'CAPTURE_VALIDATION_FAILED: {result.returncode}')
d=json.loads((root/'first-capture-analysis.json').read_text())
print(json.dumps({k:d[k] for k in ['actualChromiumCapture','frames','materials','resourcePayloadBytes','rasterBytesExamined','sameResourceTransformChanges']}),flush=True)

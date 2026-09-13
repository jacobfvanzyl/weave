#!/usr/bin/env python3
"""Run a spike-owned subprocess, preserving disk reserve and an explicit log."""
import argparse
import os
import pathlib
import shutil
import signal
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--cwd', required=True)
p.add_argument('--log', required=True)
p.add_argument('--reserve-gib', type=float, default=25)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
command = a.command[1:] if a.command[:1] == ['--'] else a.command
if not command:
    p.error('command required')
reserve = int(a.reserve_gib * 1024**3)
if shutil.disk_usage(a.cwd).free < reserve:
    raise SystemExit('DISK_RESERVE: refusing to start')
with pathlib.Path(a.log).open('a', buffering=1) as log:
    proc = subprocess.Popen(command, cwd=a.cwd, stdout=log,
                            stderr=subprocess.STDOUT, start_new_session=True)
    print(f'pid={proc.pid} log={a.log}', flush=True)
    try:
        while proc.poll() is None:
            if shutil.disk_usage(a.cwd).free < reserve:
                print('DISK_RESERVE: stopping only this subprocess group', flush=True)
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                raise SystemExit(75)
            time.sleep(2)
    except KeyboardInterrupt:
        os.killpg(proc.pid, signal.SIGTERM)
        raise
    print(f'exit={proc.returncode}', flush=True)
    raise SystemExit(proc.returncode)

#!/usr/bin/env python3
"""Measure local captured fixture directories; report unsupported states as results.

Usage: replay_corpus.py CAPTURE_ROOT REPORT.json
Each child capture directory may have a sibling NAME-reference.png. This is a
measurement runner, not an assertion that every fixture is supported.
"""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
base = pathlib.Path(sys.argv[1]).resolve()
results = {}
for capture in sorted(p for p in base.iterdir() if p.is_dir()):
    frames = sorted(capture.glob('*-frame-*.json'), key=lambda p:(p.name.split('-frame-')[0], int(p.stem.split('-frame-')[1])))
    if not frames:
        continue
    output = base / (capture.name + '-rendered')
    output.mkdir(exist_ok=True)
    for frame in frames:
        (output / frame.with_suffix('.png').name).unlink(missing_ok=True)
    result = subprocess.run([str(root / '.build/viz-replay'), str(output), *map(str, frames)], capture_output=True, text=True)
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    for row in rows:
        row['output'] = pathlib.Path(row['output']).name
    (base / (capture.name + '-replay.jsonl')).write_text(''.join(json.dumps(row)+'\n' for row in rows))
    analysis = json.loads(subprocess.run([sys.executable, str(root / 'tools/inspect_capture.py'), str(capture)], capture_output=True, text=True, check=True).stdout)
    summary = {key:analysis[key] for key in ['frames', 'materials', 'stateCounts', 'sameResourceTransformChanges', 'resourcePayloadBytes', 'rasterBytesExamined']}
    summary.update(replayExitCode=result.returncode, replayedFrames=len(rows), rejection=result.stderr.strip() or None)
    if rows:
        summary['nativeResourceUploadedBytes'] = sum(row['uploadedBytes'] for row in rows)
        summary['nativeMaskUploadedBytes'] = sum(row['maskUploadedBytes'] for row in rows)
        summary['peakCachedMaskBytes'] = max(row['cachedMaskBytes'] for row in rows)
        summary['filteredPassQuads'] = sum(row.get('filteredPassQuads', 0) for row in rows)
        summary['antialiasedPasses'] = sum(row.get('antialiasedPasses', 0) for row in rows)
    reference = base / (capture.name + '-reference.png')
    if result.returncode == 0 and reference.exists():
        comparison = subprocess.run([sys.executable, str(root / 'tools/compare_images.py'), str(reference), str(output / frames[-1].with_suffix('.png').name), '--diff', str(base / (capture.name + '-diff.png'))], capture_output=True, text=True, check=True)
        summary['comparison'] = json.loads(comparison.stdout)
        for field in ['reference', 'replay']:
            summary['comparison'][field] = pathlib.Path(summary['comparison'][field]).name
    results[capture.name] = summary
    print(capture.name, json.dumps(summary), flush=True)
pathlib.Path(sys.argv[2]).write_text(json.dumps(results, indent=2)+'\n')

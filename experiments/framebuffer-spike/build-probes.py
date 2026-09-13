"""Build diagnostic Mac probes using the mounted, pinned UTM release frameworks."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent
build = root / '.build'
headers = build / 'CocoaSpice-127033fa3e59cd49678f49ed54f8adfc060afb56/Sources/CocoaSpice/ExternalHeaders'
frameworks = Path('/tmp/wve79-utm-mount/UTM.app/Contents/Frameworks')
if not frameworks.is_dir():
    raise SystemExit('Mount the pinned UTM.dmg first; see README.md.')
common = ['xcrun', 'clang', '-g', '-Wno-deprecated-declarations']
common += ['-I' + str(headers / p) for p in ['', 'glib-2.0', 'spice-1', 'spice-client-glib-2.0']]
common += ['-F' + str(frameworks), '-Wl,-rpath,' + str(frameworks)]
for name, libraries in [('server', ['spice-server.1', 'glib-2.0.0']), ('client', ['spice-client-glib-2.0.8', 'glib-2.0.0', 'gobject-2.0.0'])]:
    args = common + ['-I' + str(build / 'spice-0.16.0/server')]
    for library in libraries:
        args += ['-framework', library]
    args += [str(root / (name + '.c')), '-o', str(build / (name + '-mac'))]
    subprocess.run(args, check=True)

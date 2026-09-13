from pathlib import Path
import subprocess,plistlib,shutil,time,json
r=Path(__file__).resolve().parent;b=r/'.build';base=r.parent/'rfb-spike/.build';cef=next(base.glob('cef_binary_*macosarm64_minimal'));app=b/'CEFFoundation.app';c=app/'Contents';t=time.monotonic()
if not app.exists():shutil.copytree(base/'CEFRFB.app',app,symlinks=True,copy_function=lambda src,dst: subprocess.run(['cp','-c',src,dst],check=True) and dst)
args=['xcrun','clang++','-O2','-std=c++20','-x','objective-c++','-fobjc-arc','-I'+str(cef),'-I'+str(base/'libvncserver-LibVNCServer-0.9.15/include'),'-I'+str(base/'lib-mac/include'),str(r/'cef-host.cc'),'-x','none',str(base/'cef-wrapper-mac/libcef_dll_wrapper/libcef_dll_wrapper.a'),str(base/'lib-mac/libvncserver.a'),'-lz','-framework','AppKit','-framework','Foundation','-o',str(c/'MacOS/CEFRFB')]
subprocess.run(args,check=True)
for executable in (c/'Frameworks').glob('CEFRFB Helper*.app/Contents/MacOS/*'):shutil.copy2(c/'MacOS/CEFRFB',executable)
subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict','--verbose=2',str(app)],check=True)
(r/'evidence/build-mac.json').write_text(json.dumps({'elapsedSeconds':time.monotonic()-t,'sandboxEnabledByDefault':True,'chromiumSourceBuild':False,'signature':'ad-hoc'},indent=2)+'\n')
print(app)

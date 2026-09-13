"""Build the small CEF adapter against pinned, prepared upstream dependencies.

No Chromium source build. --dependencies supplies a prepared cache containing
cef_binary_<pin>_<platform>_minimal, cef-wrapper-<platform>, lib-<platform>, and
libvncserver-LibVNCServer-0.9.15. The product cache is the default.
"""
from pathlib import Path
import argparse, subprocess, shutil, plistlib, sys, os
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--dependencies',type=Path,default=root/'native/.build/browser');p.add_argument('--output',type=Path,default=root/'dist/browser-runtime');a=p.parse_args()
mode='mac' if sys.platform=='darwin' else 'linux'
identity=os.environ.get('WEAVE_BROWSER_CODESIGN_IDENTITY')
if mode=='mac' and (not identity or identity=='-'):raise SystemExit('WEAVE_BROWSER_CODESIGN_IDENTITY must be a stable Apple signing identity for persistent macOS Profiles')
platform='macosarm64' if mode=='mac' else 'linux64'
cef=a.dependencies/f'cef_binary_152.0.6+g708dc14+chromium-152.0.7977.83_{platform}_minimal'
if not cef.is_dir():raise SystemExit(f'Prepared pinned CEF SDK missing: {cef}')
vnc=a.dependencies/'libvncserver-LibVNCServer-0.9.15';lib=a.dependencies/f'lib-{mode}';wrapper=a.dependencies/f'cef-wrapper-{mode}/libcef_dll_wrapper/libcef_dll_wrapper.a'
a.output.mkdir(parents=True,exist_ok=True)
args=['xcrun','clang++'] if mode=='mac' else ['c++']
args+=['-O2','-std=c++20']
if mode=='mac':args+=['-x','objective-c++','-fobjc-arc']
args+=['-I'+str(cef),'-I'+str(vnc/'include'),'-I'+str(lib/'include'),str(root/'native/browser/cef-host.cc')]
if mode=='mac':args+=['-x','none']
args+=[str(wrapper),str(lib/'libvncserver.a'),'-lz']
if mode=='mac':
 app=a.output/'Weave Browser.app';contents=app/'Contents';(contents/'MacOS').mkdir(parents=True,exist_ok=True);(contents/'Frameworks').mkdir(exist_ok=True)
 framework=contents/'Frameworks/Chromium Embedded Framework.framework'
 if not framework.exists():subprocess.run(['cp','-cR',str(cef/'Release/Chromium Embedded Framework.framework'),str(framework)],check=True)
 binary=contents/'MacOS/Weave Browser'
 args+=['-framework','AppKit','-framework','Foundation','-o',str(binary)]
 subprocess.run(args,check=True)
 base={'CFBundleExecutable':'Weave Browser','CFBundleIdentifier':'xyz.veezee.weave.browser','CFBundleName':'Weave Browser','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1','LSUIElement':True}
 (contents/'Info.plist').write_bytes(plistlib.dumps(base))
 for suffix in ['', ' (GPU)', ' (Renderer)', ' (Alerts)', ' (Plugin)']:
  name='Weave Browser Helper'+suffix;hc=contents/'Frameworks'/(name+'.app')/'Contents';(hc/'MacOS').mkdir(parents=True,exist_ok=True);shutil.copy2(binary,hc/'MacOS'/name)
  (hc/'Info.plist').write_bytes(plistlib.dumps(dict(base,CFBundleExecutable=name,CFBundleName=name,CFBundleIdentifier=base['CFBundleIdentifier']+'.helper'+suffix.replace(' ','').replace('(','').replace(')','').lower())))
 subprocess.run(['codesign','--force','--deep','--sign',identity,'--timestamp=none',str(app)],check=True)
 subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
else:
 binary=a.output/'weave-browser-runtime'
 args+=['-L'+str(cef/'Release'),'-lcef','-lpthread','-ldl','-Wl,-rpath,$ORIGIN','-o',str(binary)]
 subprocess.run(args,check=True)
 for source in [cef/'Release',cef/'Resources']:
  shutil.copytree(source,a.output,dirs_exist_ok=True,symlinks=True)
print(binary)

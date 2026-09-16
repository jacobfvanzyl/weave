"""Build the small CEF adapter against pinned, prepared upstream dependencies.

No Chromium source build. --dependencies supplies a prepared cache containing
cef_binary_<pin>_<platform>_minimal, cef-wrapper-<platform>, and
libvncserver-LibVNCServer-0.9.15. The product cache is the default.
"""
from pathlib import Path
import argparse, subprocess, shutil, plistlib, sys, os, runpy
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--dependencies',type=Path,default=root/'native/.build/browser');p.add_argument('--output',type=Path,default=root/'dist/browser-runtime');p.add_argument('--compression',choices=['system','zlib-ng'],default='zlib-ng');a=p.parse_args()
mode='mac' if sys.platform=='darwin' else 'linux'
identity=os.environ.get('WEAVE_BROWSER_CODESIGN_IDENTITY')
if mode=='mac' and (not identity or identity=='-'):raise SystemExit('WEAVE_BROWSER_CODESIGN_IDENTITY must be a stable Apple signing identity for persistent macOS Profiles')
platform='macosarm64' if mode=='mac' else 'linux64'
cef=a.dependencies/f'cef_binary_152.0.6+g708dc14+chromium-152.0.7977.83_{platform}_minimal'
if not cef.is_dir():raise SystemExit(f'Prepared pinned CEF SDK missing: {cef}')
vnc=a.dependencies/'libvncserver-LibVNCServer-0.9.15';lib=a.dependencies/f'lib-rfb-executor-{mode}-v1';wrapper=a.dependencies/f'cef-wrapper-{mode}/libcef_dll_wrapper/libcef_dll_wrapper.a'
zinclude=[];zlink=['-lz'];zoptions=[]
if a.compression=='zlib-ng':
 prefix,key=runpy.run_path(str(root/'scripts/build-rfb-compression.py'))['prepare'](a.dependencies,mode)
 lib=a.dependencies/f'lib-rfb-executor-{mode}-zlib-ng-{key}'
 zinclude=['-I'+str(prefix/'include')];zlink=[str(prefix/'lib/libz.a')]
 zoptions=['-DWITH_ZLIB=ON','-DZLIB_LIBRARY='+zlink[0],'-DZLIB_INCLUDE_DIR='+str(prefix/'include')]
# Separate stock build variant: all server APIs run on our one RFB executor.
# Do not reuse the client cache or enable LibVNC's internal threading here.
if not (lib/'libvncserver.a').exists():
 options=['cmake','-S',str(vnc),'-B',str(lib),'-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF']
 options += ['-DWITH_'+name+'=OFF' for name in ['THREADS','LZO','JPEG','PNG','SDL','GTK','LIBSSHTUNNEL','GNUTLS','OPENSSL','SYSTEMD','GCRYPT','FFMPEG','TIGHTVNC_FILETRANSFER','WEBSOCKETS','SASL','XCB','EXAMPLES','TESTS','QT']]
 if mode=='mac':
  sdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
  options += ['-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0','-DCMAKE_OSX_SYSROOT='+sdk]
  if not zoptions:zoptions=['-DZLIB_LIBRARY='+sdk+'/usr/lib/libz.tbd','-DZLIB_INCLUDE_DIR='+sdk+'/usr/include']
 options += zoptions
 subprocess.run(options,check=True)
 subprocess.run(['cmake','--build',str(lib),'--target','vncserver','-j','4'],check=True)
test=lib/'weave-rfb-display-test'
compiler=['xcrun','clang++'] if mode=='mac' else ['c++','-pthread']
subprocess.run(compiler+zinclude+['-O2','-std=c++20','-I'+str(lib/'include'),'-I'+str(vnc/'include'),str(root/'native/browser/rfb-display-test.cc'),str(lib/'libvncserver.a')]+zlink+['-o',str(test)],check=True)
subprocess.run([str(test)],check=True,timeout=10)
if a.compression=='zlib-ng':
 symbols=subprocess.check_output(['nm','-u',str(lib/'libvncserver.a')],text=True)
 if 'weave_rfb_deflate' not in symbols:raise RuntimeError('RFB did not bind the private compressor')
 compatibility=lib/'weave-rfb-compression-test'
 subprocess.run(compiler+zinclude+['-O2','-std=c++20',str(root/'native/browser/rfb-compression-test.cc')]+zlink+['-o',str(compatibility)],check=True)
 subprocess.run([sys.executable,str(root/'scripts/test-rfb-compression.py'),str(compatibility)],check=True,timeout=20)

a.output.mkdir(parents=True,exist_ok=True)
args=['xcrun','clang++'] if mode=='mac' else ['c++']
args+=['-O2','-std=c++20']
if mode=='mac':args+=['-x','objective-c++','-fobjc-arc']
args+=zinclude+['-I'+str(cef),'-I'+str(lib/'include'),'-I'+str(vnc/'include'),str(root/'native/browser/cef-host.cc')]
if mode=='mac':args+=['-x','none']
args+=[str(wrapper),str(lib/'libvncserver.a')]+zlink
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
if a.compression=='zlib-ng':
 shutil.copy2(a.dependencies/'zlib-ng-2.3.3/source/LICENSE.md',a.output/'zlib-ng-LICENSE.md')
print(binary)

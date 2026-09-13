from pathlib import Path
import subprocess,plistlib,shutil
r=Path(__file__).resolve().parent;b=r/'.build';cef=next(b.glob('cef_binary_*macosarm64_minimal'));app=b/'CEFRFB.app';c=app/'Contents';(c/'MacOS').mkdir(parents=True,exist_ok=True);(c/'Frameworks').mkdir(exist_ok=True)
fw=c/'Frameworks/Chromium Embedded Framework.framework'
if not fw.exists():shutil.copytree(cef/'Release/Chromium Embedded Framework.framework',fw,symlinks=True)
args=['xcrun','clang++','-std=c++20','-x','objective-c++','-fobjc-arc','-I'+str(cef),'-I'+str(b/'libvncserver-LibVNCServer-0.9.15/include'),'-I'+str(b/'lib-mac/include'),str(r/'cef-host.cc'),'-x','none',str(b/'cef-wrapper-mac/libcef_dll_wrapper/libcef_dll_wrapper.a'),str(b/'lib-mac/libvncserver.a'),'-lz','-framework','AppKit','-framework','Foundation','-o',str(c/'MacOS/CEFRFB')]
subprocess.run(args,check=True)
base={'CFBundleExecutable':'CEFRFB','CFBundleIdentifier':'com.veezee.cef-rfb-spike','CFBundleName':'CEFRFB','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1','LSUIElement':True}
(c/'Info.plist').write_bytes(plistlib.dumps(base))
for suffix in ['', ' (GPU)', ' (Renderer)', ' (Alerts)', ' (Plugin)']:
 name='CEFRFB Helper'+suffix;hc=c/'Frameworks'/(name+'.app')/'Contents';(hc/'MacOS').mkdir(parents=True,exist_ok=True);shutil.copy2(c/'MacOS/CEFRFB',hc/'MacOS'/name);(hc/'Info.plist').write_bytes(plistlib.dumps(dict(base,CFBundleExecutable=name,CFBundleName=name,CFBundleIdentifier='com.veezee.cef-rfb-spike.helper'+suffix.replace(' ','').replace('(','').replace(')','').lower())))
subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True)
print(app)

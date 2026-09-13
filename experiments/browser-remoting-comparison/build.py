from pathlib import Path
import subprocess,plistlib,shutil
r=Path(__file__).resolve().parent;b=r/'.build';rfb=r.parent/'rfb-spike/.build';rtc=r.parent/'browser-streaming/.build';b.mkdir(exist_ok=True)
def run(args):subprocess.run([str(a) for a in args],check=True)
for name in ['RFB','WebRTC']:
 c=b/(name+'Bench.app')/'Contents';(c/'MacOS').mkdir(parents=True,exist_ok=True)
 (c/'Info.plist').write_bytes(plistlib.dumps(dict(CFBundleExecutable=name+'Bench',CFBundleIdentifier='com.veezee.'+name.lower()+'-bench',CFBundleName=name+'Bench',CFBundlePackageType='APPL',CFBundleVersion='1',NSAppTransportSecurity={'NSAllowsArbitraryLoads':True})))
 if name=='RFB':
  run(['xcrun','clang','-O2','-fobjc-arc','-fmodules','-I'+str(rfb/'libvncserver-LibVNCServer-0.9.15/include'),'-I'+str(rfb/'lib-mac/include'),r/'RFBApp.m',rfb/'lib-mac/libvncclient.a','-lz','-framework','AppKit','-framework','QuartzCore','-framework','ImageIO','-o',c/'MacOS/RFBBench'])
 else:
  (c/'Frameworks').mkdir(exist_ok=True);fw=c/'Frameworks/LiveKitWebRTC.framework'
  if not fw.exists():shutil.copytree(rtc/'LiveKitWebRTC.xcframework/macos-arm64_x86_64/LiveKitWebRTC.framework',fw,symlinks=True)
  run(['xcrun','swiftc','-O','-swift-version','5','-parse-as-library','-F',c/'Frameworks','-framework','LiveKitWebRTC','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks',r/'Bench.swift',r/'BrowserMediaReceiver.swift',r/'WebRTCApp.swift','-o',c/'MacOS/WebRTCBench'])
 run(['codesign','--force','--deep','--sign','-',c.parent])
# Reuse the assembled CEF frameworks and helper layout; replace only our tiny adapter binaries.
app=b/'CEFBench.app';c=app/'Contents'
if not app.exists():shutil.copytree(rfb/'CEFRFB.app',app,symlinks=True,copy_function=lambda src,dst: subprocess.run(['cp','-c',src,dst],check=True) and dst)
cef=next(rfb.glob('cef_binary_*macosarm64_minimal'))
run(['xcrun','clang++','-O2','-std=c++20','-x','objective-c++','-fobjc-arc','-I'+str(cef),'-I'+str(rfb/'libvncserver-LibVNCServer-0.9.15/include'),'-I'+str(rfb/'lib-mac/include'),r/'cef-host.cc','-x','none',rfb/'cef-wrapper-mac/libcef_dll_wrapper/libcef_dll_wrapper.a',rfb/'lib-mac/libvncserver.a','-lz','-framework','AppKit','-framework','Foundation','-o',c/'MacOS/CEFRFB'])
for executable in (c/'Frameworks').glob('CEFRFB Helper*.app/Contents/MacOS/*'):shutil.copy2(c/'MacOS/CEFRFB',executable)
run(['codesign','--force','--deep','--sign','-',app])

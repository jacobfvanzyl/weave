"""Try the unmodified CocoaSpice sources against frameworks in UTM release apps.
This is a dependency-closure test, not an installed application build.
"""
from pathlib import Path
import json,subprocess,sys
root=Path(__file__).resolve().parent;b=root/'.build';c=b/'CocoaSpice-127033fa3e59cd49678f49ed54f8adfc060afb56';src=c/'Sources/CocoaSpice';h=src/'ExternalHeaders';rh=c/'Sources/CocoaSpiceRenderer/include'
mods=b/'modules';mods.mkdir(exist_ok=True)
(mods/'module.modulemap').write_text('module CocoaSpiceRenderer { umbrella "'+str(rh)+'" export * }\n')
main=b/'link-main.m';main.write_text('#import "CocoaSpice.h"\nint main(void) { @autoreleasepool { return [[CSMain sharedInstance] spiceStart] ? 0 : 1; } }\n')
results={}
for mode in ['mac','ios']:
 sdk='macosx' if mode=='mac' else 'iphoneos'; sdkpath=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
 fw=Path('/tmp/wve79-utm-mount/UTM.app/Contents/Frameworks') if mode=='mac' else b/'utm-ios/Payload/UTM Remote.app/Frameworks'
 sources=sorted(p for p in src.glob('*.m') if not p.name.startswith('CSUSB'))+[c/'Sources/CocoaSpiceRenderer/CSMetalRenderer.m',main]
 args=['xcrun','--sdk',sdk,'clang','-isysroot',sdkpath,'-target','arm64-apple-macos14.0' if mode=='mac' else 'arm64-apple-ios17.0','-fobjc-arc','-fmodules','-fmodules-cache-path='+str(b/('module-cache-'+mode))]
 args+=['-I'+str(p) for p in [mods,src/'include',rh,h,h/'glib-2.0',h/'gstreamer-1.0',h/'spice-1',h/'spice-client-glib-2.0']]
 args+=['-F'+str(fw),'-Wl,-rpath,'+str(fw)]
 for name in ['Foundation','Metal','MetalKit','CoreGraphics','CoreImage','IOSurface','AudioToolbox','AVFoundation', 'AppKit' if mode=='mac' else 'UIKit','spice-client-glib-2.0.8','glib-2.0.0','gobject-2.0.0','gio-2.0.0','gstreamer-1.0.0','gstapp-1.0.0','gstvideo-1.0.0']:
  args+=['-framework',name]
 args += [str(p) for p in sources]+['-o',str(b/('cocoa-link-'+mode))]
 r=subprocess.run(args,text=True,capture_output=True)
 (root/'evidence'/('apple-link-'+mode+'.log')).write_text(r.stdout+r.stderr)
 results[mode]={'exit':r.returncode,'log':'apple-link-'+mode+'.log'}
 print(mode,r.returncode,r.stderr[-4000:],flush=True)
(root/'evidence/apple-link-results.json').write_text(json.dumps(results,indent=2)+'\n')

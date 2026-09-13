"""Build pinned upstream LibVNC with Apple SDK zlib and no optional media/UI stacks."""
from pathlib import Path
import subprocess,json,time
root=Path(__file__).resolve().parent;b=root/'.build';src=b/'libvncserver-LibVNCServer-0.9.15'
results={}
for mode in ['mac','ios']:
 out=b/('lib-'+mode);sdk=subprocess.check_output(['xcrun','--sdk','macosx' if mode=='mac' else 'iphoneos','--show-sdk-path'],text=True).strip()
 args=['cmake','-S',str(src),'-B',str(out),'-DCMAKE_POLICY_VERSION_MINIMUM=3.5','-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF','-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_SYSROOT='+sdk,'-DZLIB_LIBRARY='+sdk+'/usr/lib/libz.tbd','-DZLIB_INCLUDE_DIR='+sdk+'/usr/include']
 args+=['-DWITH_'+name+'=OFF' for name in ['LZO','JPEG','PNG','SDL','GTK','LIBSSHTUNNEL','GNUTLS','OPENSSL','SYSTEMD','GCRYPT','FFMPEG','TIGHTVNC_FILETRANSFER','WEBSOCKETS','SASL','XCB','EXAMPLES','TESTS','QT']]
 if mode=='ios':args+=['-DCMAKE_SYSTEM_NAME=iOS','-DCMAKE_OSX_DEPLOYMENT_TARGET=17.0','-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY']
 else:args+=['-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0']
 start=time.monotonic()
 with (root/'evidence'/('build-'+mode+'.log')).open('w') as log:
  subprocess.run(args,check=True,stdout=log,stderr=subprocess.STDOUT)
  subprocess.run(['cmake','--build',str(out),'-j','4'],check=True,stdout=log,stderr=subprocess.STDOUT)
 results[mode]={'seconds':round(time.monotonic()-start,2),'clientBytes':(out/'libvncclient.a').stat().st_size,'serverBytes':(out/'libvncserver.a').stat().st_size}
 print(mode,results[mode],flush=True)
(root/'evidence/library-build.json').write_text(json.dumps(results,indent=2)+'\n')

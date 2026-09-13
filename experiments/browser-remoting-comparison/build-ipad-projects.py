"""Derive isolated measurement projects from the already prepared native spikes."""
from pathlib import Path
import plistlib
r=Path(__file__).resolve().parent;b=r/'.build';rfb=r.parent/'rfb-spike/.build';rtc=r.parent/'browser-streaming/.build'
(b/'ipad-resources').mkdir(parents=True,exist_ok=True)
for name,original in [('RFB',rfb/'RFBSpike.xcodeproj/project.pbxproj'),('WebRTC',rtc/'BrowserSpike.xcodeproj/project.pbxproj')]:
 data=plistlib.loads(original.read_bytes());o=data['objects']
 for v in o.values():
  path=v.get('path','')
  if path.endswith('NativeApp.m'):v['path']=str(r/'RFBApp.m')
  if path.endswith('BrowserMediaReceiver.swift'):v['path']=str(r/'BrowserMediaReceiver.swift')
  if path.endswith('SpikeApp.swift'):v['path']=str(r/'WebRTCApp.swift')
  if v['isa']=='XCBuildConfiguration' and 'PRODUCT_NAME' in v['buildSettings']:
   settings=v['buildSettings'];settings['INFOPLIST_FILE']=str(b/(name+'-ios.plist'));settings['SWIFT_OPTIMIZATION_LEVEL']='-O';settings['GCC_OPTIMIZATION_LEVEL']='2'
   if name=='RFB':settings['OTHER_LDFLAGS']+=['-framework','ImageIO']
 if name=='WebRTC':
  o['BENCHSRC']={'isa':'PBXFileReference','lastKnownFileType':'sourcecode.swift','path':str(r/'Bench.swift'),'sourceTree':'<absolute>'}
  o['BENCHCOMPILE']={'isa':'PBXBuildFile','fileRef':'BENCHSRC'}
  o['SOURCES']['files'].append('BENCHCOMPILE');o['GROUP']['children'].append('BENCHSRC');o['CONFIG']['path']=str(b/'ipad-resources/connection.json')
 info=plistlib.loads((rfb/'Info.plist' if name=='RFB' else rtc/'Info.plist').read_bytes());info['CFBundleDisplayName']=name+' Benchmark';(b/(name+'-ios.plist')).write_bytes(plistlib.dumps(info))
 proj=b/(name+'Bench.xcodeproj');proj.mkdir(exist_ok=True);(proj/'project.pbxproj').write_bytes(plistlib.dumps(data))
print('Prepared isolated iPad projects; run.py builds, installs and launches per run.')

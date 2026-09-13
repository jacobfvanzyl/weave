from pathlib import Path
import subprocess,plistlib,json
r=Path(__file__).resolve().parent;b=r/'.build';src=b/'libvncserver-LibVNCServer-0.9.15'
info={'CFBundleExecutable':'RFBSpike','CFBundleIdentifier':'com.veezee.rfb-spike','CFBundleName':'RFBSpike','CFBundleDisplayName':'RFB Spike','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1','CFBundleVersion':'1','NSLocalNetworkUsageDescription':'Connect to the synthetic framebuffer spike on your Host.','UILaunchScreen':{},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight']}
ios_info=dict(info,CFBundleIdentifier='com.veezee.browser-spike')
(b/'Info.plist').write_bytes(plistlib.dumps(ios_info))
app=b/'RFBSpike.app';c=app/'Contents';(c/'MacOS').mkdir(parents=True,exist_ok=True);(c/'Info.plist').write_bytes(plistlib.dumps(info))
args=['xcrun','clang','-fobjc-arc','-fmodules','-Wno-incompatible-pointer-types','-I'+str(src/'include'),'-I'+str(b/'lib-mac/include'),str(r/'NativeApp.m'),str(b/'lib-mac/libvncclient.a'),'-lz','-framework','AppKit','-framework','QuartzCore','-o',str(c/'MacOS/RFBSpike')]
subprocess.run(args,check=True);subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
# Reuse the isolated project layout from the WebRTC harness, replacing source and dependencies.
objects={}
def add(key,isa,**kw):objects[key]={'isa':isa,**kw};return key
source=add('SRC','PBXFileReference',lastKnownFileType='sourcecode.c.objc',path=str(r/'NativeApp.m'),sourceTree='<absolute>')
lib=add('LIB','PBXFileReference',lastKnownFileType='archive.ar',path=str(b/'lib-ios/libvncclient.a'),sourceTree='<absolute>')
product=add('APP','PBXFileReference',explicitFileType='wrapper.application',path='RFBSpike.app',sourceTree='BUILT_PRODUCTS_DIR')
group=add('GROUP','PBXGroup',children=[source,lib,product],sourceTree='<group>')
sources=add('SOURCES','PBXSourcesBuildPhase',buildActionMask=2147483647,files=[add('COMPILE','PBXBuildFile',fileRef=source)],runOnlyForDeploymentPostprocessing=0)
link=add('LINK','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[add('LINKLIB','PBXBuildFile',fileRef=lib)],runOnlyForDeploymentPostprocessing=0)
settings={'PRODUCT_NAME':'RFBSpike','PRODUCT_BUNDLE_IDENTIFIER':'com.veezee.browser-spike','DEVELOPMENT_TEAM':'942HB89NL5','CODE_SIGN_STYLE':'Automatic','SDKROOT':'iphoneos','SUPPORTED_PLATFORMS':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'17.0','TARGETED_DEVICE_FAMILY':'2','INFOPLIST_FILE':str(b/'Info.plist'),'CLANG_ENABLE_OBJC_ARC':'YES','CLANG_ENABLE_MODULES':'YES','LIBRARY_SEARCH_PATHS':[str(b/'lib-ios')],'HEADER_SEARCH_PATHS':[str(src/'include'),str(b/'lib-ios/include')],'OTHER_LDFLAGS':['-lz','-framework','UIKit','-framework','QuartzCore'],'DEBUG_INFORMATION_FORMAT':'dwarf','GCC_OPTIMIZATION_LEVEL':'2'}
conf=add('DEBUG','XCBuildConfiguration',name='Debug',buildSettings=settings);cl=add('CL','XCConfigurationList',buildConfigurations=[conf],defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
pc=add('PC','XCBuildConfiguration',name='Debug',buildSettings={});pcl=add('PCL','XCConfigurationList',buildConfigurations=[pc],defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
target=add('TARGET','PBXNativeTarget',name='RFBSpike',productName='RFBSpike',productType='com.apple.product-type.application',productReference=product,buildConfigurationList=cl,buildPhases=[sources,link],buildRules=[],dependencies=[])
proj=add('PROJECT','PBXProject',attributes={'LastUpgradeCheck':'2600'},buildConfigurationList=pcl,compatibilityVersion='Xcode 14.0',developmentRegion='en',knownRegions=['en','Base'],mainGroup=group,projectDirPath='',projectRoot='',targets=[target])
p=b/'RFBSpike.xcodeproj';p.mkdir(exist_ok=True);(p/'project.pbxproj').write_bytes(plistlib.dumps({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':proj}))
with (r/'evidence/build-native-ios.log').open('w') as log:subprocess.run(['xcodebuild','-project',str(p),'-scheme','RFBSpike','-configuration','Debug','-destination','generic/platform=iOS','-derivedDataPath',str(b/'ipad'),'-allowProvisioningUpdates','build'],stdout=log,stderr=subprocess.STDOUT,check=True)
print('Mac and iOS native apps built.')

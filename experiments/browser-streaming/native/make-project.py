"""Generate an isolated iPad harness project under .build; never alter Alpha's project."""
import json, pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
build = root / '.build'
project = build / 'BrowserSpike.xcodeproj'
project.mkdir(exist_ok=True)
objects = {}
def add(key, kind, **values):
    objects[key] = {'isa': kind, **values}
    return key
sources = []
children = []
for i, name in enumerate(['BrowserMediaReceiver.swift', 'SpikeApp.swift']):
    ref = add('SOURCE'+str(i), 'PBXFileReference', lastKnownFileType='sourcecode.swift', path=str(root/'native'/name), sourceTree='<absolute>')
    children.append(ref)
    sources.append(add('COMPILE'+str(i), 'PBXBuildFile', fileRef=ref))
framework = add('FRAMEWORK', 'PBXFileReference', lastKnownFileType='wrapper.xcframework', path=str(build/'LiveKitWebRTC.xcframework'), sourceTree='<absolute>')
resource = add('CONFIG', 'PBXFileReference', lastKnownFileType='text.json', path=str(build/'receiver/connection.json'), sourceTree='<absolute>')
product = add('APP', 'PBXFileReference', explicitFileType='wrapper.application', path='BrowserSpike.app', sourceTree='BUILT_PRODUCTS_DIR')
group = add('GROUP', 'PBXGroup', children=children+[framework, resource, product], sourceTree='<group>')
sourcephase = add('SOURCES', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=sources, runOnlyForDeploymentPostprocessing=0)
linkphase = add('LINK', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[add('LINKFILE','PBXBuildFile',fileRef=framework)], runOnlyForDeploymentPostprocessing=0)
embedphase = add('EMBED', 'PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='', dstSubfolderSpec=10, files=[add('EMBEDFILE','PBXBuildFile',fileRef=framework,settings={'ATTRIBUTES':['CodeSignOnCopy','RemoveHeadersOnCopy']})], runOnlyForDeploymentPostprocessing=0)
resphase = add('RESOURCES', 'PBXResourcesBuildPhase', buildActionMask=2147483647, files=[add('RESOURCEFILE','PBXBuildFile',fileRef=resource)], runOnlyForDeploymentPostprocessing=0)
settings = {'PRODUCT_NAME':'BrowserSpike','PRODUCT_BUNDLE_IDENTIFIER':'com.veezee.browser-spike','DEVELOPMENT_TEAM':'942HB89NL5','CODE_SIGN_STYLE':'Automatic','SDKROOT':'iphoneos','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','IPHONEOS_DEPLOYMENT_TARGET':'16.0','SWIFT_VERSION':'5.0','TARGETED_DEVICE_FAMILY':'2','INFOPLIST_FILE':str(build/'Info.plist'),'LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks'],'ENABLE_USER_SCRIPT_SANDBOXING':'YES','DEBUG_INFORMATION_FORMAT':'dwarf','SWIFT_OPTIMIZATION_LEVEL':'-Onone','CLANG_ENABLE_MODULES':'YES'}
config = add('DEBUG','XCBuildConfiguration',name='Debug',buildSettings=settings)
configlist = add('CONFIGLIST','XCConfigurationList',buildConfigurations=[config],defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
projconfig = add('PROJECTDEBUG','XCBuildConfiguration',name='Debug',buildSettings={})
projlist = add('PROJECTCONFIG','XCConfigurationList',buildConfigurations=[projconfig],defaultConfigurationIsVisible=0,defaultConfigurationName='Debug')
target = add('TARGET','PBXNativeTarget',name='BrowserSpike',productName='BrowserSpike',productType='com.apple.product-type.application',productReference=product,buildConfigurationList=configlist,buildPhases=[sourcephase,linkphase,embedphase,resphase],buildRules=[],dependencies=[])
proj = add('PROJECT','PBXProject',attributes={'LastUpgradeCheck':'2600'},buildConfigurationList=projlist,compatibilityVersion='Xcode 14.0',developmentRegion='en',knownRegions=['en','Base'],mainGroup=group,projectDirPath='',projectRoot='',targets=[target])
(project/'project.pbxproj').write_bytes(plistlib.dumps({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':proj}))

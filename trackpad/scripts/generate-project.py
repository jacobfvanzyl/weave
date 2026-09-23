#!/usr/bin/env python3
"""Generate the two native targets without a global project-generator dependency."""
from pathlib import Path
import hashlib
import plistlib

root = Path(__file__).resolve().parents[1]
objects = {}

def oid(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()

def add(identity, isa, **fields):
    key = oid(identity)
    objects[key] = {"isa": isa, **fields}
    return key

package = add("core-package", "XCLocalSwiftPackageReference", relativePath="packages/TrackpadCore")
products = []
groups = []
targets = []
project_settings = {
    "SWIFT_VERSION": "6.0", "CLANG_ENABLE_MODULES": "YES",
    "SWIFT_STRICT_CONCURRENCY": "complete", "CODE_SIGN_STYLE": "Automatic",
    "ENABLE_USER_SCRIPT_SANDBOXING": "YES", "GCC_WARN_UNUSED_VARIABLE": "YES",
    "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES",
}

def configs(name, settings):
    ids = []
    for configuration in ["Debug", "Release"]:
        build = settings | {"SWIFT_OPTIMIZATION_LEVEL": "-Onone" if configuration == "Debug" else "-O",
                            "DEBUG_INFORMATION_FORMAT": "dwarf" if configuration == "Debug" else "dwarf-with-dsym"}
        if configuration == "Debug":
            build["ONLY_ACTIVE_ARCH"] = "YES"
            build["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG $(inherited)"
        ids.append(add(name + configuration, "XCBuildConfiguration", name=configuration, buildSettings=build))
    return add(name + "configs", "XCConfigurationList", buildConfigurations=ids,
               defaultConfigurationIsVisible="0", defaultConfigurationName="Release")

for platform, name, bundle in [("ios", "TrackpadMobile", "com.veezee.trackpad"), ("macos", "TrackpadMac", "com.veezee.trackpad.mac")]:
    files = sorted((root / "apps" / platform).glob("*.swift")) + sorted((root / "apps/shared").glob("*.swift"))
    refs, builds = [], []
    for source in files:
        path = str(source.relative_to(root))
        ref = add(f"{platform}:{path}:ref", "PBXFileReference", lastKnownFileType="sourcecode.swift", path=path, sourceTree="<group>")
        refs.append(ref)
        builds.append(add(f"{platform}:{path}:build", "PBXBuildFile", fileRef=ref))
    groups.append(add(name + "group", "PBXGroup", name=name, children=refs, sourceTree="<group>"))
    product = add(name + "product", "PBXFileReference", explicitFileType="wrapper.application", path=name + ".app", sourceTree="BUILT_PRODUCTS_DIR", includeInIndex="0")
    products.append(product)
    dependency = add(name + "core", "XCSwiftPackageProductDependency", package=package, productName="TrackpadCore")
    framework_build = add(name + "core-build", "PBXBuildFile", productRef=dependency)
    phases = [add(name + "sources", "PBXSourcesBuildPhase", buildActionMask="2147483647", files=builds, runOnlyForDeploymentPostprocessing="0"),
              add(name + "frameworks", "PBXFrameworksBuildPhase", buildActionMask="2147483647", files=[framework_build], runOnlyForDeploymentPostprocessing="0"),
              add(name + "resources", "PBXResourcesBuildPhase", buildActionMask="2147483647", files=[], runOnlyForDeploymentPostprocessing="0")]
    settings = {"PRODUCT_BUNDLE_IDENTIFIER": bundle, "PRODUCT_NAME": "$(TARGET_NAME)",
                "INFOPLIST_FILE": f"apps/{platform}/Info.plist", "CURRENT_PROJECT_VERSION": "1", "MARKETING_VERSION": "0.1.0",
                "GENERATE_INFOPLIST_FILE": "NO", "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"]}
    if platform == "ios":
        settings |= {"SDKROOT": "iphoneos", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator", "TARGETED_DEVICE_FAMILY": "1,2",
                     "IPHONEOS_DEPLOYMENT_TARGET": "18.0", "SUPPORTS_MACCATALYST": "NO", "SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD": "NO"}
    else:
        settings |= {"SDKROOT": "macosx", "MACOSX_DEPLOYMENT_TARGET": "15.0", "ENABLE_APP_SANDBOX": "NO",
                     "ENABLE_HARDENED_RUNTIME": "YES", "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/../Frameworks"]}
    targets.append(add(name, "PBXNativeTarget", name=name, productName=name, productReference=product,
                       productType="com.apple.product-type.application", buildConfigurationList=configs(name, settings),
                       buildPhases=phases, buildRules=[], dependencies=[], packageProductDependencies=[dependency]))

product_group = add("products", "PBXGroup", name="Products", children=products, sourceTree="<group>")
main_group = add("main", "PBXGroup", children=groups + [product_group], sourceTree="<group>")
project = add("project", "PBXProject", attributes={"LastUpgradeCheck": "2600", "BuildIndependentTargetsInParallel": "YES"},
              buildConfigurationList=configs("project", project_settings), compatibilityVersion="Xcode 14.0", developmentRegion="en",
              hasScannedForEncodings="0", knownRegions=["en", "Base"], mainGroup=main_group, productRefGroup=product_group,
              projectDirPath="", projectRoot="", targets=targets, packageReferences=[package])
output = root / "Trackpad.xcodeproj"
output.mkdir(exist_ok=True)
(output / "project.pbxproj").write_bytes(plistlib.dumps({"archiveVersion": "1", "classes": {}, "objectVersion": "56", "objects": objects, "rootObject": project}, sort_keys=False))
for name in ["TrackpadMobile", "TrackpadMac"]:
    scheme = output / "xcshareddata/xcschemes" / f"{name}.xcscheme"
    scheme.parent.mkdir(parents=True, exist_ok=True)
    reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{oid(name)}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:Trackpad.xcodeproj"/>'
    scheme.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"/>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
print(output)

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>

#include <rtc/rtc.hpp>
#include <rtc/av1rtppacketizer.hpp>
#include <rtc/h265rtppacketizer.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <arpa/inet.h>

using Clock = std::chrono::steady_clock;

static std::mutex gOutputMutex;
static constexpr double IdleRepeatIntervalSeconds = 0.5;
static constexpr double IdleRepeatAfterSeconds = 0.45;
static constexpr int32_t MediaTimeScale = 90000;

static NSString *StringFromStd(const std::string &value) {
    return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding] ?: @"";
}

static std::string StdFromString(NSString *value) {
    if (!value) return "";
    const char *utf8 = [value UTF8String];
    return utf8 ? std::string(utf8) : std::string();
}

static NSString *OptionalString(id value) {
    if (![value isKindOfClass:[NSString class]]) return nil;
    NSString *trimmed = [(NSString *)value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed.length > 0 ? trimmed : nil;
}

static NSInteger OptionalInteger(id value, NSInteger fallback) {
    if ([value isKindOfClass:[NSNumber class]]) return [(NSNumber *)value integerValue];
    if ([value isKindOfClass:[NSString class]]) {
        NSString *trimmed = OptionalString(value);
        if (trimmed) return trimmed.integerValue;
    }
    return fallback;
}

static double OptionalDouble(id value, double fallback) {
    if ([value isKindOfClass:[NSNumber class]]) return [(NSNumber *)value doubleValue];
    if ([value isKindOfClass:[NSString class]]) {
        NSString *trimmed = OptionalString(value);
        if (trimmed) return trimmed.doubleValue;
    }
    return fallback;
}

static BOOL OptionalBool(id value, BOOL fallback) {
    if ([value isKindOfClass:[NSNumber class]]) return [(NSNumber *)value boolValue];
    if ([value isKindOfClass:[NSString class]]) {
        NSString *trimmed = [OptionalString(value) lowercaseString];
        if (!trimmed) return fallback;
        if ([trimmed isEqualToString:@"true"] || [trimmed isEqualToString:@"1"] ||
            [trimmed isEqualToString:@"yes"] || [trimmed isEqualToString:@"on"]) return YES;
        if ([trimmed isEqualToString:@"false"] || [trimmed isEqualToString:@"0"] ||
            [trimmed isEqualToString:@"no"] || [trimmed isEqualToString:@"off"]) return NO;
    }
    return fallback;
}

static NSDictionary *OptionalDictionary(id value) {
    return [value isKindOfClass:[NSDictionary class]] ? (NSDictionary *)value : nil;
}

static NSArray *OptionalArray(id value) {
    return [value isKindOfClass:[NSArray class]] ? (NSArray *)value : nil;
}

static void WriteJsonLine(NSDictionary *object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (!data) {
        std::lock_guard<std::mutex> lock(gOutputMutex);
        std::cerr << "[window-stream-native] failed to serialize json: "
                  << StdFromString(error.localizedDescription ?: @"unknown error") << std::endl;
        return;
    }

    std::lock_guard<std::mutex> lock(gOutputMutex);
    std::cout.write(reinterpret_cast<const char *>(data.bytes), static_cast<std::streamsize>(data.length));
    std::cout << "\n";
    std::cout.flush();
}

static void WriteDiagnostic(NSString *message) {
    std::lock_guard<std::mutex> lock(gOutputMutex);
    std::cerr << "[window-stream-native] " << StdFromString(message) << std::endl;
}

static NSString *NSErrorMessage(NSError *error) {
    if (!error) return @"Unknown error.";
    NSString *domain = error.domain ?: @"";
    if ([domain containsString:@"ScreenCapture"] || [domain containsString:@"SCStream"]) {
        return [NSString stringWithFormat:@"%@ Enable Screen Recording permission for the app that launched Portal, then restart Portal.", error.localizedDescription];
    }
    return error.localizedDescription ?: @"Unknown error.";
}

static NSString *ExceptionMessage(const std::exception &error) {
    return StringFromStd(error.what());
}

static NSString *NormalizeSdp(NSString *sdp) {
    NSString *normalized = [[sdp stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"]
        stringByReplacingOccurrencesOfString:@"\r" withString:@"\n"];
    NSArray<NSString *> *parts = [normalized componentsSeparatedByString:@"\n"];
    NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithCapacity:parts.count];
    for (NSString *line in parts) {
        if (line.length > 0) [lines addObject:line];
    }
    return [[lines componentsJoinedByString:@"\r\n"] stringByAppendingString:@"\r\n"];
}

static NSString *WindowIdString(SCWindow *window) {
    return [NSString stringWithFormat:@"sck:%u", window.windowID];
}

static std::optional<CGWindowID> ParseWindowId(NSString *value) {
    NSString *trimmed = OptionalString(value);
    if (!trimmed) return std::nullopt;
    NSString *raw = [trimmed hasPrefix:@"sck:"] ? [trimmed substringFromIndex:4] : trimmed;
    NSScanner *scanner = [NSScanner scannerWithString:raw];
    unsigned long long result = 0;
    if (![scanner scanUnsignedLongLong:&result]) return std::nullopt;
    return static_cast<CGWindowID>(result);
}

static BOOL IsUsefulWindow(SCWindow *window) {
    if (!window.onScreen || window.windowLayer != 0) return NO;
    if (window.frame.size.width < 80 || window.frame.size.height < 60) return NO;
    return OptionalString(window.title) != nil;
}

static NSDictionary *JsonWindow(SCWindow *window) {
    NSMutableDictionary *output = [NSMutableDictionary dictionary];
    output[@"id"] = WindowIdString(window);
    output[@"title"] = window.title ?: @"";
    output[@"x"] = @(window.frame.origin.x);
    output[@"y"] = @(window.frame.origin.y);
    output[@"width"] = @(window.frame.size.width);
    output[@"height"] = @(window.frame.size.height);

    SCRunningApplication *app = window.owningApplication;
    if (app) {
        output[@"appName"] = app.applicationName ?: @"";
        output[@"pid"] = @(app.processID);
        if (app.bundleIdentifier) output[@"bundleIdentifier"] = app.bundleIdentifier;
    }
    return output;
}

static SCShareableContent *ShareableContentSync(NSError **outError) {
    __block SCShareableContent *result = nil;
    __block NSError *blockError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                               onScreenWindowsOnly:YES
                                                 completionHandler:^(SCShareableContent *content, NSError *error) {
        result = content;
        blockError = error;
        dispatch_semaphore_signal(semaphore);
    }];

    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:1
                                        userInfo:@{NSLocalizedDescriptionKey: @"Timed out while requesting ScreenCaptureKit shareable content."}];
        }
        return nil;
    }

    if (blockError && outError) *outError = blockError;
    return result;
}

static NSArray<NSDictionary *> *ListWindowsSync(NSError **outError) {
    SCShareableContent *content = ShareableContentSync(outError);
    if (!content) return nil;

    NSMutableArray<NSDictionary *> *windows = [NSMutableArray array];
    for (SCWindow *window in content.windows) {
        if (IsUsefulWindow(window)) [windows addObject:JsonWindow(window)];
    }
    return windows;
}

static SCWindow *FindWindowSync(NSString *windowId, NSError **outError) {
    auto parsed = ParseWindowId(windowId);
    if (!parsed.has_value()) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:2
                                        userInfo:@{NSLocalizedDescriptionKey: @"session.start requires a ScreenCaptureKit windowId."}];
        }
        return nil;
    }

    SCShareableContent *content = ShareableContentSync(outError);
    if (!content) return nil;
    for (SCWindow *window in content.windows) {
        if (window.windowID == parsed.value()) return window;
    }

    if (outError) {
        *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                        code:3
                                    userInfo:@{NSLocalizedDescriptionKey: @"Selected window is no longer capturable."}];
    }
    return nil;
}

static CGSize ScaledOutputSize(SCContentFilter *filter, SCWindow *window, NSInteger maxDimension) {
    CGRect contentRect = filter.contentRect;
    CGFloat scale = filter.pointPixelScale > 0 ? filter.pointPixelScale : 2.0;
    CGFloat fallbackWidth = std::max<CGFloat>(1, window.frame.size.width);
    CGFloat fallbackHeight = std::max<CGFloat>(1, window.frame.size.height);
    CGFloat sourceWidth = contentRect.size.width > 0 ? contentRect.size.width * scale : fallbackWidth * 2;
    CGFloat sourceHeight = contentRect.size.height > 0 ? contentRect.size.height * scale : fallbackHeight * 2;
    CGFloat limitScale = std::min<CGFloat>(1, static_cast<CGFloat>(maxDimension) / std::max(sourceWidth, sourceHeight));
    NSInteger width = std::max<NSInteger>(2, lround(sourceWidth * limitScale));
    NSInteger height = std::max<NSInteger>(2, lround(sourceHeight * limitScale));
    if (width % 2 != 0) width += 1;
    if (height % 2 != 0) height += 1;
    return CGSizeMake(width, height);
}

static BOOL IsCompleteFrame(CMSampleBufferRef sampleBuffer) {
    CFArrayRef attachmentsRef = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (!attachmentsRef || CFArrayGetCount(attachmentsRef) == 0) return YES;
    NSDictionary *attachments = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachmentsRef, 0);
    NSNumber *status = attachments[SCStreamFrameInfoStatus];
    if (!status) return YES;
    return status.integerValue == SCFrameStatusComplete;
}

static BOOL IsKeyframe(CMSampleBufferRef sampleBuffer) {
    CFArrayRef attachmentsRef = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (!attachmentsRef || CFArrayGetCount(attachmentsRef) == 0) return YES;
    NSDictionary *attachments = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachmentsRef, 0);
    NSNumber *notSync = attachments[(__bridge NSString *)kCMSampleAttachmentKey_NotSync];
    return !notSync.boolValue;
}

static void AppendLengthPrefixedNal(NSMutableData *data, const uint8_t *bytes, size_t length) {
    uint32_t bigEndianLength = htonl(static_cast<uint32_t>(length));
    [data appendBytes:&bigEndianLength length:sizeof(bigEndianLength)];
    [data appendBytes:bytes length:length];
}

static NSString *NormalizeCodecName(id value) {
    NSString *codec = [(OptionalString(value) ?: @"hevc") lowercaseString];
    if ([codec isEqualToString:@"h265"]) return @"hevc";
    if ([codec isEqualToString:@"hevc"] || [codec isEqualToString:@"av1"]) return codec;
    return @"h264";
}

static NSString *NormalizeColorMode(id value) {
    NSString *mode = [(OptionalString(value) ?: @"srgb-video-range") lowercaseString];
    if ([mode isEqualToString:@"srgb-full-range"] ||
        [mode isEqualToString:@"srgb-video-range"] ||
        [mode isEqualToString:@"rec709-full-range"] ||
        [mode isEqualToString:@"rec709-video-range"]) return mode;
    return @"srgb-video-range";
}

static NSString *NormalizeControlDelivery(id value) {
    NSString *delivery = [(OptionalString(value) ?: @"focus-hid") lowercaseString];
    if ([delivery isEqualToString:@"focus-hid"] ||
        [delivery isEqualToString:@"pid-only"] ||
        [delivery isEqualToString:@"pid-then-hid"] ||
        [delivery isEqualToString:@"hid-only"]) return delivery;
    return @"focus-hid";
}

static OSType PixelFormatForColorMode(NSString *colorMode) {
    if ([colorMode hasSuffix:@"video-range"]) {
        return kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    }
    return kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
}

static NSString *ColorRangeForMode(NSString *colorMode) {
    return [colorMode hasSuffix:@"video-range"] ? @"video" : @"full";
}

static CFBooleanRef FullRangeFlagForMode(NSString *colorMode) {
    return [colorMode hasSuffix:@"video-range"] ? kCFBooleanFalse : kCFBooleanTrue;
}

static BOOL UsesSrgbTransfer(NSString *colorMode) {
    return [colorMode hasPrefix:@"srgb"];
}

static CFStringRef ColorSpaceNameForMode(NSString *colorMode) {
    return UsesSrgbTransfer(colorMode) ? kCGColorSpaceSRGB : kCGColorSpaceITUR_709;
}

static CFStringRef TransferFunctionForMode(NSString *colorMode) {
    return UsesSrgbTransfer(colorMode) ? kCVImageBufferTransferFunction_sRGB : kCVImageBufferTransferFunction_ITU_R_709_2;
}

static NSString *TransferFunctionLabelForMode(NSString *colorMode) {
    return UsesSrgbTransfer(colorMode) ? @"sRGB" : @"ITU_R_709_2";
}

static NSString *ColorSpaceLabelForMode(NSString *colorMode) {
    return UsesSrgbTransfer(colorMode) ? @"sRGB" : @"ITUR_709";
}

static NSString *FourCharCodeString(OSType code) {
    char chars[5] = {
        static_cast<char>((code >> 24) & 0xff),
        static_cast<char>((code >> 16) & 0xff),
        static_cast<char>((code >> 8) & 0xff),
        static_cast<char>(code & 0xff),
        0,
    };
    return [NSString stringWithUTF8String:chars] ?: [NSString stringWithFormat:@"%u", code];
}

static void ApplyColorAttachments(CVImageBufferRef imageBuffer, NSString *colorMode) {
    if (!imageBuffer) return;
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(ColorSpaceNameForMode(colorMode));
    if (colorSpace) {
        CVBufferSetAttachment(imageBuffer, kCVImageBufferCGColorSpaceKey, colorSpace, kCVAttachmentMode_ShouldPropagate);
        CFRelease(colorSpace);
    }
    CVBufferSetAttachment(imageBuffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(imageBuffer, kCVImageBufferTransferFunctionKey, TransferFunctionForMode(colorMode), kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(imageBuffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(imageBuffer, kCMFormatDescriptionExtension_FullRangeVideo, FullRangeFlagForMode(colorMode), kCVAttachmentMode_ShouldPropagate);
}

static NSDictionary *SourceImageBufferAttributes(NSInteger width, NSInteger height, OSType pixelFormat, NSString *colorMode) {
    return @{
        (__bridge NSString *)kCVPixelBufferWidthKey: @(width),
        (__bridge NSString *)kCVPixelBufferHeightKey: @(height),
        (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(pixelFormat),
        (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (__bridge NSString *)kCVImageBufferColorPrimariesKey: (__bridge NSString *)kCVImageBufferColorPrimaries_ITU_R_709_2,
        (__bridge NSString *)kCVImageBufferTransferFunctionKey: (__bridge NSString *)TransferFunctionForMode(colorMode),
        (__bridge NSString *)kCVImageBufferYCbCrMatrixKey: (__bridge NSString *)kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        (__bridge NSString *)kCMFormatDescriptionExtension_FullRangeVideo: (__bridge NSNumber *)FullRangeFlagForMode(colorMode),
    };
}

static CMVideoCodecType CodecTypeForName(NSString *codec) {
    if ([codec isEqualToString:@"hevc"]) return kCMVideoCodecType_HEVC;
    if ([codec isEqualToString:@"av1"]) return kCMVideoCodecType_AV1;
    return kCMVideoCodecType_H264;
}

static NSString *CodecMimeType(NSString *codec) {
    if ([codec isEqualToString:@"hevc"]) return @"video/H265";
    if ([codec isEqualToString:@"av1"]) return @"video/AV1";
    return @"video/H264";
}

static NSString *H264Fmtp(NSString *profile) {
    NSString *normalized = [(OptionalString(profile) ?: @"baseline") lowercaseString];
    if ([normalized isEqualToString:@"high"]) {
        return @"profile-level-id=64001f;packetization-mode=1;level-asymmetry-allowed=1";
    }
    if ([normalized isEqualToString:@"main"]) {
        return @"profile-level-id=4d001f;packetization-mode=1;level-asymmetry-allowed=1";
    }
    return @"profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1";
}

static CFStringRef H264VideoToolboxProfile(NSString *profile) {
    NSString *normalized = [(OptionalString(profile) ?: @"baseline") lowercaseString];
    if ([normalized isEqualToString:@"high"]) return kVTProfileLevel_H264_High_AutoLevel;
    if ([normalized isEqualToString:@"main"]) return kVTProfileLevel_H264_Main_AutoLevel;
    return kVTProfileLevel_H264_Baseline_AutoLevel;
}

static NSString *HevcFmtp(NSInteger levelId, NSInteger tierFlag, NSString *txMode) {
    return [NSString stringWithFormat:@"profile-id=1;tier-flag=%ld;level-id=%ld;tx-mode=%@",
                                      static_cast<long>(tierFlag),
                                      static_cast<long>(levelId),
                                      OptionalString(txMode) ?: @"SRST"];
}

static NSString *Av1Fmtp(NSInteger profile, NSInteger levelIdx, NSInteger tier) {
    return [NSString stringWithFormat:@"profile=%ld;level-idx=%ld;tier=%ld",
                                      static_cast<long>(profile),
                                      static_cast<long>(levelIdx),
                                      static_cast<long>(tier)];
}

static NSDictionary *ProbeCodec(NSString *codec, BOOL requireHardware) {
    VTCompressionSessionRef session = nullptr;
    NSMutableDictionary *encoderSpec = nil;
    if (requireHardware) {
        encoderSpec = [@{
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
        } mutableCopy];
    }
    OSStatus hardwareStatus = VTCompressionSessionCreate(
        kCFAllocatorDefault,
        1920,
        1080,
        CodecTypeForName(codec),
        requireHardware ? (__bridge CFDictionaryRef)encoderSpec : nil,
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        &session
    );
    BOOL hardwareAvailable = hardwareStatus == noErr && session != nil;
    if (session) {
        CFRelease(session);
        session = nil;
    }

    OSStatus defaultStatus = VTCompressionSessionCreate(
        kCFAllocatorDefault,
        1920,
        1080,
        CodecTypeForName(codec),
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        &session
    );
    BOOL defaultAvailable = defaultStatus == noErr && session != nil;
    if (session) CFRelease(session);

    return @{
        @"codec": codec,
        @"mimeType": CodecMimeType(codec),
        @"hardwareRequiredStatus": @(hardwareStatus),
        @"hardwareRequiredAvailable": @(hardwareAvailable),
        @"defaultStatus": @(defaultStatus),
        @"defaultAvailable": @(defaultAvailable),
    };
}

static BOOL HasPostEventAccess(BOOL requestIfNeeded) {
    if (@available(macOS 10.15, *)) {
        if (CGPreflightPostEventAccess()) return YES;
        return requestIfNeeded ? CGRequestPostEventAccess() : NO;
    }
    return YES;
}

static BOOL ArrayContainsString(id value, NSString *needle) {
    NSArray *array = OptionalArray(value);
    if (!array) return NO;
    for (id item in array) {
        NSString *text = [[OptionalString(item) ?: @"" lowercaseString] copy];
        if ([text isEqualToString:needle]) return YES;
    }
    return NO;
}

static CGEventFlags FlagsFromModifiers(id modifiers) {
    CGEventFlags flags = 0;
    if (ArrayContainsString(modifiers, @"shift")) flags |= kCGEventFlagMaskShift;
    if (ArrayContainsString(modifiers, @"ctrl") || ArrayContainsString(modifiers, @"control")) flags |= kCGEventFlagMaskControl;
    if (ArrayContainsString(modifiers, @"alt") || ArrayContainsString(modifiers, @"option")) flags |= kCGEventFlagMaskAlternate;
    if (ArrayContainsString(modifiers, @"meta") || ArrayContainsString(modifiers, @"cmd") || ArrayContainsString(modifiers, @"command")) flags |= kCGEventFlagMaskCommand;
    return flags;
}

static double ClampUnitDouble(id value, double fallback) {
    double number = OptionalDouble(value, fallback);
    if (!std::isfinite(number)) return fallback;
    return std::max(0.0, std::min(1.0, number));
}

static int64_t ClampInteger(id value, int64_t fallback, int64_t minValue, int64_t maxValue) {
    int64_t number = static_cast<int64_t>(OptionalInteger(value, static_cast<NSInteger>(fallback)));
    return std::max(minValue, std::min(maxValue, number));
}

static CGMouseButton MouseButtonFromBrowserButton(NSInteger button) {
    if (button == 2) return kCGMouseButtonRight;
    if (button == 1) return kCGMouseButtonCenter;
    return kCGMouseButtonLeft;
}

static CGEventType MouseEventTypeForAction(NSString *action, NSInteger button, NSInteger buttons) {
    CGMouseButton cgButton = MouseButtonFromBrowserButton(button);
    if ([action isEqualToString:@"down"]) {
        if (cgButton == kCGMouseButtonRight) return kCGEventRightMouseDown;
        if (cgButton == kCGMouseButtonCenter) return kCGEventOtherMouseDown;
        return kCGEventLeftMouseDown;
    }
    if ([action isEqualToString:@"up"]) {
        if (cgButton == kCGMouseButtonRight) return kCGEventRightMouseUp;
        if (cgButton == kCGMouseButtonCenter) return kCGEventOtherMouseUp;
        return kCGEventLeftMouseUp;
    }
    if ((buttons & 2) != 0) return kCGEventRightMouseDragged;
    if ((buttons & 4) != 0) return kCGEventOtherMouseDragged;
    if ((buttons & 1) != 0) return kCGEventLeftMouseDragged;
    return kCGEventMouseMoved;
}

static std::optional<CGKeyCode> KeyCodeForDomCode(NSString *code) {
    NSString *normalized = OptionalString(code);
    if (!normalized) return std::nullopt;

    static NSDictionary<NSString *, NSNumber *> *mapping = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        mapping = @{
            @"KeyA": @0, @"KeyS": @1, @"KeyD": @2, @"KeyF": @3, @"KeyH": @4, @"KeyG": @5,
            @"KeyZ": @6, @"KeyX": @7, @"KeyC": @8, @"KeyV": @9, @"KeyB": @11, @"KeyQ": @12,
            @"KeyW": @13, @"KeyE": @14, @"KeyR": @15, @"KeyY": @16, @"KeyT": @17, @"Digit1": @18,
            @"Digit2": @19, @"Digit3": @20, @"Digit4": @21, @"Digit6": @22, @"Digit5": @23,
            @"Equal": @24, @"Digit9": @25, @"Digit7": @26, @"Minus": @27, @"Digit8": @28,
            @"Digit0": @29, @"BracketRight": @30, @"KeyO": @31, @"KeyU": @32, @"BracketLeft": @33,
            @"KeyI": @34, @"KeyP": @35, @"Enter": @36, @"Return": @36, @"KeyL": @37, @"KeyJ": @38,
            @"Quote": @39, @"KeyK": @40, @"Semicolon": @41, @"Backslash": @42, @"Comma": @43,
            @"Slash": @44, @"KeyN": @45, @"KeyM": @46, @"Period": @47, @"Tab": @48, @"Space": @49,
            @"Backquote": @50, @"Backspace": @51, @"Escape": @53, @"MetaRight": @54, @"MetaLeft": @55,
            @"ShiftLeft": @56, @"CapsLock": @57, @"AltLeft": @58, @"ControlLeft": @59, @"ShiftRight": @60,
            @"AltRight": @61, @"ControlRight": @62, @"NumpadDecimal": @65, @"NumpadMultiply": @67,
            @"NumpadAdd": @69, @"NumLock": @71, @"AudioVolumeUp": @72, @"AudioVolumeDown": @73,
            @"AudioVolumeMute": @74, @"NumpadDivide": @75, @"NumpadEnter": @76, @"NumpadSubtract": @78,
            @"F18": @79, @"F19": @80, @"NumpadEqual": @81, @"Numpad0": @82, @"Numpad1": @83,
            @"Numpad2": @84, @"Numpad3": @85, @"Numpad4": @86, @"Numpad5": @87, @"Numpad6": @88,
            @"Numpad7": @89, @"F20": @90, @"Numpad8": @91, @"Numpad9": @92, @"F5": @96, @"F6": @97,
            @"F7": @98, @"F3": @99, @"F8": @100, @"F9": @101, @"F11": @103, @"F13": @105,
            @"F16": @106, @"F14": @107, @"F10": @109, @"ContextMenu": @110, @"F12": @111,
            @"F15": @113, @"Help": @114, @"Home": @115, @"PageUp": @116, @"Delete": @117,
            @"F4": @118, @"End": @119, @"F2": @120, @"PageDown": @121, @"F1": @122,
            @"ArrowLeft": @123, @"ArrowRight": @124, @"ArrowDown": @125, @"ArrowUp": @126,
        };
    });

    NSNumber *value = mapping[normalized];
    if (!value) return std::nullopt;
    return static_cast<CGKeyCode>(value.unsignedShortValue);
}

static NSDictionary *CodecProbeReport() {
    return @{
        @"backend": @"native-webrtc",
        @"codecs": @[
            ProbeCodec(@"h264", YES),
            ProbeCodec(@"hevc", YES),
            ProbeCodec(@"av1", YES),
        ],
        @"packetizers": @{
            @"h264": @YES,
            @"hevc": @YES,
            @"av1": @YES,
        },
    };
}

struct EncodeFrameContext {
    Clock::time_point startedAt;
};

@class WindowStreamNativeSession;

static void CompressionOutputCallback(
    void *outputCallbackRefCon,
    void *sourceFrameRefCon,
    OSStatus status,
    VTEncodeInfoFlags infoFlags,
    CMSampleBufferRef sampleBuffer
);

@interface WindowStreamNativeSession : NSObject <SCStreamOutput, SCStreamDelegate>
- (instancetype)initWithSessionId:(NSString *)sessionId
                            window:(SCWindow *)window
                          settings:(NSDictionary *)settings;
- (void)createOfferWithIceServers:(NSArray *)iceServers;
- (BOOL)applyAnswer:(NSDictionary *)answer error:(NSError **)outError;
- (void)addIceCandidate:(NSDictionary *)candidate;
- (void)handleControlMessage:(NSDictionary *)message;
- (void)requestTargetApplicationActivation;
- (void)stop;
- (void)handleEncodedSampleBuffer:(CMSampleBufferRef)sampleBuffer
                            status:(OSStatus)status
                         infoFlags:(VTEncodeInfoFlags)infoFlags
                           context:(EncodeFrameContext *)context;
@end

@implementation WindowStreamNativeSession {
    NSString *_sessionId;
    NSString *_windowId;
    SCWindow *_window;
    pid_t _targetPid;
    NSInteger _maxDimension;
    NSInteger _frameRate;
    NSInteger _bitrate;
    NSInteger _width;
    NSInteger _height;
    NSString *_codec;
    NSString *_colorMode;
    OSType _capturePixelFormat;
    NSString *_h264Profile;
    NSInteger _hevcLevelId;
    NSInteger _hevcTierFlag;
    NSString *_hevcTxMode;
    NSInteger _av1Profile;
    NSInteger _av1LevelIdx;
    NSInteger _av1Tier;
    NSString *_av1Packetization;
    BOOL _realtime;
    BOOL _hardwareAcceleration;
    BOOL _allowFrameReordering;
    double _keyframeIntervalSeconds;
    NSInteger _maxFrameDelayCount;
    BOOL _showCursor;
    NSInteger _captureQueueDepth;
    BOOL _scaleToFit;
    BOOL _preserveAspectRatio;
    BOOL _opaque;
    BOOL _ignoreGlobalClipSingleWindow;
    NSInteger _maxInFlightFrames;
    BOOL _controlEnabled;
    NSString *_controlDelivery;
    BOOL _postEventAccessRequested;
    BOOL _postEventAccessDeniedReported;

    dispatch_queue_t _sampleQueue;
    dispatch_source_t _idleRepeatTimer;
    SCStream *_stream;
    VTCompressionSessionRef _encoder;
    CMTime _firstPts;
    BOOL _hasFirstPts;
    CMTime _lastEncodePts;
    BOOL _hasLastEncodePts;
    CVPixelBufferRef _lastPixelBuffer;
    Clock::time_point _lastRealFrameAt;
    Clock::time_point _lastIdleKeyframeAt;
    std::mutex _lastPixelBufferMutex;

    std::shared_ptr<rtc::PeerConnection> _peerConnection;
    std::shared_ptr<rtc::Track> _track;
    std::shared_ptr<rtc::DataChannel> _controlChannel;
    std::shared_ptr<rtc::RtcpSrReporter> _senderReporter;
    std::mutex _peerMutex;

    std::atomic<bool> _stopping;
    std::atomic<bool> _forceKeyframe;
    std::atomic<int> _encodingInFlight;
    std::atomic<uint64_t> _captureFrames;
    std::atomic<uint64_t> _encodedFrames;
    std::atomic<uint64_t> _sentFrames;
    std::atomic<uint64_t> _repeatedFrames;
    std::atomic<uint64_t> _droppedFrames;
    std::atomic<uint64_t> _encodedBytes;
    std::atomic<uint64_t> _keyframes;
    std::atomic<uint64_t> _pliCount;
    std::atomic<uint64_t> _controlMessages;
    std::atomic<uint64_t> _controlPostedPid;
    std::atomic<uint64_t> _controlPostedHid;
    std::atomic<uint64_t> _controlDropped;
    std::atomic<uint64_t> _controlPermissionDenied;
    std::atomic<uint64_t> _controlFocusRequests;
    std::atomic<uint64_t> _controlFocusFailures;

    std::mutex _encodeDurationsMutex;
    std::vector<double> _encodeDurationsMs;
    std::thread _statsThread;
}

- (instancetype)initWithSessionId:(NSString *)sessionId
                            window:(SCWindow *)window
                          settings:(NSDictionary *)settings {
    self = [super init];
    if (!self) return nil;
    _sessionId = [sessionId copy];
    _window = window;
    _windowId = WindowIdString(window);
    _targetPid = window.owningApplication ? window.owningApplication.processID : 0;
    _maxDimension = std::max<NSInteger>(320, std::min<NSInteger>(4096, OptionalInteger(settings[@"maxDimension"], 1920)));
    _frameRate = std::max<NSInteger>(1, std::min<NSInteger>(60, OptionalInteger(settings[@"maxFrameRate"], 60)));
    _bitrate = std::max<NSInteger>(500000, OptionalInteger(settings[@"bitrate"], 12000000));
    _codec = [NormalizeCodecName(settings[@"codec"]) copy];
    _colorMode = [NormalizeColorMode(settings[@"colorMode"]) copy];
    _capturePixelFormat = PixelFormatForColorMode(_colorMode);
    _h264Profile = [[(OptionalString(settings[@"h264Profile"]) ?: @"baseline") lowercaseString] copy];
    _hevcLevelId = std::max<NSInteger>(1, std::min<NSInteger>(255, OptionalInteger(settings[@"hevcLevelId"], 180)));
    _hevcTierFlag = OptionalInteger(settings[@"hevcTierFlag"], 0) == 1 ? 1 : 0;
    _hevcTxMode = [(OptionalString(settings[@"hevcTxMode"]) ?: @"SRST") copy];
    _av1Profile = std::max<NSInteger>(0, std::min<NSInteger>(2, OptionalInteger(settings[@"av1Profile"], 0)));
    _av1LevelIdx = std::max<NSInteger>(0, std::min<NSInteger>(31, OptionalInteger(settings[@"av1LevelIdx"], 5)));
    _av1Tier = OptionalInteger(settings[@"av1Tier"], 0) == 1 ? 1 : 0;
    _av1Packetization = [[(OptionalString(settings[@"av1Packetization"]) ?: @"temporal-unit") lowercaseString] copy];
    _realtime = OptionalBool(settings[@"realtime"], YES);
    _hardwareAcceleration = OptionalBool(settings[@"hardwareAcceleration"], YES);
    _allowFrameReordering = OptionalBool(settings[@"allowFrameReordering"], NO);
    _keyframeIntervalSeconds = std::max<double>(0.5, std::min<double>(10.0, OptionalDouble(settings[@"keyframeIntervalSeconds"], 2.0)));
    _maxFrameDelayCount = std::max<NSInteger>(0, std::min<NSInteger>(4, OptionalInteger(settings[@"maxFrameDelayCount"], 0)));
    _showCursor = OptionalBool(settings[@"showCursor"], NO);
    _captureQueueDepth = std::max<NSInteger>(1, std::min<NSInteger>(8, OptionalInteger(settings[@"captureQueueDepth"], 3)));
    _scaleToFit = OptionalBool(settings[@"scaleToFit"], YES);
    _preserveAspectRatio = OptionalBool(settings[@"preserveAspectRatio"], YES);
    _opaque = OptionalBool(settings[@"opaque"], YES);
    _ignoreGlobalClipSingleWindow = OptionalBool(settings[@"ignoreGlobalClipSingleWindow"], YES);
    _maxInFlightFrames = std::max<NSInteger>(1, std::min<NSInteger>(8, OptionalInteger(settings[@"maxInFlightFrames"], 3)));
    _controlEnabled = OptionalBool(settings[@"controlEnabled"], YES);
    _controlDelivery = [NormalizeControlDelivery(settings[@"controlDelivery"]) copy];
    _postEventAccessRequested = NO;
    _postEventAccessDeniedReported = NO;
    _sampleQueue = dispatch_queue_create("weave.window-stream-native.samples", DISPATCH_QUEUE_SERIAL);
    _firstPts = kCMTimeInvalid;
    _hasFirstPts = NO;
    _lastEncodePts = kCMTimeInvalid;
    _hasLastEncodePts = NO;
    _lastPixelBuffer = nullptr;
    _lastRealFrameAt = Clock::now();
    _lastIdleKeyframeAt = Clock::time_point::min();
    _stopping = false;
    _forceKeyframe = true;
    _encodingInFlight = 0;
    _captureFrames = 0;
    _encodedFrames = 0;
    _sentFrames = 0;
    _repeatedFrames = 0;
    _droppedFrames = 0;
    _encodedBytes = 0;
    _keyframes = 0;
    _pliCount = 0;
    _controlMessages = 0;
    _controlPostedPid = 0;
    _controlPostedHid = 0;
    _controlDropped = 0;
    _controlPermissionDenied = 0;
    _controlFocusRequests = 0;
    _controlFocusFailures = 0;
    return self;
}

- (void)dealloc {
    [self stop];
}

- (void)sendSessionEvent:(NSDictionary *)event {
    NSMutableDictionary *withSession = [event mutableCopy];
    withSession[@"sessionId"] = _sessionId;
    WriteJsonLine(@{
        @"type": @"session.event",
        @"sessionId": _sessionId,
        @"event": withSession,
    });
}

- (void)sendError:(NSString *)message {
    [self sendSessionEvent:@{@"type": @"error", @"error": message ?: @"Window stream failed."}];
}

- (void)createOfferWithIceServers:(NSArray *)iceServers {
    rtc::Configuration config;
    config.disableAutoNegotiation = true;
    config.forceMediaTransport = true;

    for (id entry in iceServers ?: @[]) {
        if ([entry isKindOfClass:[NSString class]]) {
            NSString *url = OptionalString(entry);
            if (url) config.iceServers.emplace_back(StdFromString(url));
            continue;
        }
        NSDictionary *server = OptionalDictionary(entry);
        if (!server) continue;
        id urlsValue = server[@"urls"];
        if ([urlsValue isKindOfClass:[NSString class]]) {
            NSString *url = OptionalString(urlsValue);
            if (url) config.iceServers.emplace_back(StdFromString(url));
        } else if ([urlsValue isKindOfClass:[NSArray class]]) {
            for (id urlValue in (NSArray *)urlsValue) {
                NSString *url = OptionalString(urlValue);
                if (url) config.iceServers.emplace_back(StdFromString(url));
            }
        }
    }

    auto peerConnection = std::make_shared<rtc::PeerConnection>(config);
    auto weakSession = self;
    peerConnection->onLocalDescription([weakSession](rtc::Description description) {
        NSString *type = StringFromStd(description.typeString());
        NSString *sdp = StringFromStd(description.generateSdp("\r\n"));
        [weakSession sendSessionEvent:@{
            @"type": @"offer",
            @"offer": @{
                @"type": type,
                @"sdp": sdp,
            },
        }];
    });
    peerConnection->onLocalCandidate([weakSession](rtc::Candidate candidate) {
        NSString *candidateString = StringFromStd(std::string(candidate));
        if (candidateString.length == 0) return;
        [weakSession sendSessionEvent:@{
            @"type": @"ice-candidate",
            @"candidate": @{
                @"candidate": candidateString,
                @"sdpMid": StringFromStd(candidate.mid()),
                @"sdpMLineIndex": @0,
            },
        }];
    });
    peerConnection->onStateChange([weakSession](rtc::PeerConnection::State state) {
        std::ostringstream stream;
        stream << state;
        WriteDiagnostic([NSString stringWithFormat:@"peer connection %@: %@", weakSession->_sessionId, StringFromStd(stream.str())]);
    });

    constexpr uint8_t payloadType = 102;
    constexpr uint32_t ssrc = 1;
    const std::string cname = "weave-window-video";
    const std::string msid = "weave-window-stream";
    auto video = rtc::Description::Video("video");
    if ([_codec isEqualToString:@"hevc"]) {
        video.addH265Codec(payloadType, StdFromString(HevcFmtp(_hevcLevelId, _hevcTierFlag, _hevcTxMode)));
    } else if ([_codec isEqualToString:@"av1"]) {
        video.addAV1Codec(payloadType, StdFromString(Av1Fmtp(_av1Profile, _av1LevelIdx, _av1Tier)));
    } else {
        video.addH264Codec(payloadType, StdFromString(H264Fmtp(_h264Profile)));
    }
    video.addSSRC(ssrc, cname, msid, cname);
    auto track = peerConnection->addTrack(video);
    auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, cname, payloadType, rtc::H264RtpPacketizer::ClockRate);
    std::shared_ptr<rtc::RtpPacketizer> packetizer;
    if ([_codec isEqualToString:@"hevc"]) {
        packetizer = std::make_shared<rtc::H265RtpPacketizer>(rtc::NalUnit::Separator::Length, rtpConfig);
    } else if ([_codec isEqualToString:@"av1"]) {
        rtc::AV1RtpPacketizer::Packetization packetization = [_av1Packetization isEqualToString:@"obu"]
            ? rtc::AV1RtpPacketizer::Packetization::Obu
            : rtc::AV1RtpPacketizer::Packetization::TemporalUnit;
        packetizer = std::make_shared<rtc::AV1RtpPacketizer>(packetization, rtpConfig);
    } else {
        packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::Length, rtpConfig);
    }
    auto srReporter = std::make_shared<rtc::RtcpSrReporter>(rtpConfig);
    packetizer->addToChain(srReporter);
    packetizer->addToChain(std::make_shared<rtc::PliHandler>([weakSession]() {
        weakSession->_pliCount.fetch_add(1, std::memory_order_relaxed);
        weakSession->_forceKeyframe = true;
    }));
    packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
    track->setMediaHandler(packetizer);
    track->onOpen([weakSession]() {
        WriteDiagnostic([NSString stringWithFormat:@"video track open: %@", weakSession->_sessionId]);
    });

    rtc::DataChannelInit dataChannelInit;
    dataChannelInit.reliability.unordered = false;
    auto controlChannel = peerConnection->createDataChannel("control", dataChannelInit);
    controlChannel->onOpen([weakSession]() {
        WriteDiagnostic([NSString stringWithFormat:@"control channel open: %@", weakSession->_sessionId]);
    });
    controlChannel->onMessage(nullptr, [weakSession](std::string message) {
        @autoreleasepool {
            NSData *data = [NSData dataWithBytes:message.data() length:message.size()];
            NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            [weakSession handleControlMessage:OptionalDictionary(json) ?: @{}];
        }
    });

    {
        std::lock_guard<std::mutex> lock(_peerMutex);
        _peerConnection = peerConnection;
        _track = track;
        _controlChannel = controlChannel;
        _senderReporter = srReporter;
    }

    peerConnection->setLocalDescription(rtc::Description::Type::Offer);
}

- (BOOL)applyAnswer:(NSDictionary *)answer error:(NSError **)outError {
    NSString *type = OptionalString(answer[@"type"]);
    NSString *sdp = OptionalString(answer[@"sdp"]);
    if (![type isEqualToString:@"answer"] || !sdp) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:4
                                        userInfo:@{NSLocalizedDescriptionKey: @"Answer SDP is required."}];
        }
        return NO;
    }

    try {
        std::lock_guard<std::mutex> lock(_peerMutex);
        if (!_peerConnection) {
            if (outError) {
                *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                                code:5
                                            userInfo:@{NSLocalizedDescriptionKey: @"No active peer connection."}];
            }
            return NO;
        }
        _peerConnection->setRemoteDescription(rtc::Description(StdFromString(NormalizeSdp(sdp)), "answer"));
    } catch (const std::exception &error) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:6
                                        userInfo:@{NSLocalizedDescriptionKey: ExceptionMessage(error)}];
        }
        return NO;
    }

    if (![self startCaptureWithError:outError]) return NO;
    if (_controlEnabled && [_controlDelivery isEqualToString:@"focus-hid"]) {
        WriteDiagnostic([NSString stringWithFormat:@"control focus scheduled on stream start: session=%@ pid=%d", _sessionId, _targetPid]);
        [self requestTargetApplicationActivation];
    }
    [self sendSessionEvent:@{@"type": @"started"}];
    return YES;
}

- (void)addIceCandidate:(NSDictionary *)candidate {
    NSString *candidateString = OptionalString(candidate[@"candidate"]);
    if (!candidateString) return;
    NSString *mid = OptionalString(candidate[@"sdpMid"]) ?: @"video";
    try {
        std::lock_guard<std::mutex> lock(_peerMutex);
        if (_peerConnection) _peerConnection->addRemoteCandidate(rtc::Candidate(StdFromString(candidateString), StdFromString(mid)));
    } catch (const std::exception &error) {
        [self sendError:ExceptionMessage(error)];
    }
}

- (CGPoint)screenPointForControlMessage:(NSDictionary *)message {
    CGRect frame = _window.frame;
    double x = ClampUnitDouble(message[@"x"], 0.0);
    double y = ClampUnitDouble(message[@"y"], 0.0);
    return CGPointMake(
        frame.origin.x + frame.size.width * static_cast<CGFloat>(x),
        frame.origin.y + frame.size.height * static_cast<CGFloat>(y)
    );
}

- (BOOL)ensurePostEventAccessForKind:(NSString *)kind {
    if (HasPostEventAccess(NO)) return YES;
    if (!_postEventAccessRequested) {
        _postEventAccessRequested = YES;
        if (HasPostEventAccess(YES)) return YES;
    }

    _controlPermissionDenied.fetch_add(1, std::memory_order_relaxed);
    WriteDiagnostic([NSString stringWithFormat:@"control %@ blocked: session=%@ delivery=%@ macOS post-event access denied", kind, _sessionId, _controlDelivery]);
    if (!_postEventAccessDeniedReported) {
        _postEventAccessDeniedReported = YES;
        [self sendError:@"macOS blocked window control events. Enable Accessibility permission for the app that launched Portal, then restart Portal."];
    }
    return NO;
}

- (void)requestTargetApplicationActivation {
    if (_targetPid <= 0) {
        _controlFocusFailures.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    _controlFocusRequests.fetch_add(1, std::memory_order_relaxed);
    pid_t targetPid = _targetPid;
    NSString *sessionId = [_sessionId copy];

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
        @autoreleasepool {
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:targetPid];
        if (!application) {
            self->_controlFocusFailures.fetch_add(1, std::memory_order_relaxed);
            WriteDiagnostic([NSString stringWithFormat:@"control focus failed: session=%@ pid=%d app not found", sessionId, targetPid]);
            return;
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        BOOL activated = [application activateWithOptions:NSApplicationActivateIgnoringOtherApps | NSApplicationActivateAllWindows];
#pragma clang diagnostic pop
        if (!activated) {
            self->_controlFocusFailures.fetch_add(1, std::memory_order_relaxed);
            WriteDiagnostic([NSString stringWithFormat:@"control focus failed: session=%@ pid=%d", sessionId, targetPid]);
            return;
        }
        WriteDiagnostic([NSString stringWithFormat:@"control focus requested: session=%@ pid=%d", sessionId, targetPid]);
        }
    });
}

- (void)postControlEvent:(CGEventRef)event kind:(NSString *)kind {
    if (!event) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    if ([_controlDelivery isEqualToString:@"focus-hid"]) {
        [self requestTargetApplicationActivation];
        if ([self ensurePostEventAccessForKind:kind]) {
            CGEventPost(kCGHIDEventTap, event);
            _controlPostedHid.fetch_add(1, std::memory_order_relaxed);
            WriteDiagnostic([NSString stringWithFormat:@"control %@ posted via focus-hid: session=%@ pid=%d", kind, _sessionId, _targetPid]);
            return;
        }
        if (_targetPid > 0) {
            CGEventPostToPid(_targetPid, event);
            _controlPostedPid.fetch_add(1, std::memory_order_relaxed);
            WriteDiagnostic([NSString stringWithFormat:@"control %@ fallback posted via pid after focus-hid block: session=%@ pid=%d", kind, _sessionId, _targetPid]);
            return;
        }
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    BOOL canPostToPid = _targetPid > 0 && ![_controlDelivery isEqualToString:@"hid-only"];
    if (canPostToPid) {
        CGEventPostToPid(_targetPid, event);
        _controlPostedPid.fetch_add(1, std::memory_order_relaxed);
        WriteDiagnostic([NSString stringWithFormat:@"control %@ posted via pid: session=%@ pid=%d", kind, _sessionId, _targetPid]);
        return;
    }

    if ([_controlDelivery isEqualToString:@"pid-only"]) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        WriteDiagnostic([NSString stringWithFormat:@"control %@ dropped: session=%@ no target pid", kind, _sessionId]);
        return;
    }

    if (![self ensurePostEventAccessForKind:kind]) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    CGEventPost(kCGHIDEventTap, event);
    _controlPostedHid.fetch_add(1, std::memory_order_relaxed);
    WriteDiagnostic([NSString stringWithFormat:@"control %@ posted via hid: session=%@", kind, _sessionId]);
}

- (void)handlePointerControlMessage:(NSDictionary *)message {
    NSString *action = OptionalString(message[@"action"]) ?: @"move";
    NSInteger button = OptionalInteger(message[@"button"], 0);
    NSInteger buttons = OptionalInteger(message[@"buttons"], 0);
    CGPoint point = [self screenPointForControlMessage:message];
    CGMouseButton mouseButton = MouseButtonFromBrowserButton(button);
    CGEventType eventType = MouseEventTypeForAction(action, button, buttons);
    CGEventRef event = CGEventCreateMouseEvent(nullptr, eventType, point, mouseButton);
    if (!event) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    CGEventSetFlags(event, FlagsFromModifiers(message[@"modifiers"]));
    CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, mouseButton);
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, ClampInteger(message[@"clickCount"], 1, 1, 3));
    if ([message[@"pressure"] isKindOfClass:[NSNumber class]]) {
        double pressure = std::max(0.0, std::min(1.0, [message[@"pressure"] doubleValue]));
        CGEventSetDoubleValueField(event, kCGMouseEventPressure, pressure);
    }
    [self postControlEvent:event kind:@"pointer"];
    CFRelease(event);
}

- (void)handleScrollControlMessage:(NSDictionary *)message {
    CGPoint point = [self screenPointForControlMessage:message];
    double dx = OptionalDouble(message[@"dx"], 0.0);
    double dy = OptionalDouble(message[@"dy"], 0.0);
    if (!std::isfinite(dx)) dx = 0.0;
    if (!std::isfinite(dy)) dy = 0.0;

    int32_t wheel1 = static_cast<int32_t>(std::max(-32767.0, std::min(32767.0, -dy)));
    int32_t wheel2 = static_cast<int32_t>(std::max(-32767.0, std::min(32767.0, -dx)));
    CGEventRef event = CGEventCreateScrollWheelEvent2(nullptr, kCGScrollEventUnitPixel, 2, wheel1, wheel2, 0);
    if (!event) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    CGEventSetLocation(event, point);
    CGEventSetFlags(event, FlagsFromModifiers(message[@"modifiers"]));
    CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1);
    [self postControlEvent:event kind:@"scroll"];
    CFRelease(event);
}

- (void)postTextControlMessage:(NSString *)text modifiers:(id)modifiers {
    if (text.length == 0) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    std::vector<UniChar> characters(text.length);
    [text getCharacters:characters.data() range:NSMakeRange(0, text.length)];

    for (NSNumber *keyDownValue in @[@YES, @NO]) {
        BOOL keyDown = keyDownValue.boolValue;
        CGEventRef event = CGEventCreateKeyboardEvent(nullptr, 0, keyDown);
        if (!event) {
            _controlDropped.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        CGEventSetFlags(event, FlagsFromModifiers(modifiers));
        if (keyDown) {
            CGEventKeyboardSetUnicodeString(event, static_cast<UniCharCount>(characters.size()), characters.data());
        }
        [self postControlEvent:event kind:@"text"];
        CFRelease(event);
    }
}

- (void)handleKeyControlMessage:(NSDictionary *)message {
    NSString *action = OptionalString(message[@"action"]) ?: @"down";
    if ([action isEqualToString:@"text"]) {
        [self postTextControlMessage:OptionalString(message[@"text"]) ?: OptionalString(message[@"key"]) ?: @""
                           modifiers:message[@"modifiers"]];
        return;
    }

    BOOL keyDown = ![action isEqualToString:@"up"];
    auto keyCode = KeyCodeForDomCode(OptionalString(message[@"code"]));
    if (!keyCode.has_value()) {
        if (keyDown) {
            NSString *text = OptionalString(message[@"text"]);
            if (!text && [OptionalString(message[@"key"]) length] == 1) text = OptionalString(message[@"key"]);
            if (text) {
                [self postTextControlMessage:text modifiers:message[@"modifiers"]];
                return;
            }
        }
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        WriteDiagnostic([NSString stringWithFormat:@"control key dropped: session=%@ code=%@", _sessionId, OptionalString(message[@"code"]) ?: @""]);
        return;
    }

    CGEventRef event = CGEventCreateKeyboardEvent(nullptr, keyCode.value(), keyDown);
    if (!event) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    CGEventSetFlags(event, FlagsFromModifiers(message[@"modifiers"]));
    CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, OptionalBool(message[@"repeat"], NO) ? 1 : 0);
    [self postControlEvent:event kind:@"key"];
    CFRelease(event);
}

- (void)handleControlMessage:(NSDictionary *)message {
    uint64_t controlMessageCount = _controlMessages.fetch_add(1, std::memory_order_relaxed) + 1;
    NSString *type = OptionalString(message[@"type"]) ?: @"unknown";
    NSString *action = OptionalString(message[@"action"]) ?: @"";
    BOOL isNoisyMove = [type isEqualToString:@"pointer"] && [action isEqualToString:@"move"];
    if (!isNoisyMove || controlMessageCount % 60 == 0) {
        WriteDiagnostic([NSString stringWithFormat:@"control received: session=%@ type=%@ action=%@ delivery=%@",
            _sessionId,
            type,
            action,
            _controlDelivery]);
    }

    if ([type isEqualToString:@"resize"] || [type isEqualToString:@"focus"]) {
        if ([type isEqualToString:@"focus"] && [_controlDelivery isEqualToString:@"focus-hid"]) {
            [self requestTargetApplicationActivation];
        }
        WriteDiagnostic([NSString stringWithFormat:@"control %@ noted: session=%@", type, _sessionId]);
        return;
    }

    if (!_controlEnabled) {
        _controlDropped.fetch_add(1, std::memory_order_relaxed);
        WriteDiagnostic([NSString stringWithFormat:@"control dropped disabled: session=%@ type=%@", _sessionId, type]);
        return;
    }

    if ([type isEqualToString:@"pointer"]) {
        [self handlePointerControlMessage:message];
        return;
    }
    if ([type isEqualToString:@"scroll"]) {
        [self handleScrollControlMessage:message];
        return;
    }
    if ([type isEqualToString:@"key"]) {
        [self handleKeyControlMessage:message];
        return;
    }

    _controlDropped.fetch_add(1, std::memory_order_relaxed);
    WriteDiagnostic([NSString stringWithFormat:@"control unsupported: session=%@ type=%@", _sessionId, type]);
}

- (BOOL)startCaptureWithError:(NSError **)outError {
    if (_stream) return YES;

    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:_window];
    CGSize outputSize = ScaledOutputSize(filter, _window, _maxDimension);
    _width = static_cast<NSInteger>(outputSize.width);
    _height = static_cast<NSInteger>(outputSize.height);

    if (![self createEncoderWithError:outError]) return NO;

    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = _width;
    configuration.height = _height;
    configuration.minimumFrameInterval = CMTimeMake(1, static_cast<int32_t>(_frameRate));
    configuration.pixelFormat = _capturePixelFormat;
    configuration.colorMatrix = kCGDisplayStreamYCbCrMatrix_ITU_R_709_2;
    configuration.colorSpaceName = ColorSpaceNameForMode(_colorMode);
    configuration.queueDepth = _captureQueueDepth;
    configuration.scalesToFit = _scaleToFit;
    configuration.preservesAspectRatio = _preserveAspectRatio;
    configuration.showsCursor = _showCursor;
    configuration.shouldBeOpaque = _opaque;
    configuration.ignoreGlobalClipSingleWindow = _ignoreGlobalClipSingleWindow;

    _stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
    NSError *streamError = nil;
    if (![_stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:_sampleQueue error:&streamError]) {
        if (outError) *outError = streamError;
        _stream = nil;
        return NO;
    }

    __block NSError *startError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [_stream startCaptureWithCompletionHandler:^(NSError *error) {
        startError = error;
        dispatch_semaphore_signal(semaphore);
    }];
    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:7
                                        userInfo:@{NSLocalizedDescriptionKey: @"Timed out while starting ScreenCaptureKit capture."}];
        }
        return NO;
    }
    if (startError) {
        if (outError) *outError = startError;
        return NO;
    }

    WriteDiagnostic([NSString stringWithFormat:@"capture started: backend=native-webrtc codec=%@ window=%@ size=%ldx%ld fps=%ld cursor=%@ bitrate=%ld colorMode=%@ pixelFormat=%@",
                                                _codec,
                                                _windowId, static_cast<long>(_width), static_cast<long>(_height),
                                                static_cast<long>(_frameRate), _showCursor ? @"true" : @"false",
                                                static_cast<long>(_bitrate), _colorMode,
                                                FourCharCodeString(_capturePixelFormat)]);
    [self startStatsThread];
    return YES;
}

- (BOOL)createEncoderWithError:(NSError **)outError {
    if (_encoder) return YES;

    NSDictionary *encoderSpec = _hardwareAcceleration
        ? @{
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
        }
        : nil;
    NSDictionary *sourceAttributes = SourceImageBufferAttributes(_width, _height, _capturePixelFormat, _colorMode);
    OSStatus status = VTCompressionSessionCreate(
        kCFAllocatorDefault,
        static_cast<int32_t>(_width),
        static_cast<int32_t>(_height),
        CodecTypeForName(_codec),
        (__bridge CFDictionaryRef)encoderSpec,
        (__bridge CFDictionaryRef)sourceAttributes,
        nullptr,
        CompressionOutputCallback,
        (__bridge void *)self,
        &_encoder
    );
    if (status != noErr || !_encoder) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"weave.window-stream-native"
                                            code:8
                                        userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"VideoToolbox %@ encoder creation failed: %d", _codec, status]}];
        }
        return NO;
    }

    int32_t expectedFrameRate = static_cast<int32_t>(_frameRate);
    int32_t bitrate = static_cast<int32_t>(_bitrate);
    int32_t keyframeInterval = static_cast<int32_t>(std::max<double>(1.0, std::round(_frameRate * _keyframeIntervalSeconds)));
    double keyframeIntervalDuration = _keyframeIntervalSeconds;
    int32_t maxFrameDelay = static_cast<int32_t>(_maxFrameDelayCount);

    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_RealTime, _realtime ? kCFBooleanTrue : kCFBooleanFalse);
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_AllowFrameReordering, _allowFrameReordering ? kCFBooleanTrue : kCFBooleanFalse);
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2);
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_TransferFunction, TransferFunctionForMode(_colorMode));
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);
    if ([_codec isEqualToString:@"hevc"]) {
        VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_HEVC_Main_AutoLevel);
    } else if ([_codec isEqualToString:@"h264"]) {
        VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_ProfileLevel, H264VideoToolboxProfile(_h264Profile));
    }
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef)@(expectedFrameRate));
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef)@(bitrate));
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef)@(keyframeInterval));
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, (__bridge CFTypeRef)@(keyframeIntervalDuration));
    VTSessionSetProperty(_encoder, kVTCompressionPropertyKey_MaxFrameDelayCount, (__bridge CFTypeRef)@(maxFrameDelay));
    VTCompressionSessionPrepareToEncodeFrames(_encoder);
    return YES;
}

- (void)stop {
    bool alreadyStopping = _stopping.exchange(true);
    if (alreadyStopping) return;

    if (_statsThread.joinable()) _statsThread.join();

    if (_idleRepeatTimer) {
        dispatch_source_cancel(_idleRepeatTimer);
        _idleRepeatTimer = nil;
    }

    if (_stream) {
        __block BOOL didFinish = NO;
        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        [_stream stopCaptureWithCompletionHandler:^(NSError *) {
            didFinish = YES;
            dispatch_semaphore_signal(semaphore);
        }];
        dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        if (!didFinish) WriteDiagnostic([NSString stringWithFormat:@"capture stop timed out: %@", _sessionId]);
        _stream = nil;
    }

    if (_encoder) {
        VTCompressionSessionCompleteFrames(_encoder, kCMTimeInvalid);
        VTCompressionSessionInvalidate(_encoder);
        CFRelease(_encoder);
        _encoder = nil;
    }

    {
        std::lock_guard<std::mutex> lock(_peerMutex);
        if (_controlChannel) {
            _controlChannel->resetCallbacks();
            _controlChannel->close();
        }
        if (_track) {
            _track->resetCallbacks();
            _track->close();
        }
        if (_peerConnection) {
            _peerConnection->resetCallbacks();
            _peerConnection->close();
        }
        _controlChannel.reset();
        _track.reset();
        _peerConnection.reset();
        _senderReporter.reset();
    }

    CVPixelBufferRef lastPixelBuffer = nullptr;
    {
        std::lock_guard<std::mutex> lock(_lastPixelBufferMutex);
        lastPixelBuffer = _lastPixelBuffer;
        _lastPixelBuffer = nullptr;
    }
    if (lastPixelBuffer) CVPixelBufferRelease(lastPixelBuffer);

    [self sendSessionEvent:@{@"type": @"stopped"}];
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    [self sendError:NSErrorMessage(error)];
}

- (void)startIdleRepeatTimer {
    if (_idleRepeatTimer) return;
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _sampleQueue);
    uint64_t intervalNs = static_cast<uint64_t>(IdleRepeatIntervalSeconds * NSEC_PER_SEC);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, intervalNs), intervalNs, 50 * NSEC_PER_MSEC);
    __weak WindowStreamNativeSession *weakSelf = self;
    dispatch_source_set_event_handler(timer, ^{
        WindowStreamNativeSession *strongSelf = weakSelf;
        if (strongSelf) [strongSelf repeatLastFrameIfIdle];
    });
    _idleRepeatTimer = timer;
    dispatch_resume(timer);
}

- (CMTime)nextEncodePresentationTime:(CMTime)candidate {
    CMTime frameDuration = CMTimeMake(1, static_cast<int32_t>(_frameRate));
    CMTime idleRepeatDuration = CMTimeMakeWithSeconds(IdleRepeatIntervalSeconds, MediaTimeScale);
    if (!CMTIME_IS_VALID(candidate)) {
        candidate = _hasLastEncodePts ? CMTimeAdd(_lastEncodePts, idleRepeatDuration) : kCMTimeZero;
    }
    if (_hasLastEncodePts && CMTimeCompare(candidate, _lastEncodePts) <= 0) {
        candidate = CMTimeAdd(_lastEncodePts, frameDuration);
    }
    _lastEncodePts = candidate;
    _hasLastEncodePts = YES;
    return candidate;
}

- (void)rememberLastRealPixelBuffer:(CVPixelBufferRef)pixelBuffer {
    if (!pixelBuffer) return;
    CVPixelBufferRetain(pixelBuffer);
    CVPixelBufferRef previous = nullptr;
    {
        std::lock_guard<std::mutex> lock(_lastPixelBufferMutex);
        previous = _lastPixelBuffer;
        _lastPixelBuffer = pixelBuffer;
        _lastRealFrameAt = Clock::now();
        _lastIdleKeyframeAt = Clock::time_point::min();
    }
    if (previous) CVPixelBufferRelease(previous);
}

- (BOOL)encodePixelBuffer:(CVPixelBufferRef)pixelBuffer presentationTime:(CMTime)presentationTime repeated:(BOOL)repeated {
    if (!pixelBuffer || !_encoder || _stopping) return NO;

    int inFlight = _encodingInFlight.load(std::memory_order_relaxed);
    if (inFlight >= _maxInFlightFrames) {
        _droppedFrames.fetch_add(1, std::memory_order_relaxed);
        return NO;
    }
    _encodingInFlight.fetch_add(1, std::memory_order_relaxed);

    ApplyColorAttachments(pixelBuffer, _colorMode);
    CMTime encodePts = [self nextEncodePresentationTime:presentationTime];

    NSMutableDictionary *frameProperties = nil;
    if (_forceKeyframe.exchange(false, std::memory_order_relaxed)) {
        frameProperties = [@{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} mutableCopy];
    }

    auto *context = new EncodeFrameContext{Clock::now()};
    OSStatus status = VTCompressionSessionEncodeFrame(
        _encoder,
        pixelBuffer,
        encodePts,
        CMTimeMake(1, static_cast<int32_t>(_frameRate)),
        (__bridge CFDictionaryRef)frameProperties,
        context,
        nullptr
    );
    if (status != noErr) {
        delete context;
        _encodingInFlight.fetch_sub(1, std::memory_order_relaxed);
        _droppedFrames.fetch_add(1, std::memory_order_relaxed);
        return NO;
    }
    if (repeated) _repeatedFrames.fetch_add(1, std::memory_order_relaxed);
    return YES;
}

- (void)repeatLastFrameIfIdle {
    if (_stopping || !_encoder) return;

    CVPixelBufferRef pixelBuffer = nullptr;
    BOOL shouldForceKeyframe = NO;
    auto now = Clock::now();
    {
        std::lock_guard<std::mutex> lock(_lastPixelBufferMutex);
        if (!_lastPixelBuffer) return;
        double idleSeconds = std::chrono::duration<double>(now - _lastRealFrameAt).count();
        if (idleSeconds < IdleRepeatAfterSeconds) return;
        double keyframeAgeSeconds = _lastIdleKeyframeAt == Clock::time_point::min()
            ? std::numeric_limits<double>::infinity()
            : std::chrono::duration<double>(now - _lastIdleKeyframeAt).count();
        shouldForceKeyframe = keyframeAgeSeconds >= _keyframeIntervalSeconds;
        if (shouldForceKeyframe) _lastIdleKeyframeAt = now;
        pixelBuffer = _lastPixelBuffer;
        CVPixelBufferRetain(pixelBuffer);
    }

    if (shouldForceKeyframe) _forceKeyframe = true;
    [self encodePixelBuffer:pixelBuffer presentationTime:kCMTimeInvalid repeated:YES];
    CVPixelBufferRelease(pixelBuffer);
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || _stopping || !IsCompleteFrame(sampleBuffer)) return;
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer || !_encoder) return;

    _captureFrames.fetch_add(1, std::memory_order_relaxed);
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    if (!CMTIME_IS_VALID(pts)) {
        uint64_t frame = _captureFrames.load(std::memory_order_relaxed);
        pts = CMTimeMake(static_cast<int64_t>(frame), static_cast<int32_t>(_frameRate));
    }
    if (!_hasFirstPts) {
        _firstPts = pts;
        _hasFirstPts = YES;
    }
    CMTime relativePts = CMTimeSubtract(pts, _firstPts);
    if (!CMTIME_IS_VALID(relativePts) || CMTimeCompare(relativePts, kCMTimeZero) < 0) relativePts = kCMTimeZero;

    [self rememberLastRealPixelBuffer:pixelBuffer];
    [self encodePixelBuffer:pixelBuffer presentationTime:relativePts repeated:NO];
}

- (void)handleEncodedSampleBuffer:(CMSampleBufferRef)sampleBuffer
                            status:(OSStatus)status
                         infoFlags:(VTEncodeInfoFlags)infoFlags
                           context:(EncodeFrameContext *)context {
    _encodingInFlight.fetch_sub(1, std::memory_order_relaxed);
    if (context) {
        double elapsedMs = std::chrono::duration<double, std::milli>(Clock::now() - context->startedAt).count();
        {
            std::lock_guard<std::mutex> lock(_encodeDurationsMutex);
            _encodeDurationsMs.push_back(elapsedMs);
        }
        delete context;
    }

    if (status != noErr || (infoFlags & kVTEncodeInfo_FrameDropped) || !sampleBuffer || !CMSampleBufferDataIsReady(sampleBuffer)) {
        _droppedFrames.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    BOOL keyframe = IsKeyframe(sampleBuffer);
    NSMutableData *accessUnit = [NSMutableData data];

    if (keyframe) {
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sampleBuffer);
        if (format && [_codec isEqualToString:@"h264"]) {
            size_t parameterSetCount = 0;
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr, &parameterSetCount, nullptr);
            for (size_t index = 0; index < parameterSetCount; index += 1) {
                const uint8_t *parameterSet = nullptr;
                size_t parameterSetSize = 0;
                OSStatus parameterStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format,
                    index,
                    &parameterSet,
                    &parameterSetSize,
                    nullptr,
                    nullptr
                );
                if (parameterStatus == noErr && parameterSet && parameterSetSize > 0) {
                    AppendLengthPrefixedNal(accessUnit, parameterSet, parameterSetSize);
                }
            }
        } else if (format && [_codec isEqualToString:@"hevc"]) {
            size_t parameterSetCount = 0;
            CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, 0, nullptr, nullptr, &parameterSetCount, nullptr);
            for (size_t index = 0; index < parameterSetCount; index += 1) {
                const uint8_t *parameterSet = nullptr;
                size_t parameterSetSize = 0;
                OSStatus parameterStatus = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                    format,
                    index,
                    &parameterSet,
                    &parameterSetSize,
                    nullptr,
                    nullptr
                );
                if (parameterStatus == noErr && parameterSet && parameterSetSize > 0) {
                    AppendLengthPrefixedNal(accessUnit, parameterSet, parameterSetSize);
                }
            }
        }
        _keyframes.fetch_add(1, std::memory_order_relaxed);
    }

    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return;
    size_t totalLength = CMBlockBufferGetDataLength(blockBuffer);
    if (totalLength == 0) return;
    std::vector<uint8_t> encoded(totalLength);
    OSStatus copyStatus = CMBlockBufferCopyDataBytes(blockBuffer, 0, totalLength, encoded.data());
    if (copyStatus != noErr) return;
    [accessUnit appendBytes:encoded.data() length:encoded.size()];
    if (accessUnit.length == 0) return;

    _encodedFrames.fetch_add(1, std::memory_order_relaxed);
    _encodedBytes.fetch_add(accessUnit.length, std::memory_order_relaxed);

    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    double seconds = CMTIME_IS_VALID(pts) ? CMTimeGetSeconds(pts) : 0.0;
    rtc::binary frame(accessUnit.length);
    std::memcpy(frame.data(), accessUnit.bytes, accessUnit.length);

    std::shared_ptr<rtc::Track> track;
    {
        std::lock_guard<std::mutex> lock(_peerMutex);
        track = _track;
    }
    if (track && track->isOpen()) {
        try {
            track->sendFrame(std::move(frame), rtc::FrameInfo(std::chrono::duration<double>(seconds)));
            _sentFrames.fetch_add(1, std::memory_order_relaxed);
        } catch (const std::exception &error) {
            [self sendError:ExceptionMessage(error)];
        }
    }
}

- (void)startStatsThread {
    if (_statsThread.joinable()) return;
    _statsThread = std::thread([self]() {
        uint64_t lastCapture = 0;
        uint64_t lastEncoded = 0;
        uint64_t lastSent = 0;
        uint64_t lastRepeated = 0;
        uint64_t lastDropped = 0;
        uint64_t lastBytes = 0;
        auto lastAt = Clock::now();

        while (!self->_stopping.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            auto now = Clock::now();
            double elapsed = std::max(0.001, std::chrono::duration<double>(now - lastAt).count());
            lastAt = now;

            uint64_t capture = self->_captureFrames.load(std::memory_order_relaxed);
            uint64_t encoded = self->_encodedFrames.load(std::memory_order_relaxed);
            uint64_t sent = self->_sentFrames.load(std::memory_order_relaxed);
            uint64_t repeated = self->_repeatedFrames.load(std::memory_order_relaxed);
            uint64_t dropped = self->_droppedFrames.load(std::memory_order_relaxed);
            uint64_t bytes = self->_encodedBytes.load(std::memory_order_relaxed);

            std::vector<double> durations;
            {
                std::lock_guard<std::mutex> lock(self->_encodeDurationsMutex);
                durations.swap(self->_encodeDurationsMs);
            }
            std::sort(durations.begin(), durations.end());
            double p50 = durations.empty() ? 0.0 : durations[durations.size() / 2];
            double p95 = durations.empty() ? 0.0 : durations[std::min(durations.size() - 1, static_cast<size_t>(std::floor(durations.size() * 0.95)))];
            NSString *fmtp = [self->_codec isEqualToString:@"hevc"]
                ? HevcFmtp(self->_hevcLevelId, self->_hevcTierFlag, self->_hevcTxMode)
                : [self->_codec isEqualToString:@"av1"]
                ? Av1Fmtp(self->_av1Profile, self->_av1LevelIdx, self->_av1Tier)
                : H264Fmtp(self->_h264Profile);

            NSDictionary *stats = @{
                @"backend": @"native-webrtc",
                @"codec": self->_codec,
                @"mimeType": CodecMimeType(self->_codec),
                @"fmtp": fmtp,
                @"colorMode": self->_colorMode,
                @"pixelFormat": FourCharCodeString(self->_capturePixelFormat),
                @"colorRange": ColorRangeForMode(self->_colorMode),
                @"colorPrimaries": @"ITU_R_709_2",
                @"transferFunction": TransferFunctionLabelForMode(self->_colorMode),
                @"yCbCrMatrix": @"ITU_R_709_2",
                @"colorSpaceName": ColorSpaceLabelForMode(self->_colorMode),
                @"width": @(self->_width),
                @"height": @(self->_height),
                @"targetFps": @(self->_frameRate),
                @"targetBitrate": @(self->_bitrate),
                @"captureFps": @((capture - lastCapture) / elapsed),
                @"encodeFps": @((encoded - lastEncoded) / elapsed),
                @"sendFps": @((sent - lastSent) / elapsed),
                @"repeatedFrames": @(repeated),
                @"repeatedFps": @((repeated - lastRepeated) / elapsed),
                @"droppedFrames": @(dropped),
                @"droppedFps": @((dropped - lastDropped) / elapsed),
                @"encodedBitrate": @(((bytes - lastBytes) * 8.0) / elapsed),
                @"encodeP50Ms": @(p50),
                @"encodeP95Ms": @(p95),
                @"keyframes": @(self->_keyframes.load(std::memory_order_relaxed)),
                @"pliCount": @(self->_pliCount.load(std::memory_order_relaxed)),
                @"controlEnabled": @(self->_controlEnabled),
                @"controlDelivery": self->_controlDelivery,
                @"controlTargetPid": @(self->_targetPid),
                @"controlMessages": @(self->_controlMessages.load(std::memory_order_relaxed)),
                @"controlPostedPid": @(self->_controlPostedPid.load(std::memory_order_relaxed)),
                @"controlPostedHid": @(self->_controlPostedHid.load(std::memory_order_relaxed)),
                @"controlDropped": @(self->_controlDropped.load(std::memory_order_relaxed)),
                @"controlPermissionDenied": @(self->_controlPermissionDenied.load(std::memory_order_relaxed)),
                @"controlFocusRequests": @(self->_controlFocusRequests.load(std::memory_order_relaxed)),
                @"controlFocusFailures": @(self->_controlFocusFailures.load(std::memory_order_relaxed)),
                @"controlPostEventAccess": @(HasPostEventAccess(NO)),
                @"captureQueueDepth": @(self->_captureQueueDepth),
                @"maxInFlightFrames": @(self->_maxInFlightFrames),
                @"showCursor": @(self->_showCursor),
                @"realtime": @(self->_realtime),
                @"hardwareAcceleration": @(self->_hardwareAcceleration),
                @"allowFrameReordering": @(self->_allowFrameReordering),
                @"keyframeIntervalSeconds": @(self->_keyframeIntervalSeconds),
                @"maxFrameDelayCount": @(self->_maxFrameDelayCount),
            };
            [self sendSessionEvent:@{@"type": @"stats", @"stats": stats}];

            lastCapture = capture;
            lastEncoded = encoded;
            lastSent = sent;
            lastRepeated = repeated;
            lastDropped = dropped;
            lastBytes = bytes;
        }
    });
}

@end

static void CompressionOutputCallback(
    void *outputCallbackRefCon,
    void *sourceFrameRefCon,
    OSStatus status,
    VTEncodeInfoFlags infoFlags,
    CMSampleBufferRef sampleBuffer
) {
    WindowStreamNativeSession *session = (__bridge WindowStreamNativeSession *)outputCallbackRefCon;
    auto *context = static_cast<EncodeFrameContext *>(sourceFrameRefCon);
    [session handleEncodedSampleBuffer:sampleBuffer status:status infoFlags:infoFlags context:context];
}

@interface NativeHostController : NSObject
- (BOOL)handleMessage:(NSDictionary *)message;
- (void)stopActiveSession;
@end

@implementation NativeHostController {
    WindowStreamNativeSession *_activeSession;
}

- (void)reply:(NSString *)requestId ok:(BOOL)ok fields:(NSDictionary *)fields {
    if (!requestId) return;
    NSMutableDictionary *reply = [@{@"id": requestId, @"ok": @(ok)} mutableCopy];
    if (fields) [reply addEntriesFromDictionary:fields];
    WriteJsonLine(reply);
}

- (void)fail:(NSString *)requestId error:(NSString *)error {
    [self reply:requestId ok:NO fields:@{@"error": error ?: @"Request failed."}];
}

- (BOOL)handleMessage:(NSDictionary *)message {
    NSString *requestId = OptionalString(message[@"id"]);
    NSString *type = OptionalString(message[@"type"]);

    if ([type isEqualToString:@"windows.list"]) {
        NSError *error = nil;
        NSArray<NSDictionary *> *windows = ListWindowsSync(&error);
        if (!windows) {
            [self fail:requestId error:NSErrorMessage(error)];
            return YES;
        }
        [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc", @"windows": windows}];
        return YES;
    }

    if ([type isEqualToString:@"codec.probe"]) {
        [self reply:requestId ok:YES fields:CodecProbeReport()];
        return YES;
    }

    if ([type isEqualToString:@"session.start"]) {
        NSString *sessionId = OptionalString(message[@"sessionId"]);
        if (!sessionId) {
            [self fail:requestId error:@"sessionId is required."];
            return YES;
        }

        [self stopActiveSession];
        NSString *windowId = OptionalString(message[@"windowId"]);
        if (!windowId) {
            NSError *listError = nil;
            NSArray<NSDictionary *> *windows = ListWindowsSync(&listError);
            windowId = OptionalString(windows.firstObject[@"id"]);
        }

        NSError *error = nil;
        SCWindow *window = FindWindowSync(windowId, &error);
        if (!window) {
            [self fail:requestId error:NSErrorMessage(error)];
            return YES;
        }

        NSMutableDictionary *settings = [message mutableCopy];
        NSString *bitrateEnv = OptionalString([NSProcessInfo processInfo].environment[@"WEAVE_WINDOW_STREAM_BITRATE"]);
        if (!settings[@"bitrate"]) settings[@"bitrate"] = @(bitrateEnv ? bitrateEnv.integerValue : 12000000);
        NSString *codec = NormalizeCodecName(settings[@"codec"]);
        BOOL requireHardware = OptionalBool(settings[@"hardwareAcceleration"], YES) || [codec isEqualToString:@"av1"];
        NSDictionary *probe = ProbeCodec(codec, requireHardware);
        BOOL available = requireHardware
            ? [probe[@"hardwareRequiredAvailable"] boolValue]
            : [probe[@"defaultAvailable"] boolValue];
        if (!available) {
            [self fail:requestId error:[NSString stringWithFormat:@"VideoToolbox %@ encoder is unavailable: hardware-required status=%@ default status=%@",
                                                                  codec,
                                                                  probe[@"hardwareRequiredStatus"],
                                                                  probe[@"defaultStatus"]]];
            return YES;
        }

        _activeSession = [[WindowStreamNativeSession alloc] initWithSessionId:sessionId
                                                                       window:window
                                                                     settings:settings];
        @try {
            [_activeSession createOfferWithIceServers:OptionalArray(message[@"iceServers"]) ?: @[]];
            [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc", @"windowId": WindowIdString(window)}];
        } @catch (NSException *exception) {
            [_activeSession stop];
            _activeSession = nil;
            [self fail:requestId error:exception.reason ?: @"Failed to create native WebRTC offer."];
        }
        return YES;
    }

    if ([type isEqualToString:@"session.answer"]) {
        if (!_activeSession) {
            [self fail:requestId error:@"No active window stream session."];
            return YES;
        }
        NSError *error = nil;
        if (![_activeSession applyAnswer:OptionalDictionary(message[@"answer"]) ?: @{} error:&error]) {
            [self fail:requestId error:NSErrorMessage(error)];
            return YES;
        }
        [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc"}];
        return YES;
    }

    if ([type isEqualToString:@"session.ice-candidate"]) {
        if (_activeSession) [_activeSession addIceCandidate:OptionalDictionary(message[@"candidate"]) ?: @{}];
        [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc"}];
        return YES;
    }

    if ([type isEqualToString:@"session.ready"]) {
        [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc"}];
        return YES;
    }

    if ([type isEqualToString:@"session.stop"]) {
        [self stopActiveSession];
        [self reply:requestId ok:YES fields:@{@"backend": @"native-webrtc"}];
        return YES;
    }

    if ([type isEqualToString:@"shutdown"]) {
        [self stopActiveSession];
        [self reply:requestId ok:YES fields:nil];
        return NO;
    }

    [self fail:requestId error:@"Unsupported command."];
    return YES;
}

- (void)stopActiveSession {
    if (!_activeSession) return;
    [_activeSession stop];
    _activeSession = nil;
}

@end

static NSDictionary *ParseJsonLine(const std::string &line, NSError **outError) {
    NSData *data = [NSData dataWithBytes:line.data() length:line.size()];
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:outError];
    return OptionalDictionary(parsed);
}

int main(int, char **) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        rtc::InitLogger(rtc::LogLevel::Warning);

        NativeHostController *controller = [[NativeHostController alloc] init];
        std::string line;
        while (std::getline(std::cin, line)) {
            @autoreleasepool {
                if (line.empty()) continue;
                NSError *error = nil;
                NSDictionary *message = ParseJsonLine(line, &error);
                if (!message) {
                    WriteDiagnostic([NSString stringWithFormat:@"invalid json: %@", NSErrorMessage(error)]);
                    continue;
                }
                if (![controller handleMessage:message]) break;
            }
        }
        [controller stopActiveSession];
    }
    return 0;
}

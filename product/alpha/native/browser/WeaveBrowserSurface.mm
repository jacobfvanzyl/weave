#import "WeaveBrowserSurface.h"
#import <QuartzCore/QuartzCore.h>
#import <rfb/rfbclient.h>
#import "WeaveBrowserProtocol.h"
#include <sys/socket.h>
#include <unistd.h>
#include <time.h>
static double browserThreadCPU(void) { struct timespec t; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t); return t.tv_sec + t.tv_nsec / 1e9; }

#if TARGET_OS_OSX
@interface BrowserPixelView : NSView
@end
@implementation BrowserPixelView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end
#else
@interface BrowserPixelView : UIView
@end
@implementation BrowserPixelView
@end
#endif
@interface WeaveBrowserSurface ()
@property(nonatomic, readwrite) WeaveBrowserView *view;
@property(nonatomic, copy) void (^event)(NSDictionary *);
@property(nonatomic) NSURLSession *session;
@property(nonatomic) NSURLSessionWebSocketTask *socket;
@property(atomic) BOOL stopped;
@property(nonatomic) BOOL ready;
@property(nonatomic) int networkFD;
@property(nonatomic) int decoderFD;
@property(nonatomic) NSData *latestPixels;
@property(nonatomic) int latestWidth, latestHeight, reportedWidth, reportedHeight;
@property(nonatomic) BOOL presentationQueued;
// Opt-in bounded profiling; contains timing/counts only, never page data.
@property(nonatomic) BOOL diagnostics;
@property(nonatomic) NSMutableArray *samples;
@property(nonatomic) double previousPresentation, lastDiagnosticWrite;
@property(nonatomic) double latestCopyMs, latestCopiedAt, decodeCPU;
@property(nonatomic) uint64_t receivedBytes, updates;
@end
static void *clientTag = &clientTag;
static rfbBool allocatePixels(rfbClient *client) {
  if (client->width < 1 || client->height < 1 || client->width > 4096 || client->height > 4096 || (uint64_t)client->width * client->height > 8 * 1024 * 1024) return FALSE;
  void *pixels = calloc((size_t)client->width * client->height, 4);
  if (!pixels) return FALSE;
  free(client->frameBuffer); client->frameBuffer = (uint8_t *)pixels;
  return TRUE;
}
static void presentPixels(rfbClient *client) {
  WeaveBrowserSurface *surface = (__bridge WeaveBrowserSurface *)rfbClientGetClientData(client, clientTag);
  if (surface.stopped) return;
  double copyAt = surface.diagnostics ? CACurrentMediaTime() : 0;
  @synchronized(surface) {
    surface.latestPixels = [NSData dataWithBytes:client->frameBuffer length:(NSUInteger)client->width * client->height * 4];
    surface.latestWidth = client->width; surface.latestHeight = client->height;
    surface.updates++;
    if (surface.diagnostics) { surface.latestCopiedAt = CACurrentMediaTime(); surface.latestCopyMs = (surface.latestCopiedAt - copyAt) * 1000; }
    if (surface.presentationQueued) return;
    surface.presentationQueued = YES;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSData *pixels; int width, height; double copyMs, copiedAt, cpu; uint64_t bytes, updates;
    @synchronized(surface) {
      pixels = surface.latestPixels; width = surface.latestWidth; height = surface.latestHeight;
      surface.latestPixels = nil; surface.presentationQueued = NO;
      copyMs = surface.latestCopyMs; copiedAt = surface.latestCopiedAt; cpu = surface.decodeCPU; bytes = surface.receivedBytes; updates = surface.updates;
    }
    if (surface.stopped || !pixels) return;
    double mainAt = surface.diagnostics ? CACurrentMediaTime() : 0;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)pixels);
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, color, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst, provider, NULL, NO, kCGRenderingIntentDefault);
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    surface.view.layer.contents = (__bridge id)image;
    [CATransaction commit];
    // The shell needs readiness/resize acknowledgements, not a callback per frame.
    if (width != surface.reportedWidth || height != surface.reportedHeight) {
      surface.reportedWidth = width; surface.reportedHeight = height;
      if (surface.event) surface.event(@{@"kind":@"frame", @"width":@(width), @"height":@(height)});
    }
    CGImageRelease(image); CGColorSpaceRelease(color); CGDataProviderRelease(provider);
    if (surface.diagnostics) {
      [surface.samples addObject:@{@"time":@(mainAt), @"intervalMs":@(surface.previousPresentation ? (mainAt-surface.previousPresentation)*1000 : 0), @"copyMs":@(copyMs), @"mainQueueMs":@((mainAt-copiedAt)*1000), @"submitMs":@((CACurrentMediaTime()-mainAt)*1000), @"decodeCPUSeconds":@(cpu), @"receivedBytes":@(bytes), @"updates":@(updates), @"width":@(width), @"height":@(height)}];
      surface.previousPresentation = mainAt;
      if (surface.samples.count > 300) [surface.samples removeObjectAtIndex:0];
      if (mainAt-surface.lastDiagnosticWrite > 5) {
        surface.lastDiagnosticWrite = mainAt;
        NSData *report = [NSJSONSerialization dataWithJSONObject:surface.samples options:0 error:nil];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{ [report writeToFile:[NSTemporaryDirectory() stringByAppendingPathComponent:@"weave-browser-performance.json"] atomically:YES]; });
      }
    }
  });
}
@implementation WeaveBrowserSurface
- (instancetype)initWithEvent:(void (^)(NSDictionary *))event {
  if ((self = [super init])) {
    _event = [event copy]; _networkFD = -1; _decoderFD = -1;
    _diagnostics = [NSProcessInfo.processInfo.environment[@"WEAVE_BROWSER_DIAGNOSTICS"] isEqual:@"1"];
    if (_diagnostics) _samples = [NSMutableArray array];
    _view = [[BrowserPixelView alloc] initWithFrame:CGRectZero];
#if TARGET_OS_OSX
    _view.wantsLayer = YES;
#else
    _view.userInteractionEnabled = NO;
#endif
    _view.hidden = YES;
    _view.layer.masksToBounds = YES;
    _view.layer.contentsGravity = kCAGravityResizeAspect;
    _view.layer.magnificationFilter = kCAFilterNearest;
    _view.layer.minificationFilter = kCAFilterNearest;
  }
  return self;
}
- (void)report:(NSDictionary *)event {
  dispatch_async(dispatch_get_main_queue(), ^{ if (!self.stopped && self.event) self.event(event); });
}
- (void)fail:(NSString *)reason {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.stopped) return;
    if (self.event) self.event(@{@"kind":@"error", @"message":reason});
    [self close];
  });
}
- (void)connect:(NSString *)address {
  NSURL *url = [NSURL URLWithString:address];
  if (self.socket || self.stopped || ![@[@"ws",@"wss"] containsObject:url.scheme] || ![url.path isEqual:@"/browser/rfb"] || url.user || url.password || url.query || url.fragment) { [self fail:@"Invalid Browser display connection"]; return; }
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) { [self fail:@"Could not create native decoder transport"]; return; }
  self.networkFD = pair[0]; self.decoderFD = pair[1];
  int enabled = 1;
  setsockopt(pair[0], SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
  setsockopt(pair[1], SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
  self.session = [NSURLSession sessionWithConfiguration:NSURLSessionConfiguration.ephemeralSessionConfiguration];
  self.socket = [self.session webSocketTaskWithURL:url protocols:@[WEAVE_BROWSER_WEBSOCKET_PROTOCOL]];
  self.socket.maximumMessageSize = 4 * 1024 * 1024;
  [self.socket resume]; [self receive];
  __weak WeaveBrowserSurface *weak = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ WeaveBrowserSurface *strong = weak; if (strong && !strong.ready && !strong.stopped) [strong fail:@"Browser display attachment timed out"]; });
}
- (void)receive {
  if (self.stopped) return;
  [self.socket receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    if (self.stopped) return;
    if (error) { [self fail:@"Browser display disconnected"]; return; }
    if (message.type == NSURLSessionWebSocketMessageTypeString) {
      NSData *data = [message.string dataUsingEncoding:NSUTF8StringEncoding];
      NSDictionary *value = data.length < 65536 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if (![value isKindOfClass:NSDictionary.class] || self.ready) { [self fail:@"Invalid Browser display control message"]; return; }
      if ([value[@"type"] isEqual:@"browser.rfb.ready"]) { self.ready = YES; [self startDecoder]; }
      else [self report:@{@"kind":@"control", @"message":value}];
      [self receive]; return;
    }
    if (!self.ready) { [self fail:@"Browser pixels arrived before authorization"]; return; }
    if (self.diagnostics) { @synchronized(self) { self.receivedBytes += message.data.length; } }
    // Receive the next WebSocket message only after this one enters the bounded socket buffer.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      const uint8_t *bytes = (const uint8_t *)message.data.bytes; NSUInteger left = message.data.length;
      while (left && !self.stopped) { ssize_t count = write(self.networkFD, bytes, left); if (count <= 0) { [self fail:@"Native decoder transport ended"]; return; } bytes += count; left -= count; }
      [self receive];
    });
  }];
}
- (void)sendControl:(NSString *)json {
  if (self.stopped || self.ready || json.length > 65536) return;
  NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (![value isKindOfClass:NSDictionary.class] || ![@[@"weave.portal.auth.response",@"browser.rfb.bind"] containsObject:value[@"type"]]) { [self fail:@"Invalid Browser authorization response"]; return; }
  [self.socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:json] completionHandler:^(NSError *error) { if (error) [self fail:@"Browser authorization failed"]; }];
}
- (void)startDecoder {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      rfbClient *client = rfbGetClient(8,3,4);
      client->sock = dup(self.decoderFD); client->listenSpecified = TRUE;
      client->appData.shareDesktop = TRUE; client->appData.useRemoteCursor = TRUE;
      client->appData.encodingsString = "zrle hextile raw";
      client->canHandleNewFBSize = TRUE;
      client->format.redShift = 16; client->format.greenShift = 8; client->format.blueShift = 0; client->format.bigEndian = FALSE;
      client->MallocFrameBuffer = allocatePixels; client->FinishedFrameBufferUpdate = presentPixels;
      client->readTimeout = 10;
      rfbClientSetClientData(client, clientTag, (__bridge void *)self);
      int argc = 1; char name[] = "Weave Browser"; char *argv[] = {name, NULL};
      if (!rfbInitClient(client, &argc, argv)) { [self fail:@"Native RFB initialization failed"]; return; }
      while (!self.stopped) { @autoreleasepool {
        int ready = WaitForMessage(client, 20000); if (ready < 0) break;
        if (ready > 0) {
          double cpu = self.diagnostics ? browserThreadCPU() : 0;
          BOOL handled = HandleRFBServerMessage(client);
          if (self.diagnostics) { @synchronized(self) { self.decodeCPU += browserThreadCPU() - cpu; } }
          if (!handled) break;
        }
      } }
      free(client->frameBuffer); client->frameBuffer = NULL; rfbClientCleanup(client);
      if (!self.stopped) [self fail:@"Native RFB display ended"];
    }
  });
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      uint8_t bytes[65536];
      while (!self.stopped) {
        ssize_t length = read(self.networkFD, bytes, sizeof(bytes)); if (length <= 0) break;
        dispatch_semaphore_t sent = dispatch_semaphore_create(0);
        [self.socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithData:[NSData dataWithBytes:bytes length:length]] completionHandler:^(NSError *error) { if (error) [self fail:@"Browser display request failed"]; dispatch_semaphore_signal(sent); }];
        if (dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) { [self fail:@"Browser display request timed out"]; break; }
      }
    }
  });
}
- (void)layout:(CGRect)frame visible:(BOOL)visible dim:(double)dim {
  self.view.frame = frame; self.view.hidden = !visible || self.stopped;
  self.view.layer.opacity = 1 - fmax(0, fmin(0.8, dim));
}
- (void)close {
  if (self.stopped) return;
  self.stopped = YES;
  if (self.networkFD >= 0) shutdown(self.networkFD, SHUT_RDWR);
  if (self.decoderFD >= 0) shutdown(self.decoderFD, SHUT_RDWR);
  [self.socket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
  [self.session invalidateAndCancel]; self.socket = nil; self.session = nil;
  self.view.layer.contents = nil; [self.view removeFromSuperview]; self.event = nil;
  @synchronized(self) { self.latestPixels = nil; }
}
- (void)dealloc { if (_networkFD >= 0) close(_networkFD); if (_decoderFD >= 0) close(_decoderFD); }
@end

// Native presentation harness. LibVNCClient owns RFB parsing and lossless
// decoding.
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <TargetConditionals.h>
#include <time.h>
static double threadCPU(void) { struct timespec t; clock_gettime(CLOCK_THREAD_CPUTIME_ID,&t); return t.tv_sec+t.tv_nsec/1e9; }
#import <rfb/rfbclient.h>
#if TARGET_OS_OSX
#import <AppKit/AppKit.h>
#else
#import <UIKit/UIKit.h>
#endif
@interface Receiver : NSObject
@property(atomic) BOOL running;
@property(nonatomic) BOOL presenting;
@property(nonatomic) NSMutableArray *commands;
@property(nonatomic, copy) void (^present)(CGImageRef, NSString *);
@property(nonatomic) NSUInteger updates, presentations;
- (void)start:(NSString *)host port:(int)port;
- (void)command:(NSString *)name;
@end
#include "BenchRFB.h"
static void *tag = &tag;
static rfbBool allocate(rfbClient *c) {
  if (c->width < 1 || c->height < 1 || c->width > 4096 || c->height > 4096)
    return FALSE;
  free(c->frameBuffer);
  c->frameBuffer = calloc((size_t)c->width * c->height, 4);
  return c->frameBuffer != NULL;
}
static void finished(rfbClient *c) {
  Receiver *r = (__bridge Receiver *)rfbClientGetClientData(c, tag);
  r.updates++;
  benchFrame(c);
  if (NSProcessInfo.processInfo.environment[@"BENCH_NO_PRESENT"].boolValue) return;
  @synchronized(r) {
    if (r.presenting) {
      printf("{\"event\":\"presentation-skipped\",\"t\":%.6f,\"phase\":%d}\n",benchNow(),benchPhase);
      return;
    }
    r.presenting = YES;
  }
  int w = c->width, h = c->height;
  uint32_t marker = ((uint32_t *)c->frameBuffer)[w * h - 2] & 0xffffff,
           toggle = ((uint32_t *)c->frameBuffer)[w * h - 1] & 0xffffff;
  double copyAt=benchNow();
  NSData *data = [NSData dataWithBytes:c->frameBuffer
                                length:(NSUInteger)w * h * 4];
  double copiedAt=benchNow(); int phase=benchPhase;
  NSUInteger update = r.updates;
  dispatch_async(dispatch_get_main_queue(), ^{
    double mainAt=benchNow();
    CGDataProviderRef provider =
        CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image =
        CGImageCreate(w, h, 8, 32, w * 4, color,
                      kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst,
                      provider, NULL, NO, kCGRenderingIntentDefault);
    r.presentations++;
    NSString *status = [NSString
        stringWithFormat:
            @"%d × %d · %lu updates · %lu presented · marker %u · toggle %u", w,
            h, (unsigned long)update, (unsigned long)r.presentations, marker,
            toggle];
    if (r.present)
      r.present(image, status);
    if (r.presentations % 30 == 1) {
      printf("{\"event\":\"present\",\"width\":%d,\"height\":%d,\"updates\":%"
             "lu,\"presentations\":%lu,\"marker\":%u,\"toggle\":%u}\n",
             w, h, (unsigned long)update, (unsigned long)r.presentations,
             marker, toggle);
      fflush(stdout);
    }
    printf("{\"event\":\"presentation-cost\",\"t\":%.6f,\"phase\":%d,\"copyMs\":%.3f,\"queueMs\":%.3f,\"submitMs\":%.3f}\n",mainAt,phase,(copiedAt-copyAt)*1000,(mainAt-copiedAt)*1000,(benchNow()-mainAt)*1000);
    CGImageRelease(image);
    CGColorSpaceRelease(color);
    CGDataProviderRelease(provider);
    @synchronized(r) {
      r.presenting = NO;
    }
  });
}
@implementation Receiver
- (instancetype)init {
  if ((self = [super init]))
    _commands = [NSMutableArray array];
  return self;
}
- (void)command:(NSString *)name {
  @synchronized(self) {
    [self.commands addObject:name];
  }
}
- (void)start:(NSString *)host port:(int)port {
  if (self.running)
    return;
  self.running = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 115 * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{ printf("{\"event\":\"wall-clock-timeout\"}\n"); fflush(stdout); exit(5); });
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      rfbClient *c = rfbGetClient(8, 3, 4);
      c->serverHost = strdup(host.UTF8String);
      c->serverPort = port;
      c->appData.shareDesktop = TRUE;
      c->appData.useRemoteCursor = TRUE;
      c->appData.encodingsString = "zrle hextile raw";
      c->canHandleNewFBSize = TRUE;
      c->format.redShift = 16;
      c->format.greenShift = 8;
      c->format.blueShift = 0;
      c->format.bigEndian = FALSE;
      c->MallocFrameBuffer = allocate;
      c->FinishedFrameBufferUpdate = finished;
      c->connectTimeout = 5;
      c->readTimeout = DEFAULT_READ_TIMEOUT; // Use upstream default; outer experiment has a wall-clock deadline.
      rfbClientSetClientData(c, tag, (__bridge void *)self);
      int argc = 1;
      char *argv[] = {"RFBSpike", NULL};
      if (!rfbInitClient(c, &argc, argv)) {
        self.running = NO;
        printf("{\"event\":\"connect-failed\"}\n");
        fflush(stdout);
        return;
      }
      // Public Apple TCP option; experiment-only A/B switch. No parser or decoder changes.
      if (NSProcessInfo.processInfo.environment[@"BENCH_MORE_ACKS"].boolValue) {
        int enabled=1;
        int result=setsockopt(c->sock,IPPROTO_TCP,TCP_SENDMOREACKS,&enabled,sizeof(enabled));
        int error=result==0?0:errno,actual=0; socklen_t length=sizeof(actual);
        int readback=getsockopt(c->sock,IPPROTO_TCP,TCP_SENDMOREACKS,&actual,&length);
        printf("{\"event\":\"socket-option\",\"name\":\"TCP_SENDMOREACKS\",\"result\":%d,\"errno\":%d,\"readbackResult\":%d,\"value\":%d}\n",result,error,readback,actual);
        if (result!=0 || readback!=0 || actual!=1) exit(6);
      }
      printf("{\"event\":\"connected\",\"audio\":false}\n");
      fflush(stdout);
      while (self.running) {
        @autoreleasepool {
          NSArray *commands;
          @synchronized(self) {
            commands = [self.commands copy];
            [self.commands removeAllObjects];
          }
          for (NSString *cmd in commands) {
            if ([cmd isEqual:@"click"]) {
              SendPointerEvent(c, 50, 60, 1);
              SendPointerEvent(c, 50, 60, 0);
            } else if ([cmd isEqual:@"focus"]) {
#if TARGET_OS_OSX
              SendExtDesktopSize(c, 1000, 700);
#else
SendExtDesktopSize(c,800,1000);
#endif
            } else if ([cmd isEqual:@"disconnect"]) {
              self.running = NO;
            }
          }
          if (!self.running)
            break;
          benchTick(c);
          double waitAt=benchNow();
          int ready = WaitForMessage(c, 5000);
          double handleAt=benchNow();
          if (ready < 0) break;
          if (ready > 0) {
            double cpuAt=threadCPU();
            BOOL ok=HandleRFBServerMessage(c);
            double cpuMs=(threadCPU()-cpuAt)*1000;
            printf("{\"event\":\"receive-cost\",\"t\":%.6f,\"phase\":%d,\"waitMs\":%.3f,\"handleMs\":%.3f,\"handleCpuMs\":%.3f}\n",handleAt,benchPhase,(handleAt-waitAt)*1000,(benchNow()-handleAt)*1000,cpuMs);
            if (!ok) break;
          }
        }
      }
      free(c->frameBuffer);
      c->frameBuffer = NULL;
      rfbClientCleanup(c);
      self.running = NO;
      printf("{\"event\":\"disconnected\"}\n");
      fflush(stdout);
    }
  });
}
@end
#if TARGET_OS_OSX
@interface App : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSImageView *image;
@property NSTextField *status;
@property Receiver *receiver;
@property NSString *host;
@property int port;
@end
@implementation App
- (void)applicationDidFinishLaunching:(NSNotification *)n {
  self.host =
      NSProcessInfo.processInfo.environment[@"RFB_HOST"] ?: @"127.0.0.1";
  self.port =
      [NSProcessInfo.processInfo.environment[@"RFB_PORT"] ?: @"15910" intValue];
  self.receiver = [Receiver new];
  self.window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(50, 100, 1050, 800)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"RFB Framebuffer Spike";
  NSView *v = self.window.contentView;
  self.image = [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, 1050, 730)];
  self.image.imageScaling = NSImageScaleProportionallyUpOrDown;
  self.image.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [v addSubview:self.image];
  self.status = [NSTextField labelWithString:@"Connecting…"];
  self.status.frame = NSMakeRect(15, 735, 1000, 22);
  self.status.autoresizingMask = NSViewMinYMargin | NSViewWidthSizable;
  [v addSubview:self.status];
  NSArray *titles =
      @[ @"Reconnect", @"Disconnect", @"Claim viewport", @"Test click" ];
  NSArray *actions = @[
    NSStringFromSelector(@selector(reconnect)),
    NSStringFromSelector(@selector(disconnect)),
    NSStringFromSelector(@selector(focus)),
    NSStringFromSelector(@selector(click))
  ];
  for (int i = 0; i < 4; i++) {
    NSButton *b = [NSButton buttonWithTitle:titles[i]
                                     target:self
                                     action:NSSelectorFromString(actions[i])];
    b.frame = NSMakeRect(15 + i * 150, 765, 140, 26);
    b.autoresizingMask = NSViewMinYMargin;
    [v addSubview:b];
  }
  __weak App *weak = self;
  self.receiver.present = ^(CGImageRef image, NSString *status) {
    weak.image.image = [[NSImage alloc] initWithCGImage:image size:NSZeroSize];
    weak.status.stringValue = status;
  };
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self reconnect];
}
- (void)reconnect {
  [self.receiver start:self.host port:self.port];
}
- (void)disconnect {
  [self.receiver command:@"disconnect"];
}
- (void)focus {
  [self.receiver command:@"focus"];
}
- (void)click {
  [self.receiver command:@"click"];
}
@end
int main() {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    App *delegate = [App new];
    app.delegate = delegate;
    [app run];
  }
}
#else
@interface App : UIResponder <UIApplicationDelegate>
@property UIWindow *window;
@property UIImageView *image;
@property UILabel *status;
@property Receiver *receiver;
@property NSString *host;
@property int port;
@end
@implementation App
- (BOOL)application:(UIApplication *)app
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.host =
      NSProcessInfo.processInfo.environment[@"RFB_HOST"] ?: @"100.79.27.114";
  self.port =
      [NSProcessInfo.processInfo.environment[@"RFB_PORT"] ?: @"15910" intValue];
  self.receiver = [Receiver new];
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *vc = [UIViewController new];
  self.window.rootViewController = vc;
  UIView *v = vc.view;
  v.backgroundColor = UIColor.systemBackgroundColor;
  self.image = [UIImageView new];
  self.image.contentMode = UIViewContentModeScaleAspectFit;
  self.image.translatesAutoresizingMaskIntoConstraints = NO;
  [v addSubview:self.image];
  self.status = [UILabel new];
  self.status.text = @"Connecting…";
  self.status.font = [UIFont monospacedSystemFontOfSize:12
                                                 weight:UIFontWeightRegular];
  self.status.numberOfLines = 2;
  self.status.translatesAutoresizingMaskIntoConstraints = NO;
  [v addSubview:self.status];
  UIStackView *buttons = [UIStackView new];
  buttons.axis = UILayoutConstraintAxisHorizontal;
  buttons.distribution = UIStackViewDistributionFillEqually;
  buttons.spacing = 10;
  buttons.translatesAutoresizingMaskIntoConstraints = NO;
  NSArray *titles =
      @[ @"Reconnect", @"Disconnect", @"Claim viewport", @"Test click" ];
  NSArray *actions = @[
    NSStringFromSelector(@selector(reconnect)),
    NSStringFromSelector(@selector(disconnect)),
    NSStringFromSelector(@selector(focus)),
    NSStringFromSelector(@selector(click))
  ];
  for (int i = 0; i < 4; i++) {
    UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
    [b setTitle:titles[i] forState:UIControlStateNormal];
    [b addTarget:self
                  action:NSSelectorFromString(actions[i])
        forControlEvents:UIControlEventTouchUpInside];
    [buttons addArrangedSubview:b];
  }
  [v addSubview:buttons];
  [NSLayoutConstraint activateConstraints:@[
    [buttons.topAnchor constraintEqualToAnchor:v.safeAreaLayoutGuide.topAnchor
                                      constant:8],
    [buttons.leadingAnchor constraintEqualToAnchor:v.leadingAnchor constant:12],
    [buttons.trailingAnchor constraintEqualToAnchor:v.trailingAnchor
                                           constant:-12],
    [buttons.heightAnchor constraintEqualToConstant:44],
    [self.status.topAnchor constraintEqualToAnchor:buttons.bottomAnchor
                                          constant:8],
    [self.status.leadingAnchor constraintEqualToAnchor:buttons.leadingAnchor],
    [self.status.trailingAnchor constraintEqualToAnchor:buttons.trailingAnchor],
    [self.image.topAnchor constraintEqualToAnchor:self.status.bottomAnchor
                                         constant:8],
    [self.image.leadingAnchor constraintEqualToAnchor:v.leadingAnchor],
    [self.image.trailingAnchor constraintEqualToAnchor:v.trailingAnchor],
    [self.image.bottomAnchor
        constraintEqualToAnchor:v.safeAreaLayoutGuide.bottomAnchor]
  ]];
  __weak App *weak = self;
  self.receiver.present = ^(CGImageRef image, NSString *status) {
    weak.image.image = [UIImage imageWithCGImage:image];
    weak.status.text = status;
  };
  [self.window makeKeyAndVisible];
  [self reconnect];
  return YES;
}
- (void)reconnect {
  [self.receiver start:self.host port:self.port];
}
- (void)disconnect {
  [self.receiver command:@"disconnect"];
}
- (void)focus {
  [self.receiver command:@"focus"];
}
- (void)click {
  [self.receiver command:@"click"];
}
- (void)applicationDidEnterBackground:(UIApplication *)app {
  [self disconnect];
}
@end
int main(int argc, char **argv) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class));
  }
}
#endif

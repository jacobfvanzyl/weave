#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <rfb/rfbclient.h>
#include <time.h>
static int frames = 0;
static rfbBool allocate(rfbClient *c) {
  if (c->width < 1 || c->height < 1 || c->width > 4096 || c->height > 4096)
    return FALSE;
  free(c->frameBuffer);
  c->frameBuffer = calloc((size_t)c->width * c->height, 4);
  return c->frameBuffer != NULL;
}
static void done(rfbClient *c) { frames++; }
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 5)
      return 2;
    rfbClient *c = rfbGetClient(8, 3, 4);
    c->serverHost = strdup(argv[1]);
    c->serverPort = atoi(argv[2]);
    c->appData.shareDesktop = TRUE;
    c->appData.useRemoteCursor = TRUE;
    c->appData.encodingsString = "zrle hextile raw";
    c->canHandleNewFBSize = TRUE;
    c->format.redShift = 16;
    c->format.greenShift = 8;
    c->format.blueShift = 0;
    c->format.bigEndian = FALSE;
    c->MallocFrameBuffer = allocate;
    c->FinishedFrameBufferUpdate = done;
    c->connectTimeout = 5;
    c->readTimeout = 5;
    int ac = 1;
    if (!rfbInitClient(c, &ac, argv))
      return 3;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:atof(argv[3])];
    BOOL clicked = NO;
    while ([deadline timeIntervalSinceNow] > 0) {
      int ready = WaitForMessage(c, 20000);
      if (ready < 0 || (ready > 0 && !HandleRFBServerMessage(c)))
        break;
      if (argc > 5 && !clicked && frames > 0) {
        if (!strcmp(argv[5], "click")) {
          SendPointerEvent(c, 50, 60, 1);
          SendPointerEvent(c, 50, 60, 0);
        } else if (!strcmp(argv[5], "resize")) {
          SendExtDesktopSize(c, 1000, 700);
        }
        clicked = YES;
      }
    }
    if (!frames)
      return 4;
    NSData *data = [NSData dataWithBytes:c->frameBuffer
                                  length:(NSUInteger)c->width * c->height * 4];
    CGDataProviderRef provider =
        CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef image =
        CGImageCreate(c->width, c->height, 8, 32, c->width * 4, cs,
                      kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst,
                      provider, NULL, NO, kCGRenderingIntentDefault);
    NSURL *path =
        [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[4]]];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(
        (__bridge CFURLRef)path, CFSTR("public.png"), 1, NULL);
    CGImageDestinationAddImage(dest, image, NULL);
    BOOL ok = CGImageDestinationFinalize(dest);
    printf("{\"frames\":%d,\"width\":%d,\"height\":%d,\"saved\":%s}\n", frames,
           c->width, c->height, ok ? "true" : "false");
    CFRelease(dest);
    CGImageRelease(image);
    CGColorSpaceRelease(cs);
    CGDataProviderRelease(provider);
    free(c->frameBuffer);
    c->frameBuffer = NULL;
    rfbClientCleanup(c);
    return ok ? 0 : 1;
  }
}

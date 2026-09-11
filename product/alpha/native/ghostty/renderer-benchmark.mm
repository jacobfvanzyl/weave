#import "WeaveTerminalRenderer.h"
#import <Foundation/Foundation.h>
#include <time.h>
#include <sys/resource.h>
int main(int argc, char **argv) { @autoreleasepool {
  [WeaveTerminalRenderer registerFontsAtURL:[NSURL fileURLWithPath:argc > 2 ? @(argv[2]) : @"src/assets/fonts/TerminalFonts"]];
  WeaveTerminalRenderer *r = [WeaveTerminalRenderer make]; if (!r) return 1;
  [r resizeToSize:CGSizeMake(1000,600)];
  CGColorSpaceRef space=CGColorSpaceCreateDeviceRGB(); CGContextRef ctx=CGBitmapContextCreate(NULL,1000,600,8,4000,space,kCGImageAlphaPremultipliedLast); CGColorSpaceRelease(space);
  CGContextTranslateCTM(ctx,0,600); CGContextScaleCTM(ctx,1,-1);
  NSString *mode=argc>1?@(argv[1]):@"hidden";
  NSData *line=[@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 界 é 👩🏽‍💻\r\n" dataUsingEncoding:NSUTF8StringEncoding];
  NSData *row=[@"\033[HabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" dataUsingEncoding:NSUTF8StringEncoding];
  NSData *cursor=[@"\033[H\033[C" dataUsingEncoding:NSUTF8StringEncoding];
  clock_t start=clock(); double wall=CFAbsoluteTimeGetCurrent();
  int count=[mode isEqualToString:@"hidden"]?10000:1000;
  for(int i=0;i<count;i++) { @autoreleasepool {
    [r consume:[mode isEqualToString:@"cursor"]?cursor:[mode isEqualToString:@"row"]?row:line reset:NO];
    if (![mode isEqualToString:@"hidden"]) { [r drawInContext:ctx size:CGSizeMake(1000,600)]; if ([mode isEqualToString:@"text"]) (void)r.visibleText; }
  } }
  struct rusage usage;getrusage(RUSAGE_SELF,&usage);
  printf("{\"scenario\":\"%s\",\"iterations\":%d,\"cpuMs\":%.3f,\"wallMs\":%.3f,\"peakRssBytes\":%ld}\n",mode.UTF8String,count,1000.0*(clock()-start)/CLOCKS_PER_SEC,1000*(CFAbsoluteTimeGetCurrent()-wall),usage.ru_maxrss);
  CGContextRelease(ctx);
} }

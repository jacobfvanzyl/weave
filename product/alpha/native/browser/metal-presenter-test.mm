// Real GPU readback through CAMetalLayer, including repeated Retina-sized resize.
#import <AppKit/AppKit.h>
#import "WeaveBrowserMetalPresenter.h"
static NSWindow *window;
static WeaveBrowserMetalPresenter *presenter;
static int frame;
static void nextFrame() {
  if (frame == 40) { puts("Metal: 40 resized frames, exact RGB and opaque alpha"); [presenter close]; exit(0); }
  int widths[] = {2000,800,1862,1200}, heights[] = {1600,1000,1502,800};
  int width=widths[frame%4], height=heights[frame%4];
  [window setContentSize:NSMakeSize(width/2,height/2)];
  NSMutableData *data=[NSMutableData dataWithLength:(NSUInteger)width*height*4];
  uint8_t *p=(uint8_t *)data.mutableBytes;
  for(int y=0;y<height;y++)for(int x=0;x<width;x++){
    size_t at=((size_t)y*width+x)*4;
    p[at]=(x+frame)%256;p[at+1]=(y+frame)%256;p[at+2]=(x/11+y/13)%256;p[at+3]=0;
  }
  [presenter present:data width:width height:height submitted:^{
    NSDictionary *m=presenter.lastMetrics;
    if(m[@"error"] || [m[@"differentPixels"] unsignedLongLongValue] || [m[@"verifiedPixels"] unsignedLongLongValue]!=(uint64_t)width*height){ NSLog(@"Metal verification failed: %@",m);exit(1); }
    frame++;dispatch_async(dispatch_get_main_queue(),^{nextFrame();});
  }];
}
int main(int argc,char **argv){@autoreleasepool{
  setenv("WEAVE_BROWSER_DIAGNOSTICS","1",1);setenv("WEAVE_BROWSER_METAL_VERIFY","1",1);
  if(argc>1 && !strcmp(argv[1],"--failure"))setenv("WEAVE_BROWSER_METAL_FAILURE","1",1);
  [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,1000,800) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  window.contentView.wantsLayer=YES;[window orderFront:nil];
  presenter=[[WeaveBrowserMetalPresenter alloc]initWithLayer:window.contentView.layer];if(!presenter)return 2;
  if(getenv("WEAVE_BROWSER_METAL_FAILURE")){
    // Several decoded updates may arrive before a failed command reports back.
    // The fallback callback must refer to the newest one, even if no more arrive.
    for(int n=1;n<=3;n++){
      NSData *pixels=[NSData dataWithBytes:(uint32_t[]){0x112233,0x445566,0x778899,0xaabbcc} length:16];
      [presenter present:pixels width:2 height:2 submitted:^{
        if(n!=3 || !presenter.lastMetrics[@"error"])exit(4);
        puts("Metal failure: newest static frame selected for fallback");[presenter close];exit(0);
      }];
    }
  } else dispatch_async(dispatch_get_main_queue(),^{nextFrame();});
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,30*NSEC_PER_SEC),dispatch_get_main_queue(),^{fputs("Metal test timeout\n",stderr);exit(3);});
  [NSApp run];
}return 0;}

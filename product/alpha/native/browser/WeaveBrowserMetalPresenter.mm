#import "WeaveBrowserMetalPresenter.h"
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#include <time.h>
static double renderCPU(void) { struct timespec t; clock_gettime(CLOCK_THREAD_CPUTIME_ID,&t);return t.tv_sec+t.tv_nsec/1e9; }
@interface WeaveBrowserMetalPresenter () {
  id<MTLTexture> textures[2];
  BOOL busy[2];
}
@property(nonatomic) CAMetalLayer *layer;
@property(nonatomic) id<MTLDevice> device;
@property(nonatomic) id<MTLCommandQueue> commands;
@property(nonatomic) id<MTLRenderPipelineState> pipeline;
@property(nonatomic) dispatch_queue_t queue;
@property(nonatomic) dispatch_semaphore_t slots;
@property(nonatomic) NSData *pending;
@property(nonatomic) int pendingWidth, pendingHeight, imageWidth, imageHeight;
@property(nonatomic,copy) void (^pendingSubmitted)(void);
@property(nonatomic,copy) void (^latestSubmitted)(void);
@property(nonatomic) BOOL scheduled, verifyPixels, injectFailure, diagnostics;
@property(atomic) BOOL stopped;
@property(nonatomic,readwrite) NSDictionary *lastMetrics;
@end
@implementation WeaveBrowserMetalPresenter
- (instancetype)initWithLayer:(CALayer *)parent {
  if((self=[super init])){
    _device=MTLCreateSystemDefaultDevice();if(!_device)return nil;
    NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\nstruct V {float4 position [[position]]; float2 uv;};\nvertex V vertexMain(uint n [[vertex_id]]) {float2 p[4]={float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)};float2 uv[4]={float2(0,0),float2(0,1),float2(1,0),float2(1,1)};return {float4(p[n],0,1),uv[n]};}\nfragment float4 fragmentMain(V v [[stage_in]], texture2d<float> image [[texture(0)]]) {constexpr sampler s(address::clamp_to_edge,filter::nearest);return float4(image.sample(s,v.uv).rgb,1);}";
    NSError *error=nil;
    id<MTLLibrary> library=[_device newLibraryWithSource:source options:nil error:&error];if(!library)return nil;
    MTLRenderPipelineDescriptor *descriptor=[MTLRenderPipelineDescriptor new];
    descriptor.vertexFunction=[library newFunctionWithName:@"vertexMain"];
    descriptor.fragmentFunction=[library newFunctionWithName:@"fragmentMain"];
    descriptor.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm_sRGB;
    _pipeline=[_device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!_pipeline)return nil;
    _commands=[_device newCommandQueue];if(!_commands)return nil;
    _queue=dispatch_queue_create("weave.browser.metal",DISPATCH_QUEUE_SERIAL);_slots=dispatch_semaphore_create(2);
    _diagnostics=[NSProcessInfo.processInfo.environment[@"WEAVE_BROWSER_DIAGNOSTICS"] isEqual:@"1"];
    _verifyPixels=_diagnostics && [NSProcessInfo.processInfo.environment[@"WEAVE_BROWSER_METAL_VERIFY"] isEqual:@"1"];
    _injectFailure=_diagnostics && [NSProcessInfo.processInfo.environment[@"WEAVE_BROWSER_METAL_FAILURE"] isEqual:@"1"];
    _layer=[CAMetalLayer layer];_layer.device=_device;_layer.pixelFormat=MTLPixelFormatBGRA8Unorm_sRGB;
    CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);_layer.colorspace=color;CGColorSpaceRelease(color);
    _layer.framebufferOnly=!_verifyPixels;_layer.maximumDrawableCount=2;_layer.allowsNextDrawableTimeout=YES;
    _layer.opaque=YES;_layer.magnificationFilter=kCAFilterNearest;_layer.minificationFilter=kCAFilterNearest;
    _layer.frame=parent.bounds;_lastMetrics=@{};[parent addSublayer:_layer];
  }return self;
}
- (void)complete:(void (^)(void))submitted metrics:(NSDictionary *)metrics {
  dispatch_async(dispatch_get_main_queue(),^{
    if(self.stopped)return;
    void (^callback)(void)=submitted;
    @synchronized(self){
      // A failed older command must restore the newest decoded frame, even if
      // the Page has become static and no further update will arrive.
      if(metrics[@"error"] && self.latestSubmitted) callback=self.latestSubmitted;
      if(metrics[@"error"] || self.latestSubmitted==submitted) self.latestSubmitted=nil;
    }
    self.lastMetrics=metrics;callback();
  });
}
- (void)present:(NSData *)pixels width:(int)width height:(int)height submitted:(void (^)(void))submitted {
  self.imageWidth=width;self.imageHeight=height;[self layout];
  @synchronized(self){
    if(self.stopped)return;
    self.pending=pixels;self.pendingWidth=width;self.pendingHeight=height;self.pendingSubmitted=submitted;self.latestSubmitted=submitted;
    if(self.scheduled)return;self.scheduled=YES;
  }
  dispatch_async(self.queue, ^{
    for(;;){@autoreleasepool{
      if(self.stopped)break;
      dispatch_semaphore_wait(self.slots,DISPATCH_TIME_FOREVER);
      NSData *pixels;int width,height,slot=-1;void (^submitted)(void);
      @synchronized(self){
        pixels=self.pending;width=self.pendingWidth;height=self.pendingHeight;submitted=self.pendingSubmitted;
        self.pending=nil;self.pendingSubmitted=nil;
        if(!pixels || self.stopped){self.scheduled=NO;dispatch_semaphore_signal(self.slots);return;}
        for(int n=0;n<2;n++)if(!self->busy[n]){slot=n;self->busy[n]=YES;break;}
      }
      // Keep drawable geometry with the frame snapshot on the render queue.
      // Main-thread layout only changes the layer's position in its parent.
      [CATransaction begin];[CATransaction setDisableActions:YES];
      self.layer.drawableSize=CGSizeMake(width,height);[CATransaction commit];
      id<CAMetalDrawable> drawable=[self.layer nextDrawable];
      // Transient absence/mismatch must not leave a static page permanently
      // blank. Let the owner fall back to the established CGImage presenter.
      if(!drawable || slot<0 || drawable.texture.width!=width || drawable.texture.height!=height || self.injectFailure){
        if(slot>=0){@synchronized(self){self->busy[slot]=NO;}}dispatch_semaphore_signal(self.slots);
        [self complete:submitted metrics:@{@"error":@"Metal drawable unavailable"}];break;
      }
      double cpuStart=self.diagnostics?renderCPU():0;
      id<MTLTexture> texture=self->textures[slot];
      if(!texture || texture.width!=width || texture.height!=height){
        MTLTextureDescriptor *description=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm_sRGB width:width height:height mipmapped:NO];
        description.storageMode=MTLStorageModeShared;description.usage=MTLTextureUsageShaderRead;
        texture=self->textures[slot]=[self.device newTextureWithDescriptor:description];
      }
      id<MTLCommandBuffer> command=[self.commands commandBuffer];
      NSUInteger stride=((NSUInteger)width*4+255)&~255UL;
      id<MTLBuffer> readback=self.verifyPixels?[self.device newBufferWithLength:stride*height options:MTLResourceStorageModeShared]:nil;
      MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];
      pass.colorAttachments[0].texture=drawable.texture;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
      id<MTLRenderCommandEncoder> encoder=texture && command ? [command renderCommandEncoderWithDescriptor:pass] : nil;
      if(!encoder || (self.verifyPixels && !readback)){
        [encoder endEncoding];@synchronized(self){self->busy[slot]=NO;}dispatch_semaphore_signal(self.slots);
        [self complete:submitted metrics:@{@"error":@"Metal resource allocation failed"}];break;
      }
      [texture replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:pixels.bytes bytesPerRow:width*4];
      [encoder setRenderPipelineState:self.pipeline];[encoder setFragmentTexture:texture atIndex:0];
      [encoder drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];[encoder endEncoding];
      if(readback){
        id<MTLBlitCommandEncoder> blit=[command blitCommandEncoder];
        if(!blit){@synchronized(self){self->busy[slot]=NO;}dispatch_semaphore_signal(self.slots);[self complete:submitted metrics:@{@"error":@"Metal verification allocation failed"}];break;}
        [blit copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:readback destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*height];[blit endEncoding];
      }
      [command presentDrawable:drawable];
      double submittedAt=CACurrentMediaTime(),epoch=NSDate.date.timeIntervalSince1970*1000;
      double cpuMs=self.diagnostics?(renderCPU()-cpuStart)*1000:0;
      [command addCompletedHandler:^(id<MTLCommandBuffer> finished){
        @synchronized(self){self->busy[slot]=NO;}dispatch_semaphore_signal(self.slots);
        NSMutableDictionary *metrics=[@{@"submittedAt":@(submittedAt),@"epochMs":@(epoch),@"renderCPUms":@(cpuMs),@"gpuMs":@(fmax(0,finished.GPUEndTime-finished.GPUStartTime)*1000)} mutableCopy];
        if(finished.status!=MTLCommandBufferStatusCompleted)metrics[@"error"]=finished.error.localizedDescription ?: @"Metal command failed";
        if(readback && !metrics[@"error"]){
          const uint8_t *expected=(const uint8_t*)pixels.bytes,*actual=(const uint8_t*)readback.contents;NSUInteger differences=0;
          for(int y=0;y<height;y++)for(int x=0;x<width;x++){const uint8_t*a=actual+y*stride+x*4,*b=expected+((NSUInteger)y*width+x)*4;if(memcmp(a,b,3) || a[3]!=255)differences++;}
          metrics[@"verifiedPixels"]=@((NSUInteger)width*height);metrics[@"differentPixels"]=@(differences);
        }
        [self complete:submitted metrics:metrics];
      }];
      [command commit];
      @synchronized(self){if(!self.pending){self.scheduled=NO;return;}}
    }}
    @synchronized(self){self.scheduled=NO;}
  });
}
- (void)layout {
  if(!self.imageWidth || !self.imageHeight)return;
  CGRect bounds=self.layer.superlayer.bounds;
  double scale=fmin(bounds.size.width/self.imageWidth,bounds.size.height/self.imageHeight);
  [CATransaction begin];[CATransaction setDisableActions:YES];
  self.layer.frame=CGRectMake((bounds.size.width-self.imageWidth*scale)/2,(bounds.size.height-self.imageHeight*scale)/2,self.imageWidth*scale,self.imageHeight*scale);
  [CATransaction commit];
}
- (void)close {self.stopped=YES;@synchronized(self){self.pending=nil;self.pendingSubmitted=nil;self.latestSubmitted=nil;}[self.layer removeFromSuperlayer];}
@end

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CATransaction.h>

// Opt-in presenter comparison. Two reusable source textures and one newest
// pending image; drawable waits occur on a render queue, never the UI thread.
@interface WeaveBrowserMetalPresenter : NSObject {
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
@property(nonatomic) BOOL scheduled;
@property(atomic) BOOL stopped;
- (instancetype)initWithLayer:(CALayer *)parent;
- (void)present:(NSData *)pixels width:(int)width height:(int)height submitted:(void (^)(void))submitted;
- (void)layout;
- (void)close;
@end
@implementation WeaveBrowserMetalPresenter
- (instancetype)initWithLayer:(CALayer *)parent {
  if((self=[super init])){
    _device=MTLCreateSystemDefaultDevice();if(!_device)return nil;
    NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\nstruct V {float4 position [[position]]; float2 uv;};\nvertex V vertexMain(uint n [[vertex_id]]) {float2 p[4]={float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)};float2 uv[4]={float2(0,0),float2(0,1),float2(1,0),float2(1,1)};return {float4(p[n],0,1),uv[n]};}\nfragment float4 fragmentMain(V v [[stage_in]], texture2d<float> image [[texture(0)]]) {constexpr sampler s(address::clamp_to_edge,filter::nearest);return float4(image.sample(s,v.uv).rgb,1);}";
    NSError *error=nil;id<MTLLibrary> library=[_device newLibraryWithSource:source options:nil error:&error];if(!library)return nil;
    MTLRenderPipelineDescriptor *descriptor=[MTLRenderPipelineDescriptor new];
    descriptor.vertexFunction=[library newFunctionWithName:@"vertexMain"];
    descriptor.fragmentFunction=[library newFunctionWithName:@"fragmentMain"];
    descriptor.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm_sRGB;
    _pipeline=[_device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!_pipeline)return nil;
    _commands=[_device newCommandQueue];_queue=dispatch_queue_create("weave.browser.metal",DISPATCH_QUEUE_SERIAL);_slots=dispatch_semaphore_create(2);
    _layer=[CAMetalLayer layer];_layer.device=_device;_layer.pixelFormat=MTLPixelFormatBGRA8Unorm_sRGB;
    CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);_layer.colorspace=color;CGColorSpaceRelease(color);
    _layer.framebufferOnly=YES;_layer.maximumDrawableCount=2;_layer.allowsNextDrawableTimeout=YES;
    _layer.frame=parent.bounds;
    [parent addSublayer:_layer];
  }return self;
}
- (void)present:(NSData *)pixels width:(int)width height:(int)height submitted:(void (^)(void))submitted {
  self.imageWidth=width;self.imageHeight=height;[self layout];
  @synchronized(self){
    if(self.stopped)return;self.pending=pixels;self.pendingWidth=width;self.pendingHeight=height;self.pendingSubmitted=submitted;
    if(self.scheduled)return;self.scheduled=YES;
  }
  dispatch_async(self.queue, ^{
    for(;;){@autoreleasepool{
      if(self.stopped)break;
      dispatch_semaphore_wait(self.slots,DISPATCH_TIME_FOREVER);
      id<CAMetalDrawable> drawable=[self.layer nextDrawable];
      NSData *pixels;int width,height,slot=-1;void (^submitted)(void);
      @synchronized(self){
        pixels=self.pending;width=self.pendingWidth;height=self.pendingHeight;submitted=self.pendingSubmitted;
        self.pending=nil;self.pendingSubmitted=nil;
        if(!pixels || self.stopped){self.scheduled=NO;dispatch_semaphore_signal(self.slots);return;}
        for(int n=0;n<2;n++)if(!self->busy[n]){slot=n;self->busy[n]=YES;break;}
      }
      if(!drawable || slot<0){if(slot>=0){@synchronized(self){self->busy[slot]=NO;}}dispatch_semaphore_signal(self.slots);continue;}
      id<MTLTexture> texture=self->textures[slot];
      if(!texture || texture.width!=width || texture.height!=height){
        MTLTextureDescriptor *description=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm_sRGB width:width height:height mipmapped:NO];
        description.storageMode=MTLStorageModeShared;description.usage=MTLTextureUsageShaderRead;
        texture=self->textures[slot]=[self.device newTextureWithDescriptor:description];
      }
      [texture replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:pixels.bytes bytesPerRow:width*4];
      id<MTLCommandBuffer> command=[self.commands commandBuffer];
      if(!texture || !command){@synchronized(self){self->busy[slot]=NO;}dispatch_semaphore_signal(self.slots);continue;}
      MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=drawable.texture;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
      id<MTLRenderCommandEncoder> encoder=[command renderCommandEncoderWithDescriptor:pass];
      [encoder setRenderPipelineState:self.pipeline];[encoder setFragmentTexture:texture atIndex:0];[encoder drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];[encoder endEncoding];
      [command presentDrawable:drawable];
      [command addCompletedHandler:^(id<MTLCommandBuffer> finished){@synchronized(self){self->busy[slot]=NO;}dispatch_semaphore_signal(self.slots);}];
      [command commit];
      dispatch_async(dispatch_get_main_queue(),submitted);
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
  self.layer.drawableSize=CGSizeMake(self.imageWidth,self.imageHeight);[CATransaction commit];
}
- (void)close {self.stopped=YES;@synchronized(self){self.pending=nil;self.pendingSubmitted=nil;}[self.layer removeFromSuperlayer];}
@end

#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
static NSData *pixels(const char *path,size_t *w,size_t *h) {
 NSURL *url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
 CGImageSourceRef src=CGImageSourceCreateWithURL((__bridge CFURLRef)url,NULL);
 if(!src)return nil; CGImageRef img=CGImageSourceCreateImageAtIndex(src,0,NULL);CFRelease(src);if(!img)return nil;
 *w=CGImageGetWidth(img);*h=CGImageGetHeight(img);NSMutableData *data=[NSMutableData dataWithLength:*w**h*4];CGColorSpaceRef cs=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
 CGContextRef ctx=CGBitmapContextCreate(data.mutableBytes,*w,*h,8,*w*4,cs,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);CGContextDrawImage(ctx,CGRectMake(0,0,*w,*h),img);CGContextRelease(ctx);CGColorSpaceRelease(cs);CGImageRelease(img);return data;
}
int main(int argc,char**argv){@autoreleasepool{if(argc!=3)return 2;size_t w,h,x,y;NSData*a=pixels(argv[1],&w,&h),*b=pixels(argv[2],&x,&y);if(!a||!b||w!=x||h!=y)return 3;const unsigned char *aa=a.bytes,*bb=b.bytes;size_t different=0;for(size_t i=0;i<w*h;i++)if(memcmp(aa+4*i,bb+4*i,4))different++;printf("{\"width\":%zu,\"height\":%zu,\"differentPixels\":%zu}\n",w,h,different);return different?1:0;}}

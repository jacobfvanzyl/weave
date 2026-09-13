#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#if TARGET_OS_OSX
#import <AppKit/AppKit.h>
#define WeaveBrowserView NSView
#else
#import <UIKit/UIKit.h>
#define WeaveBrowserView UIView
#endif
NS_ASSUME_NONNULL_BEGIN
/** Native binary transport and upstream lossless decoding. Control messages only cross the shell bridge. */
@interface WeaveBrowserSurface : NSObject
@property(nonatomic, readonly) WeaveBrowserView *view;
- (instancetype)initWithEvent:(void (^)(NSDictionary *))event;
- (void)connect:(NSString *)url;
- (void)sendControl:(NSString *)json;
- (void)layout:(CGRect)frame visible:(BOOL)visible dim:(double)dim;
- (void)close;
@end
NS_ASSUME_NONNULL_END

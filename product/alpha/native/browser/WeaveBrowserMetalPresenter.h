#import <Foundation/Foundation.h>
#import <QuartzCore/CALayer.h>
NS_ASSUME_NONNULL_BEGIN
/** Bounded, color-managed presentation of immutable BGRA RFB frames. Main-thread API. */
@interface WeaveBrowserMetalPresenter : NSObject
@property(nonatomic,readonly) NSDictionary *lastMetrics;
- (nullable instancetype)initWithLayer:(CALayer *)parent;
- (void)present:(NSData *)pixels width:(int)width height:(int)height submitted:(void (^)(void))submitted;
- (void)layout;
- (void)close;
@end
NS_ASSUME_NONNULL_END

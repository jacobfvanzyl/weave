#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN
/** Main-thread owned terminal emulation and CoreText drawing. It never owns a
 * Host connection, PTY, workspace identity, credential or process lifetime. */
@interface WeaveTerminalRenderer : NSObject
+ (nullable instancetype)make;
@property(nonatomic, copy, nullable) void (^writeInput)(NSData *data);
@property(nonatomic) BOOL readOnly;
@property(nonatomic, readonly) NSUInteger columns;
@property(nonatomic, readonly) NSUInteger rows;
@property(nonatomic, readonly) CGFloat cellWidth;
@property(nonatomic, readonly) CGFloat cellHeight;
@property(nonatomic, readonly) NSString *visibleText;
@property(nonatomic, readonly) CGRect cursorRect;
@property(nonatomic, readonly) BOOL mouseReporting;
- (NSString *)textForVisibleRange:(NSRange)range;
// Mouse actions: press=0, release=1, motion=2; buttons: left=1, right=2,
// middle=3, wheel-up=4, wheel-down=5, no button=0. Shift keeps local selection.
- (BOOL)sendMouseAt:(CGPoint)point button:(NSUInteger)button action:(NSUInteger)action modifiers:(NSUInteger)modifiers NS_SWIFT_NAME(sendMouse(at:button:action:modifiers:));
- (BOOL)restoreData:(NSData *)data columns:(NSUInteger)columns rows:(NSUInteger)rows NS_SWIFT_NAME(restore(_:columns:rows:));
- (BOOL)consume:(NSData *)data reset:(BOOL)reset;
- (BOOL)resizeToSize:(CGSize)size;
- (void)drawInContext:(CGContextRef)context size:(CGSize)size;
- (NSString *)textFromCell:(NSUInteger)start count:(NSUInteger)count;
// Modifiers: Shift=1, Control=2, Option=4, Command=8.
// Actions: release=0, press=1, repeat=2. Key names are physical W3C names.
- (BOOL)sendKey:(NSString *)name text:(NSString *)text modifiers:(NSUInteger)modifiers action:(NSUInteger)action;
- (BOOL)pasteText:(NSString *)text;
- (void)scrollLines:(NSInteger)lines;
@end
NS_ASSUME_NONNULL_END

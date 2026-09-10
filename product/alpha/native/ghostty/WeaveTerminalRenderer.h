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
- (BOOL)consume:(NSData *)data reset:(BOOL)reset;
- (BOOL)resizeToSize:(CGSize)size;
- (void)drawInContext:(CGContextRef)context size:(CGSize)size;
- (NSString *)textFromCell:(NSUInteger)start count:(NSUInteger)count;
- (BOOL)pasteText:(NSString *)text;
- (void)scrollLines:(NSInteger)lines;
@end
NS_ASSUME_NONNULL_END

// A terminal's screen on the device (ADR 0022, WVE-153): a replica in libghostty-vt of a terminal
// a holder keeps on the Host, drawn with CoreText. Brought back from e30f6e93
// (product/alpha/native/ghostty) by way of the WVE-150 spike. It imports no UIKit, so the native
// tests (`scripts/native-tests.ts`) build it for macOS.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN
/** Used on the main thread. It owns no connection, PTY or process, and answers none of the
 * program's queries: only the holder does. Its grid is the terminal's, which the Host sets; the
 * view it draws in may be larger or smaller, and clips. */
@interface WeaveTerminalRenderer : NSObject
/** The snapshots this build reads, `ghostty <commit> snapshot <version>`, as a holder names its own. */
+ (NSString *)codec;
+ (BOOL)registerFontsAtURL:(NSURL *)directory;
/** Registers the fonts in the main bundle's `TerminalFonts` first, if they aren't yet. */
+ (nullable instancetype)rendererWithFontSize:(CGFloat)fontSize;
@property(nonatomic, readonly) NSString *fontName;
/** Points, clamped to 8 to 32. A new size measures the cells again; the grid stays. */
@property(nonatomic) CGFloat fontSize;
@property(nonatomic, copy, nullable) void (^writeInput)(NSData *data);
@property(nonatomic) BOOL readOnly;
@property(nonatomic, readonly) NSUInteger columns;
@property(nonatomic, readonly) NSUInteger rows;
@property(nonatomic, readonly) CGFloat cellWidth;
@property(nonatomic, readonly) CGFloat cellHeight;
@property(nonatomic, readonly) NSString *visibleText;
@property(nonatomic, readonly) CGRect cursorRect;
@property(nonatomic, readonly) BOOL mouseReporting;

/** A blank screen of this size, for a restore from the formatter's VT, which is written next. */
- (BOOL)resetToColumns:(NSUInteger)columns rows:(NSUInteger)rows NS_SWIFT_NAME(reset(columns:rows:));
/** Decodes a snapshot off the main thread and puts its screen in place on it; then `completion`. */
- (void)restoreSnapshot:(NSData *)snapshot completion:(void (^)(BOOL restored))completion;
/** The program's output. */
- (void)write:(NSData *)output;
/** Follows the terminal's size, as the Host reports it. */
- (BOOL)resizeToColumns:(NSUInteger)columns rows:(NSUInteger)rows NS_SWIFT_NAME(resize(columns:rows:));
/** How many cells fit a view of this size, which is what the device asks the Host for. */
- (CGSize)gridForViewportSize:(CGSize)size NS_SWIFT_NAME(grid(forViewportSize:));
- (void)drawInContext:(CGContextRef)context size:(CGSize)size;

- (NSString *)textForVisibleRange:(NSRange)range;
- (NSString *)textFromCell:(NSUInteger)start count:(NSUInteger)count;
// Mouse actions: press=0, release=1, motion=2; buttons: left=1, right=2,
// middle=3, wheel-up=4, wheel-down=5, no button=0. Shift keeps local selection.
- (BOOL)sendMouseAt:(CGPoint)point button:(NSUInteger)button action:(NSUInteger)action modifiers:(NSUInteger)modifiers NS_SWIFT_NAME(sendMouse(at:button:action:modifiers:));
// Modifiers: Shift=1, Control=2, Option=4, Command=8.
// Actions: release=0, press=1, repeat=2. Key names are physical W3C names.
- (BOOL)sendKey:(NSString *)name text:(NSString *)text modifiers:(NSUInteger)modifiers action:(NSUInteger)action;
/** Typed text. With modifiers, a single character is sent as the US layout's key for it, as a
 * key bar's Ctrl needs; without, as text. */
- (BOOL)sendText:(NSString *)text modifiers:(NSUInteger)modifiers;
- (BOOL)pasteText:(NSString *)text;
- (void)scrollLines:(NSInteger)lines;
@end
NS_ASSUME_NONNULL_END

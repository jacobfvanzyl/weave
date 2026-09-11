#import "WeaveTerminalRenderer.h"
#import <ImageIO/ImageIO.h>
#import <CoreText/CoreText.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <stdio.h>
#include <ghostty/vt.h>
#include <initializer_list>

static NSData *snapshot(NSData *bytes, NSUInteger cols, NSUInteger rows) {
  GhosttyTerminal terminal = NULL; ghostty_terminal_new(NULL, &terminal, cols, rows);
  GhosttyColorRgb bg = {30,30,46}, fg = {205,214,244}, cursor = {245,224,220};
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &bg);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &fg);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
  GhosttyTerminalModeConfig graphemes = {GHOSTTY_MODE_GRAPHEME_CLUSTER, true};
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  size_t continuation = 1024 * 1024;
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES, &continuation);
  ghostty_terminal_vt_write(terminal, (const uint8_t *)bytes.bytes, bytes.length);
  uint8_t *output = NULL; size_t length = 0;
  GhosttyResult result = ghostty_snapshot_encode_alloc(terminal, NULL, &output, &length);
  NSData *data = result == GHOSTTY_SUCCESS ? [NSData dataWithBytes:output length:length] : nil;
  ghostty_free(NULL, output, length); ghostty_terminal_free(terminal); return data;
}
static BOOL reset(WeaveTerminalRenderer *renderer, NSData *data) {
  return [renderer consume:snapshot(data, renderer.columns, renderer.rows) reset:YES];
}

static BOOL cursorPixels(WeaveTerminalRenderer *renderer, NSString *sequence, BOOL left, BOOL middle, BOOL bottom) {
  reset(renderer, [sequence dataUsingEncoding:NSUTF8StringEncoding]);
  const size_t width = 120, height = 80;
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  CGContextTranslateCTM(context, 0, height); CGContextScaleCTM(context, 1, -1);
  [renderer drawInContext:context size:CGSizeMake(width, height)];
  const uint8_t *pixels = (const uint8_t *)CGBitmapContextGetData(context);
  auto cursorAt = [&](NSUInteger x, NSUInteger y) { const uint8_t *p = pixels + (y * width + x) * 4; return p[0] == 245 && p[1] == 224 && p[2] == 220; };
  NSUInteger middleX = 8 + floor(renderer.cellWidth / 2), middleY = 8 + floor(renderer.cellHeight / 2);
  BOOL valid = cursorAt(8, middleY) == left && cursorAt(middleX, middleY) == middle && cursorAt(middleX, 8 + ceil(renderer.cellHeight) - 1) == bottom;
  CGContextRelease(context);
  return valid;
}

static BOOL focusBorderCorners(WeaveTerminalRenderer *renderer) {
  const size_t width = 400, height = 240;
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  CGContextTranslateCTM(context, 0, height); CGContextScaleCTM(context, 4, -4);
  reset(renderer, [@"\033[?25l" dataUsingEncoding:NSUTF8StringEncoding]);
  [renderer drawInContext:context size:CGSizeMake(100, 60)];
  renderer.focusBorderWidth = 1; renderer.focusBorderBottomRightRadius = 5.6; renderer.focusBorderRGB = 0x89b4fa;
  [renderer drawFocusBorderInContext:context size:CGSizeMake(100, 60)];
  const uint8_t *pixels = (const uint8_t *)CGBitmapContextGetData(context);
  BOOL valid = YES;
  // The 45-degree apex lies inside the native square and used to erase the
  // matching CSS arc. Only the bottom-right carries a curved stroke.
  for (NSUInteger y : {3ul, height - 4}) for (NSUInteger x : {3ul, width - 4}) {
    const uint8_t *p = pixels + (y * width + x) * 4;
    const BOOL curved = y == height - 4 && x == width - 4;
    if (curved ? (p[0] < 80 || p[2] < 140) : (p[0] != 30 || p[1] != 30 || p[2] != 46)) { fprintf(stderr, "Corner %lu,%lu: %u,%u,%u expected curved=%d\n", x, y, p[0], p[1], p[2], curved); valid = NO; }
  }
  // A rounded border must not turn the viewport itself into a rounded mask.
  const uint8_t *corner = pixels;
  if (corner[0] != 30 || corner[1] != 30 || corner[2] != 46 || corner[3] != 255) valid = NO;
  renderer.focusBorderWidth = 0;
  CGContextRelease(context);
  return valid;
}

static BOOL inactiveDimming(WeaveTerminalRenderer *renderer) {
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, 4, 4, 8, 16, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  CGContextSetRGBFillColor(context, 1, 0, 0, 1);
  CGContextFillRect(context, CGRectMake(0, 0, 4, 4));
  renderer.dimAmount = 0;
  [renderer drawDimmingInContext:context size:CGSizeMake(4, 4)];
  const uint8_t *pixels = (const uint8_t *)CGBitmapContextGetData(context);
  BOOL valid = pixels[0] == 255 && pixels[1] == 0 && pixels[2] == 0;
  NSString *before = renderer.visibleText;
  renderer.dimAmount = 0.4;
  [renderer drawDimmingInContext:context size:CGSizeMake(4, 4)];
  valid = valid && pixels[0] >= 164 && pixels[0] <= 166 && pixels[1] >= 11 && pixels[1] <= 13 && pixels[2] >= 17 && pixels[2] <= 19 && [renderer.visibleText isEqualToString:before];
  renderer.dimAmount = 0;
  CGContextRelease(context);
  return valid;
}

static BOOL remoteGridClipping(WeaveTerminalRenderer *renderer) {
  NSData *screen = [@"\033[HLEFT\033[40;120HX" dataUsingEncoding:NSUTF8StringEncoding];
  if (![renderer restoreData:snapshot(screen,120,40) columns:120 rows:40]) return NO;
  CGSize capacity = [renderer gridForViewportSize:CGSizeMake(16 + 20 * renderer.cellWidth, 16 + 6 * renderer.cellHeight)];
  if (capacity.width != 20 || capacity.height != 6 || renderer.columns != 120 || renderer.rows != 40) return NO;
  if (![renderer.visibleText containsString:@"LEFT"] || ![renderer.visibleText containsString:@"X"] || renderer.cursorRect.origin.y < 80) return NO;
  const size_t width = 320, height = 160;
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  CGContextTranslateCTM(context, 0, height); CGContextScaleCTM(context, 1, -1);
  CGContextSetRGBFillColor(context, 1, 0, 1, 1);
  CGContextFillRect(context, CGRectMake(0, 0, width, height));
  [renderer drawInContext:context size:CGSizeMake(120, 80)];
  const uint8_t *pixels = (const uint8_t *)CGBitmapContextGetData(context);
  auto at = [&](NSUInteger x, NSUInteger y) { return pixels + (y * width + x) * 4; };
  BOOL clipped = YES;
  for (NSUInteger y = 0; y < height; y++) for (NSUInteger x = 0; x < width; x++) {
    if (x < 120 && y < 80) continue;
    const uint8_t *p = at(x, y);
    if (p[0] != 255 || p[1] != 0 || p[2] != 255) clipped = NO;
  }
  if (![renderer restoreData:snapshot([@"SMALL" dataUsingEncoding:NSUTF8StringEncoding],8,4) columns:8 rows:4]) clipped = NO;
  [renderer drawInContext:context size:CGSizeMake(width, height)];
  const uint8_t *blank = at(250, 120);
  BOOL letterboxed = blank[0] == 30 && blank[1] == 30 && blank[2] == 46 && renderer.columns == 8 && renderer.rows == 4;
  CGContextRelease(context);
  return clipped && letterboxed;
}

static BOOL incrementalSnapshot(WeaveTerminalRenderer *renderer) {
  NSMutableData *source = [NSMutableData data];
  for (int row = 0; row < 2000; row++) [source appendData:[[NSString stringWithFormat:@"history-%d\r\n", row] dataUsingEncoding:NSUTF8StringEncoding]];
  [source appendData:[@"\033[" dataUsingEncoding:NSUTF8StringEncoding]];
  NSData *encoded = snapshot(source, 80, 24);
  GhosttySnapshotDecoder decoder = NULL; GhosttyTerminal terminal = NULL;
  if (ghostty_snapshot_decoder_new_buf(NULL, &decoder, (const uint8_t *)encoded.bytes, encoded.length) != GHOSTTY_SUCCESS || ghostty_snapshot_decoder_ready(decoder, &terminal) != GHOSTTY_SUCCESS) return NO;
  size_t offset = 0; ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &offset);
  BOOL valid = [renderer restoreData:[encoded subdataWithRange:NSMakeRange(0, offset)] columns:80 rows:24];
  [renderer consume:[@"31mLIVE_DURING_HISTORY" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
  valid = valid && [renderer.visibleText containsString:@"LIVE_DURING_HISTORY"];
  GhosttyResult status;
  do {
    status = ghostty_snapshot_decoder_next(decoder); size_t next = offset;
    ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &next);
    valid = valid && [renderer appendHistory:[encoded subdataWithRange:NSMakeRange(offset, next - offset)]];
    valid = valid && [renderer.visibleText containsString:@"LIVE_DURING_HISTORY"];
    offset = next;
  } while (status == GHOSTTY_SUCCESS);
  valid = valid && status == GHOSTTY_NO_VALUE;
  ghostty_snapshot_decoder_free(decoder); ghostty_terminal_free(terminal);
  const uint8_t partial[] = {0xe7};
  valid = valid && reset(renderer, [NSData dataWithBytes:partial length:1]);
  const uint8_t tail[] = {0x95,0x8c};
  [renderer consume:[NSData dataWithBytes:tail length:2] reset:NO];
  valid = valid && [renderer.visibleText containsString:@"界"];
  NSMutableData *corrupt = [encoded mutableCopy]; ((uint8_t *)corrupt.mutableBytes)[20] ^= 1;
  valid = valid && ![renderer restoreData:corrupt columns:80 rows:24];
  return valid;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    [WeaveTerminalRenderer registerFontsAtURL:[[[NSURL fileURLWithPath:@(argv[0])] URLByDeletingLastPathComponent] URLByAppendingPathComponent:@"TerminalFonts"]];
    WeaveTerminalRenderer *renderer = [WeaveTerminalRenderer make];
    if (!renderer || ![renderer resizeToSize:CGSizeMake(720, 360)]) return 1;
    if (![renderer.fontName isEqualToString:@"JetBrainsMonoNF-Regular"]) return 36;
    for (NSString *style in @[@"Regular", @"Bold", @"Italic", @"BoldItalic"]) {
      CTFontRef font = CTFontCreateWithName((__bridge CFStringRef)[@"JetBrainsMonoNF-" stringByAppendingString:style], 13, NULL);
      UniChar icons[] = {0xf115, 0xe60b, 0xf1d3, 0xe0b0}; CGGlyph glyphs[4];
      BOOL covered = CTFontGetGlyphsForCharacters(font, icons, glyphs, 4); CFRelease(font);
      if (!covered) return 37;
    }
    if (!cursorPixels(renderer, @"\033[2 q", YES, YES, YES)) return 38;
    if (!cursorPixels(renderer, @"\033[4 q", NO, NO, YES)) return 39;
    if (!cursorPixels(renderer, @"\033[6 q", YES, NO, NO)) return 40;
    if (!cursorPixels(renderer, @"\033[2 q\033[?25l", NO, NO, NO)) return 41;
    if (!incrementalSnapshot(renderer)) return 45;
    NSMutableData *replies = [NSMutableData data];
    renderer.writeInput = ^(NSData *data) { [replies appendData:data]; };
    NSString *text = @"Weave native libghostty  \uf115 \ue60b \uf1d3 \ue0b0\r\n\033[32mGreen\033[0m — 界 👩🏽‍💻 é\r\n\033[1mBold\033[0m \033[3mItalic\033[0m \033[4mUnderline\033[0m\r\n\033[38;2;255;80;80mTrue color\033[0m\r\n";
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    for (NSUInteger i = 0; i < bytes.length; i++) {
      if (![renderer consume:[bytes subdataWithRange:NSMakeRange(i, 1)] reset:NO]) return 2;
    }
    if (![renderer.visibleText containsString:@"Weave native libghostty"] || ![renderer.visibleText containsString:@"界"] || ![renderer.visibleText containsString:@"é"]) return 3;
    [renderer consume:[@"\033[?1049h\033[HALTERNATE\033[?1049l" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if ([renderer.visibleText containsString:@"ALTERNATE"] || ![renderer.visibleText containsString:@"Weave native"]) return 4;
    [renderer consume:[@"\033[6n" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if (replies.length) return 5;
    [replies setLength:0];
    reset(renderer, [@"\033[6n" dataUsingEncoding:NSUTF8StringEncoding]);
    if (replies.length) return 6;
    reset(renderer, bytes);
    if (![renderer.visibleText containsString:@"界 👩🏽‍💻 é"]) return 8;
    [replies setLength:0];
    [renderer consume:[@"\033[?2004h" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if (![renderer pasteText:@"first\nsecond"]) return 9;
    if (![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[200~first\nsecond\033[201~"]) return 10;
    renderer.readOnly = YES; [replies setLength:0];
    if ([renderer pasteText:@"forbidden"] || replies.length) return 11;
    [renderer consume:[@"\033[6n" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if (replies.length) return 12;
    renderer.readOnly = NO;
    [renderer consume:[@"\033[?1l" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    if (![renderer sendKey:@"ArrowUp" text:@"" modifiers:0 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[A"]) return 13;
    [renderer consume:[@"\033[?1h" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    if (![renderer sendKey:@"ArrowUp" text:@"" modifiers:0 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033OA"]) return 14;
    [replies setLength:0];
    if (![renderer sendKey:@"KeyC" text:@"c" modifiers:2 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\003"]) return 15;
    [replies setLength:0];
    if (![renderer sendKey:@"Tab" text:@"" modifiers:1 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[Z"]) return 16;
    [renderer consume:[@"\033[>11u\033[?u" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    if (![renderer sendKey:@"Backspace" text:@"" modifiers:0 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[127u"]) return 17;
    [replies setLength:0];
    if (![renderer sendKey:@"Backspace" text:@"" modifiers:0 action:0] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[127;1:3u"]) return 18;
    [renderer consume:[@"\033[<u" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    if (![renderer sendKey:@"Backspace" text:@"" modifiers:0 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\177"]) return 19;
    [replies setLength:0];
    if (![renderer sendKey:@"Backspace" text:@"" modifiers:0 action:0]) return 20;
    [renderer consume:[@"\033[<u" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [renderer consume:[@"\033=\033[?1035l" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    if (![renderer sendKey:@"Numpad1" text:@"1" modifiers:0 action:1] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033Oq"]) return 21;
    [replies setLength:0];
    [renderer consume:[@"\033[?2048$p" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if (replies.length) return 22;
    [replies setLength:0];
    [renderer consume:[@"\033[?2048h" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [renderer resizeToSize:CGSizeMake(800, 400)];
    if (replies.length) return 23;
    [renderer resizeToSize:CGSizeMake(720, 360)];
    [renderer resizeToSize:CGSizeMake(16 + renderer.cellWidth * 6 + 0.1, 16 + renderer.cellHeight * 4 + 0.1)];
    reset(renderer, [@"ABCDEFGHIJ" dataUsingEncoding:NSUTF8StringEncoding]);
    if (![[renderer textFromCell:0 count:10] isEqualToString:@"ABCDEFGHIJ"]) return 28;
    reset(renderer, [@"界é👩🏽‍💻" dataUsingEncoding:NSUTF8StringEncoding]);
    if (![[renderer textFromCell:1 count:1] isEqualToString:@"界"]) return 29;
    if (![[renderer textForVisibleRange:NSMakeRange(1, 2)] isEqualToString:@"é"]) return 30;
    [renderer consume:[@"\033[?1002h\033[?1006h" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    [replies setLength:0];
    CGPoint point = CGPointMake(8 + renderer.cellWidth * 2.2, 8 + renderer.cellHeight * 1.2);
    if (![renderer sendMouseAt:point button:1 action:0 modifiers:0] || ![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[<0;3;2M"]) return 31;
    [replies setLength:0];
    [renderer sendMouseAt:point button:1 action:1 modifiers:0];
    if (![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[<0;3;2m"]) return 32;
    [replies setLength:0];
    if ([renderer sendMouseAt:point button:1 action:0 modifiers:1] || replies.length) return 33;
    renderer.readOnly = YES;
    if ([renderer sendMouseAt:point button:1 action:0 modifiers:0] || [renderer sendKey:@"KeyX" text:@"x" modifiers:0 action:1] || replies.length) return 34;
    if (![[renderer textFromCell:1 count:1] isEqualToString:@"界"]) return 35;
    renderer.readOnly = NO;
    [renderer resizeToSize:CGSizeMake(720, 360)];
    if (!remoteGridClipping(renderer)) return 42;
    [renderer resizeToSize:CGSizeMake(720, 360)];
    const char *snapshotPath = getenv("WEAVE_SNAPSHOT_PROBE_INPUT");
    if (snapshotPath) {
      NSDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(snapshotPath)] options:0 error:NULL];
      if (!snapshot || ![renderer restoreData:[[NSData alloc] initWithBase64EncodedString:snapshot[@"data"] options:0] columns:[snapshot[@"cols"] unsignedIntegerValue] rows:[snapshot[@"rows"] unsignedIntegerValue]]) return 24;
      [replies setLength:0];
      [renderer sendKey:@"ArrowUp" text:@"" modifiers:0 action:1];
      if (![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033OA"]) return 25;
      [replies setLength:0]; [renderer pasteText:@"restored"];
      if (![[[NSString alloc] initWithData:replies encoding:NSUTF8StringEncoding] isEqualToString:@"\033[200~restored\033[201~"]) return 26;
      [renderer consume:[@"\033[?1049l" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
      if (![renderer.visibleText containsString:@"PRIMARY"]) return 27;
    }
    reset(renderer, bytes);
    size_t width = 720, height = 360;
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, space, kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextTranslateCTM(context, 0, height); CGContextScaleCTM(context, 1, -1);
    [renderer drawInContext:context size:CGSizeMake(width, height)];
    CGImageRef image = CGBitmapContextCreateImage(context);
    NSURL *url = [NSURL fileURLWithPath:argc > 1 ? @(argv[1]) : @"/tmp/weave-native-renderer.png"];
    CGImageDestinationRef output = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
    CGImageDestinationAddImage(output, image, NULL);
    BOOL saved = CGImageDestinationFinalize(output);
    CFRelease(output); CGImageRelease(image); CGContextRelease(context);
    if (!saved) return 7;
    if (!focusBorderCorners(renderer)) return 41;
    if (!inactiveDimming(renderer)) return 42;
    puts("{\"passed\":true,\"fragmentedUtf8\":true,\"alternateScreen\":true,\"replicaRepliesSuppressed\":true,\"snapshotReplySuppression\":true,\"coreTextRendered\":true,\"nerdGlyphCoverage\":true,\"cursorShapePixels\":true,\"wideGraphemeText\":true,\"bracketedPaste\":true,\"readOnlyInput\":true,\"applicationCursorKeys\":true,\"modifiedKeys\":true,\"kittyKeyboard\":true,\"applicationKeypad\":true,\"wrappedCopy\":true,\"wideSelection\":true,\"sgrMouse\":true,\"observerCopy\":true,\"authoritativeGridClipping\":true,\"roundedFocusBorder\":true,\"inactiveDimming\":true,\"readyBeforeHistory\":true,\"liveDuringHistory\":true,\"snapshotParserContinuation\":true,\"corruptSnapshotRejected\":true}");
  }
  return 0;
}

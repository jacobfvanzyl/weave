#import "WeaveTerminalRenderer.h"
#import <CoreText/CoreText.h>
#include <ghostty/vt.h>
#include <vector>
#include <algorithm>

struct WeaveCell {
  __strong NSString *text = @"";
  GhosttyColorRgb foreground{}, background{};
  bool spacer = false, bold = false, italic = false, underline = false, strike = false, invisible = false;
};
@implementation WeaveTerminalRenderer {
  GhosttyTerminal _terminal;
  GhosttyKeyEncoder _keyEncoder;
  GhosttyKeyEvent _keyEvent;
  GhosttyRenderState _frame;
  GhosttyRenderStateRowIterator _iterator;
  GhosttyRenderStateRowCells _cells;
  CTFontRef _font, _boldFont, _italicFont, _boldItalicFont;
  NSUInteger _columns, _rows;
  CGFloat _cellWidth, _cellHeight, _ascent;
  BOOL _replaying;
  std::vector<WeaveCell> _visible;
  GhosttyRenderStateCursor _cursor;
}
@synthesize columns = _columns, rows = _rows, cellWidth = _cellWidth, cellHeight = _cellHeight;
static void writePty(GhosttyTerminal terminal, void *userdata, const uint8_t *data, size_t length) {
  WeaveTerminalRenderer *renderer = (__bridge WeaveTerminalRenderer *)userdata;
  [renderer acceptReply:[NSData dataWithBytes:data length:length]];
}
+ (instancetype)make { return [[self alloc] init]; }
- (instancetype)init {
  if (!(self = [super init])) return nil;
  _columns = 80; _rows = 24;
  _font = CTFontCreateWithName(CFSTR("Menlo-Regular"), 13, NULL);
  _boldFont = CTFontCreateCopyWithSymbolicTraits(_font, 0, NULL, kCTFontBoldTrait, kCTFontBoldTrait);
  _italicFont = CTFontCreateCopyWithSymbolicTraits(_font, 0, NULL, kCTFontItalicTrait, kCTFontItalicTrait);
  _boldItalicFont = CTFontCreateCopyWithSymbolicTraits(_font, 0, NULL, kCTFontBoldTrait | kCTFontItalicTrait, kCTFontBoldTrait | kCTFontItalicTrait);
  UniChar character = 'M'; CGGlyph glyph;
  CTFontGetGlyphsForCharacters(_font, &character, &glyph, 1);
  CGSize advance;
  CTFontGetAdvancesForGlyphs(_font, kCTFontOrientationHorizontal, &glyph, &advance, 1);
  _cellWidth = advance.width;
  _ascent = ceil(CTFontGetAscent(_font));
  _cellHeight = ceil(_ascent + CTFontGetDescent(_font) + 2);
  if (ghostty_key_encoder_new(NULL, &_keyEncoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &_keyEvent) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &_frame) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &_iterator) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &_cells) != GHOSTTY_SUCCESS || ![self newTerminal]) return nil;
  return self;
}
- (void)dealloc {
  ghostty_key_encoder_free(_keyEncoder);
  ghostty_key_event_free(_keyEvent);
  ghostty_terminal_free(_terminal);
  ghostty_render_state_row_cells_free(_cells);
  ghostty_render_state_row_iterator_free(_iterator);
  ghostty_render_state_free(_frame);
  if (_font) CFRelease(_font);
  if (_boldFont) CFRelease(_boldFont);
  if (_italicFont) CFRelease(_italicFont);
  if (_boldItalicFont) CFRelease(_boldItalicFont);
}
- (void)acceptReply:(NSData *)data {
  // The Host resizes the PTY after the client fits its view. Advertising
  // in-band resize here lets a TUI redraw into the old tmux grid before that
  // resize reaches the Host. Keep DEC 2048 unavailable until the transport
  // can order the notification after its authoritative PTY resize.
  NSString *reply = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if ([reply hasPrefix:@"\033[48;"] && [reply hasSuffix:@"t"]) return;
  if ([reply isEqualToString:@"\033[?2048;1$y"] || [reply isEqualToString:@"\033[?2048;2$y"])
    data = [@"\033[?2048;0$y" dataUsingEncoding:NSUTF8StringEncoding];
  if (!_replaying && !self.readOnly && self.writeInput) self.writeInput(data);
}
- (BOOL)newTerminal {
  GhosttyTerminal next = NULL;
  if (ghostty_terminal_new(NULL, &next, (uint16_t)_columns, (uint16_t)_rows) != GHOSTTY_SUCCESS) return NO;
  ghostty_terminal_free(_terminal); _terminal = next;
  GhosttyColorRgb background = {30, 30, 46}, foreground = {205, 214, 244};
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  GhosttyTerminalModeConfig graphemes = { GHOSTTY_MODE_GRAPHEME_CLUSTER, true };
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  size_t bytes = 16 * 1024 * 1024, lines = 10000;
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &bytes);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_USERDATA, (__bridge void *)self);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void *)writePty);
  return YES;
}
- (BOOL)consume:(NSData *)data reset:(BOOL)reset {
  NSAssert(NSThread.isMainThread, @"Native terminal must be used on the main thread");
  if (data.length > 2 * 1024 * 1024) return NO;
  if (reset && ![self newTerminal]) return NO;
  _replaying = reset;
  ghostty_terminal_vt_write(_terminal, (const uint8_t *)data.bytes, data.length);
  _replaying = NO;
  return [self updateFrame];
}
- (BOOL)resizeToSize:(CGSize)size {
  NSUInteger columns = std::clamp((NSInteger)floor((size.width - 16) / _cellWidth), (NSInteger)2, (NSInteger)500);
  NSUInteger rows = std::clamp((NSInteger)floor((size.height - 16) / _cellHeight), (NSInteger)2, (NSInteger)300);
  if (columns == _columns && rows == _rows) return YES;
  if (ghostty_terminal_resize(_terminal, (uint16_t)columns, (uint16_t)rows, (uint32_t)ceil(_cellWidth), (uint32_t)ceil(_cellHeight)) != GHOSTTY_SUCCESS) return NO;
  _columns = columns; _rows = rows;
  return [self updateFrame];
}
- (BOOL)updateFrame {
  if (ghostty_render_state_update(_frame, _terminal) != GHOSTTY_SUCCESS) return NO;
  GhosttyColorRgb background = {30, 30, 46}, foreground = {205, 214, 244};
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_BACKGROUND, &background);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_FOREGROUND, &foreground);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &_iterator);
  _visible.clear(); _visible.reserve(_rows * _columns);
  while (ghostty_render_state_row_iterator_next(_iterator)) {
    ghostty_render_state_row_get(_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &_cells);
    while (ghostty_render_state_row_cells_next(_cells)) {
      WeaveCell cell;
      GhosttyCell raw; GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
      cell.spacer = wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD;
      cell.background = background; cell.foreground = foreground;
      ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &cell.background);
      ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &cell.foreground);
      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
      if (style.inverse) std::swap(cell.foreground, cell.background);
      if (style.faint) { cell.foreground.r /= 2; cell.foreground.g /= 2; cell.foreground.b /= 2; }
      cell.bold = style.bold; cell.italic = style.italic; cell.underline = style.underline != 0;
      cell.strike = style.strikethrough; cell.invisible = style.invisible;
      uint8_t stack[128]; GhosttyBuffer buffer = {stack, sizeof(stack), 0};
      auto result = ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &buffer);
      std::vector<uint8_t> extra;
      if (result == GHOSTTY_OUT_OF_SPACE && buffer.len <= 65536) {
        extra.resize(buffer.len); buffer.ptr = extra.data(); buffer.cap = extra.size();
        result = ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &buffer);
      }
      if (result == GHOSTTY_SUCCESS && buffer.len) cell.text = [[NSString alloc] initWithBytes:buffer.ptr length:buffer.len encoding:NSUTF8StringEncoding] ?: @"�";
      _visible.push_back(cell);
    }
  }
  _cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_CURSOR, &_cursor);
  return _visible.size() == _rows * _columns;
}
- (NSString *)visibleText { return [self textFromCell:0 count:_visible.size()]; }
- (NSString *)textFromCell:(NSUInteger)start count:(NSUInteger)count {
  NSMutableString *text = [NSMutableString string];
  if (start >= _visible.size()) return text;
  NSUInteger end = start + MIN(count, _visible.size() - start);
  for (NSUInteger i = start; i < end; i++) {
    if (!_visible[i].spacer) [text appendString:_visible[i].text.length ? _visible[i].text : @" "];
    if ((i + 1) % _columns == 0 && i + 1 < end) [text appendString:@"\n"];
  }
  return text;
}
static GhosttyKey physicalKey(NSString *name) {
  if (name.length == 4 && [name hasPrefix:@"Key"]) {
    unichar letter = [name characterAtIndex:3];
    if (letter >= 'A' && letter <= 'Z') return (GhosttyKey)(GHOSTTY_KEY_A + letter - 'A');
  }
  if (name.length == 6 && [name hasPrefix:@"Digit"]) {
    unichar digit = [name characterAtIndex:5];
    if (digit >= '0' && digit <= '9') return (GhosttyKey)(GHOSTTY_KEY_DIGIT_0 + digit - '0');
  }
  if (name.length == 7 && [name hasPrefix:@"Numpad"]) {
    unichar digit = [name characterAtIndex:6];
    if (digit >= '0' && digit <= '9') return (GhosttyKey)(GHOSTTY_KEY_NUMPAD_0 + digit - '0');
  }
  static NSDictionary<NSString *, NSNumber *> *keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    keys = @{@"NumpadEnter": @(GHOSTTY_KEY_NUMPAD_ENTER), @"NumpadAdd": @(GHOSTTY_KEY_NUMPAD_ADD), @"NumpadSubtract": @(GHOSTTY_KEY_NUMPAD_SUBTRACT), @"NumpadMultiply": @(GHOSTTY_KEY_NUMPAD_MULTIPLY), @"NumpadDivide": @(GHOSTTY_KEY_NUMPAD_DIVIDE), @"NumpadDecimal": @(GHOSTTY_KEY_NUMPAD_DECIMAL), @"NumpadEqual": @(GHOSTTY_KEY_NUMPAD_EQUAL), @"NumLock": @(GHOSTTY_KEY_NUM_LOCK), @"ArrowUp": @(GHOSTTY_KEY_ARROW_UP), @"ArrowDown": @(GHOSTTY_KEY_ARROW_DOWN), @"ArrowLeft": @(GHOSTTY_KEY_ARROW_LEFT), @"ArrowRight": @(GHOSTTY_KEY_ARROW_RIGHT),
      @"Enter": @(GHOSTTY_KEY_ENTER), @"Escape": @(GHOSTTY_KEY_ESCAPE), @"Backspace": @(GHOSTTY_KEY_BACKSPACE), @"Tab": @(GHOSTTY_KEY_TAB), @"Space": @(GHOSTTY_KEY_SPACE),
      @"Home": @(GHOSTTY_KEY_HOME), @"End": @(GHOSTTY_KEY_END), @"PageUp": @(GHOSTTY_KEY_PAGE_UP), @"PageDown": @(GHOSTTY_KEY_PAGE_DOWN), @"Insert": @(GHOSTTY_KEY_INSERT), @"Delete": @(GHOSTTY_KEY_DELETE),
      @"Backquote": @(GHOSTTY_KEY_BACKQUOTE), @"Backslash": @(GHOSTTY_KEY_BACKSLASH), @"BracketLeft": @(GHOSTTY_KEY_BRACKET_LEFT), @"BracketRight": @(GHOSTTY_KEY_BRACKET_RIGHT), @"Comma": @(GHOSTTY_KEY_COMMA),
      @"Equal": @(GHOSTTY_KEY_EQUAL), @"Minus": @(GHOSTTY_KEY_MINUS), @"Period": @(GHOSTTY_KEY_PERIOD), @"Quote": @(GHOSTTY_KEY_QUOTE), @"Semicolon": @(GHOSTTY_KEY_SEMICOLON), @"Slash": @(GHOSTTY_KEY_SLASH)};
  });
  if ([name hasPrefix:@"F"] && name.length <= 3) {
    NSInteger function = [[name substringFromIndex:1] integerValue];
    if (function >= 1 && function <= 25) return (GhosttyKey)(GHOSTTY_KEY_F1 + function - 1);
  }
  return keys[name] ? (GhosttyKey)keys[name].intValue : GHOSTTY_KEY_UNIDENTIFIED;
}
- (BOOL)sendKey:(NSString *)name text:(NSString *)text modifiers:(NSUInteger)modifiers action:(NSUInteger)action {
  if (self.readOnly || !self.writeInput || action > 2 || modifiers > 63) return NO;
  NSData *utf8 = [text dataUsingEncoding:NSUTF8StringEncoding];
  if (utf8.length > 1024 * 1024) return NO;
  // The encoder accepts printable layout text, never Cocoa function characters
  // or already transformed control bytes. Special keys use their logical code.
  for (NSUInteger i = 0; i < text.length; i++) {
    unichar character = [text characterAtIndex:i];
    if (character < 32 || character == 127 || (character >= 0xF700 && character <= 0xF8FF)) return NO;
  }
  ghostty_key_encoder_setopt_from_terminal(_keyEncoder, _terminal);
  ghostty_key_event_set_action(_keyEvent, (GhosttyKeyAction)action);
  ghostty_key_event_set_key(_keyEvent, physicalKey(name));
  ghostty_key_event_set_mods(_keyEvent, (GhosttyMods)modifiers);
  ghostty_key_event_set_consumed_mods(_keyEvent, 0);
  ghostty_key_event_set_composing(_keyEvent, false);
  ghostty_key_event_set_unshifted_codepoint(_keyEvent, text.length == 1 ? [text.lowercaseString characterAtIndex:0] : 0);
  ghostty_key_event_set_utf8(_keyEvent, (const char *)utf8.bytes, utf8.length);
  std::vector<char> bytes(utf8.length + 256); size_t written = 0;
  GhosttyResult result = ghostty_key_encoder_encode(_keyEncoder, _keyEvent, bytes.data(), bytes.size(), &written);
  if (result == GHOSTTY_OUT_OF_SPACE && written <= 2 * 1024 * 1024) {
    bytes.resize(written);
    result = ghostty_key_encoder_encode(_keyEncoder, _keyEvent, bytes.data(), bytes.size(), &written);
  }
  if (result != GHOSTTY_SUCCESS) return NO;
  if (written) self.writeInput([NSData dataWithBytes:bytes.data() length:written]);
  return YES;
}
- (BOOL)pasteText:(NSString *)text {
  if (self.readOnly || !self.writeInput) return NO;
  NSMutableData *data = [[text dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  if (data.length > 1024 * 1024) return NO;
  GhosttyTerminalModeConfig mode = {GHOSTTY_MODE_BRACKETED_PASTE, false};
  if (ghostty_terminal_get(_terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode) != GHOSTTY_SUCCESS) return NO;
  std::vector<char> encoded(data.length + 12); size_t written = 0;
  if (ghostty_paste_encode((char *)data.mutableBytes, data.length, mode.value, encoded.data(), encoded.size(), &written) != GHOSTTY_SUCCESS) return NO;
  self.writeInput([NSData dataWithBytes:encoded.data() length:written]);
  return YES;
}
static void fillColor(CGContextRef context, GhosttyColorRgb color) {
  CGContextSetRGBFillColor(context, color.r / 255.0, color.g / 255.0, color.b / 255.0, 1);
}
- (void)drawInContext:(CGContextRef)context size:(CGSize)size {
  CGContextSaveGState(context);
  CGContextSetRGBFillColor(context, 30/255.0, 30/255.0, 46/255.0, 1);
  CGContextFillRect(context, CGRectMake(0, 0, size.width, size.height));
  CGContextSetShouldAntialias(context, false);
  // Backgrounds precede glyphs so a wide glyph is not erased by its tail cell.
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    fillColor(context, _visible[i].background);
    CGContextFillRect(context, CGRectMake(8 + i % _columns * _cellWidth, 8 + i / _columns * _cellHeight, _cellWidth, _cellHeight));
  }
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    CGContextSetShouldAntialias(context, true);
    const auto &cell = _visible[i];
    if (!cell.text.length || cell.invisible) continue;
    CGFloat x = 8 + i % _columns * _cellWidth, y = 8 + i / _columns * _cellHeight;
    CGFloat components[] = {cell.foreground.r/255.0, cell.foreground.g/255.0, cell.foreground.b/255.0, 1};
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGColorRef color = CGColorCreate(space, components); CGColorSpaceRelease(space);
    CTFontRef font = cell.bold && cell.italic ? _boldItalicFont : cell.bold ? _boldFont : cell.italic ? _italicFont : _font;
    NSDictionary *attributes = @{(__bridge NSString *)kCTFontAttributeName: (__bridge id)(font ?: _font), (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)color};
    NSAttributedString *string = [[NSAttributedString alloc] initWithString:cell.text attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)string);
    CGContextSaveGState(context); CGContextTranslateCTM(context, x, y + _ascent); CGContextScaleCTM(context, 1, -1);
    CGContextSetTextMatrix(context, CGAffineTransformIdentity); CGContextSetTextPosition(context, 0, 0); CTLineDraw(line, context);
    CGContextRestoreGState(context); CFRelease(line); CGColorRelease(color);
    fillColor(context, cell.foreground);
    if (cell.underline) CGContextFillRect(context, CGRectMake(x, y + _cellHeight - 2, _cellWidth, 1));
    if (cell.strike) CGContextFillRect(context, CGRectMake(x, y + _cellHeight / 2, _cellWidth, 1));
  }
  if (_cursor.visible && _cursor.viewport_has_value) {
    CGRect cursor = CGRectMake(8 + _cursor.viewport_x * _cellWidth, 8 + _cursor.viewport_y * _cellHeight, _cellWidth, _cellHeight);
    CGContextSetRGBStrokeColor(context, 245/255.0, 224/255.0, 220/255.0, 1);
    CGContextStrokeRectWithWidth(context, CGRectInset(cursor, 0.5, 0.5), 1);
  }
  CGContextRestoreGState(context);
}
- (void)scrollLines:(NSInteger)lines {
  GhosttyTerminalScrollViewport scroll = {GHOSTTY_SCROLL_VIEWPORT_DELTA, {}};
  scroll.value.delta = lines;
  ghostty_terminal_scroll_viewport(_terminal, scroll);
  [self updateFrame];
}
@end

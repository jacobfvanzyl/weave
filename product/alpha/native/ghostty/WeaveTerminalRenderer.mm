#include <WeaveTerminalCodec.h>
#import "WeaveTerminalRenderer.h"
#import <CoreText/CoreText.h>
#include <ghostty/vt.h>
#include <vector>
#include <algorithm>

@interface WeaveTerminalRenderer (SnapshotReader)
- (BOOL)readSnapshot:(uint8_t *)buffer length:(size_t)length count:(size_t *)count;
@end
static bool readSnapshot(void *context, uint8_t *buffer, size_t length, size_t *count) {
  return [(__bridge WeaveTerminalRenderer *)context readSnapshot:buffer length:length count:count];
}
static BOOL fontsRegistered = NO;

struct WeaveCell {
  __strong NSString *text = @"";
  GhosttyColorRgb foreground{}, background{};
  bool tail = false, spacer = false, bold = false, italic = false, underline = false, strike = false, invisible = false;
};
@implementation WeaveTerminalRenderer {
  GhosttyTerminal _terminal;
  GhosttyMouseEncoder _mouseEncoder;
  GhosttyMouseEvent _mouseEvent;
  GhosttyKeyEncoder _keyEncoder;
  GhosttyKeyEvent _keyEvent;
  GhosttyRenderState _frame;
  GhosttyRenderStateRowIterator _iterator;
  GhosttyRenderStateRowCells _cells;
  CTFontRef _font, _boldFont, _italicFont, _boldItalicFont;
  NSUInteger _columns, _rows;
  CGFloat _cellWidth, _cellHeight, _ascent;
  GhosttySnapshotDecoder _snapshotDecoder;
  NSData *_snapshotBytes;
  NSUInteger _snapshotOffset;
  std::vector<WeaveCell> _visible;
  std::vector<bool> _wrapped;
  GhosttyRenderStateCursor _cursor;
  GhosttyColorRgb _cursorColor;
  NSString *_visibleTextCache;
  NSCache<NSString *, id> *_lineCache;
  CGColorSpaceRef _colorSpace;
}
+ (NSString *)codecIdentity { return @WEAVE_TERMINAL_CODEC; }
@synthesize columns = _columns, rows = _rows, cellWidth = _cellWidth, cellHeight = _cellHeight;
+ (BOOL)registerFontsAtURL:(NSURL *)directory {
  if (fontsRegistered) return YES;
  for (NSString *style in @[@"Regular", @"Bold", @"Italic", @"BoldItalic"]) {
    NSURL *url = [directory URLByAppendingPathComponent:[NSString stringWithFormat:@"JetBrainsMonoNerdFont-%@.ttf", style]];
    if (![[NSFileManager defaultManager] fileExistsAtPath:url.path]) return NO;
    CFErrorRef error = NULL;
    BOOL registered = CTFontManagerRegisterFontsForURL((__bridge CFURLRef)url, kCTFontManagerScopeProcess, &error);
    BOOL alreadyRegistered = error && CFErrorGetCode(error) == kCTFontManagerErrorAlreadyRegistered;
    if (error) CFRelease(error);
    if (!registered && !alreadyRegistered) return NO;
  }
  fontsRegistered = YES;
  return YES;
}
- (NSString *)fontName { return CFBridgingRelease(CTFontCopyPostScriptName(_font)); }
+ (instancetype)make { return [[self alloc] init]; }
- (instancetype)init {
  if (!(self = [super init])) return nil;
  _columns = 80; _rows = 24;
  _lineCache = [NSCache new]; _lineCache.countLimit = 4096;
  _colorSpace = CGColorSpaceCreateDeviceRGB();
  // Web @font-face does not register fonts for CoreText. Both application
  // bundles ship these exact fonts; standalone probes register the same files.
  if (![WeaveTerminalRenderer registerFontsAtURL:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"TerminalFonts"]]) return nil;
  _font = CTFontCreateWithName(CFSTR("JetBrainsMonoNF-Regular"), 13, NULL);
  if (![self.fontName isEqualToString:@"JetBrainsMonoNF-Regular"]) return nil;
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
  if (ghostty_mouse_encoder_new(NULL, &_mouseEncoder) != GHOSTTY_SUCCESS || ghostty_mouse_event_new(NULL, &_mouseEvent) != GHOSTTY_SUCCESS || ghostty_key_encoder_new(NULL, &_keyEncoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &_keyEvent) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &_frame) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &_iterator) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &_cells) != GHOSTTY_SUCCESS || ![self newTerminal]) return nil;
  return self;
}
- (void)dealloc {
  ghostty_snapshot_decoder_free(_snapshotDecoder);
  ghostty_mouse_event_free(_mouseEvent); ghostty_mouse_encoder_free(_mouseEncoder);
  ghostty_key_encoder_free(_keyEncoder);
  ghostty_key_event_free(_keyEvent);
  ghostty_terminal_free(_terminal);
  ghostty_render_state_row_cells_free(_cells);
  ghostty_render_state_row_iterator_free(_iterator);
  ghostty_render_state_free(_frame);
  if (_colorSpace) CGColorSpaceRelease(_colorSpace);
  if (_font) CFRelease(_font);
  if (_boldFont) CFRelease(_boldFont);
  if (_italicFont) CFRelease(_italicFont);
  if (_boldItalicFont) CFRelease(_boldItalicFont);
}
- (BOOL)newTerminal {
  GhosttyTerminal next = NULL;
  if (ghostty_terminal_new(NULL, &next, (uint16_t)_columns, (uint16_t)_rows) != GHOSTTY_SUCCESS) return NO;
  ghostty_terminal_free(_terminal); _terminal = next;
  GhosttyColorRgb background = {30, 30, 46}, foreground = {205, 214, 244};
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  GhosttyColorRgb cursor = {245, 224, 220};
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
  GhosttyColorRgb palette[256];
  ghostty_terminal_get(_terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE, &palette);
  const GhosttyColorRgb theme[] = {{69,71,90},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{186,194,222},
    {88,91,112},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{166,173,200}};
  std::copy(std::begin(theme), std::end(theme), palette);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, &palette);
  GhosttyTerminalModeConfig graphemes = { GHOSTTY_MODE_GRAPHEME_CLUSTER, true };
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  size_t bytes = 16 * 1024 * 1024, lines = 10000;
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &bytes);
  ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  // Display replicas never register PTY/effect callbacks. The Host authority
  // answers application queries exactly once; human encoders remain enabled.
  return YES;
}
- (BOOL)restoreData:(NSData *)data columns:(NSUInteger)columns rows:(NSUInteger)rows {
  if (columns < 2 || columns > 500 || rows < 2 || rows > 300) return NO;
  _columns = columns; _rows = rows;
  return [self consume:data reset:YES];
}
- (BOOL)consume:(NSData *)data reset:(BOOL)reset {
  NSAssert(NSThread.isMainThread, @"Native terminal must be used on the main thread");
  if (data.length > 64 * 1024 * 1024) return NO;
  if (reset) {
    ghostty_snapshot_decoder_free(_snapshotDecoder); _snapshotDecoder = NULL; _snapshotBytes = nil;
    GhosttySnapshotDecoder decoder = NULL; GhosttyTerminal next = NULL;
    self->_snapshotBytes = data; self->_snapshotOffset = 0;
    if (ghostty_snapshot_decoder_new(NULL, &decoder, {readSnapshot, (__bridge void *)self}) != GHOSTTY_SUCCESS) { _snapshotBytes = nil; _snapshotOffset = 0; return NO; }
    if (ghostty_snapshot_decoder_ready(decoder, &next) != GHOSTTY_SUCCESS) { ghostty_snapshot_decoder_free(decoder); _snapshotBytes = nil; _snapshotOffset = 0; return NO; }
    ghostty_terminal_free(_terminal); _terminal = next;
    size_t noImages = 0;
    ghostty_terminal_set(_terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &noImages);
    _visible.clear(); _wrapped.clear(); _visibleTextCache = nil;
    _snapshotBytes = data; _snapshotDecoder = decoder;
    if (_snapshotOffset < data.length) {
      GhosttyResult status;
      do { status = ghostty_snapshot_decoder_next(decoder); } while (status == GHOSTTY_SUCCESS);
      BOOL valid = status == GHOSTTY_NO_VALUE && _snapshotOffset == data.length;
      ghostty_snapshot_decoder_free(decoder); _snapshotDecoder = NULL;
      _snapshotBytes = nil; _snapshotOffset = 0;
      if (!valid) return NO;
    } else { _snapshotBytes = nil; _snapshotOffset = 0; }
  } else {
    ghostty_terminal_vt_write(_terminal, (const uint8_t *)data.bytes, data.length);
  }
  return YES;
}
- (BOOL)readSnapshot:(uint8_t *)buffer length:(size_t)length count:(size_t *)count {
  *count = MIN(length, _snapshotBytes.length - _snapshotOffset);
  if (*count) memcpy(buffer, (const uint8_t *)_snapshotBytes.bytes + _snapshotOffset, *count);
  _snapshotOffset += *count; return YES;
}
- (BOOL)appendHistory:(NSData *)data {
  if (!_snapshotDecoder || data.length > 2 * 1024 * 1024) return NO;
  _snapshotBytes = data; _snapshotOffset = 0;
  GhosttyResult result = ghostty_snapshot_decoder_next(_snapshotDecoder);
  BOOL consumed = _snapshotOffset == data.length;
  _snapshotBytes = nil; _snapshotOffset = 0;
  if (result != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(_snapshotDecoder); _snapshotDecoder = NULL;
  }
  return consumed && (result == GHOSTTY_SUCCESS || result == GHOSTTY_NO_VALUE);
}
- (CGSize)gridForViewportSize:(CGSize)size {
  NSUInteger columns = std::clamp((NSInteger)floor((size.width - 16) / _cellWidth), (NSInteger)2, (NSInteger)500);
  NSUInteger rows = std::clamp((NSInteger)floor((size.height - 16) / _cellHeight), (NSInteger)2, (NSInteger)300);
  return CGSizeMake(columns, rows);
}
- (BOOL)resizeToSize:(CGSize)size {
  CGSize grid = [self gridForViewportSize:size];
  NSUInteger columns = grid.width, rows = grid.height;
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
  if (_visible.size() != _rows * _columns) {
    _visible.resize(_rows * _columns); _wrapped.resize(_rows); _visibleTextCache = nil;
    GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_set(_frame, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &dirty);
  }
  uint16_t y = 0;
  while (ghostty_render_state_row_iterator_next_dirty(_iterator, &y)) {
    if (y >= _rows) return NO;
    NSUInteger x = 0;
    GhosttyRow row; bool wrapped = false;
    ghostty_render_state_row_get(_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_RAW, &row);
    ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP, &wrapped); _wrapped[y] = wrapped;
    ghostty_render_state_row_get(_iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &_cells);
    while (ghostty_render_state_row_cells_next(_cells)) {
      WeaveCell cell;
      GhosttyCell raw; GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      ghostty_render_state_row_cells_get(_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
      cell.tail = wide == GHOSTTY_CELL_WIDE_SPACER_TAIL;
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
      if (x >= _columns) return NO;
      auto &previous = _visible[y * _columns + x++];
      if (previous.spacer != cell.spacer || ![previous.text isEqualToString:cell.text]) _visibleTextCache = nil;
      previous = cell;
    }
  }
  _cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_CURSOR, &_cursor);
  _cursorColor = {245, 224, 220};
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR, &_cursorColor);
  ghostty_render_state_clean(_frame);
  return YES;
}
- (CGRect)cursorRect { [self updateFrame]; return CGRectMake(8 + _cursor.viewport_x * _cellWidth, 8 + _cursor.viewport_y * _cellHeight, _cellWidth, _cellHeight); }
- (NSString *)visibleText {
  [self updateFrame];
  if (_visibleTextCache) return _visibleTextCache;
  NSMutableString *text = [NSMutableString string];
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    if (!_visible[i].spacer) [text appendString:_visible[i].text.length ? _visible[i].text : @" "];
    if ((i + 1) % _columns == 0 && i + 1 < _visible.size()) [text appendString:@"\n"];
  }
  _visibleTextCache = [text copy]; return _visibleTextCache;
}
- (NSString *)textForVisibleRange:(NSRange)range {
  [self updateFrame];
  if (!range.length || range.location == NSNotFound) return @"";
  NSUInteger offset = 0, start = NSNotFound, end = 0;
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    NSUInteger length = _visible[i].spacer ? 0 : MAX((NSUInteger)1, _visible[i].text.length);
    if (offset + length > range.location && offset < NSMaxRange(range)) { if (start == NSNotFound) start = i; end = i + 1; }
    offset += length;
    if ((i + 1) % _columns == 0) offset++;
  }
  return start == NSNotFound ? @"" : [self textFromCell:start count:end - start];
}
- (NSString *)textFromCell:(NSUInteger)start count:(NSUInteger)count {
  [self updateFrame];
  NSMutableString *text = [NSMutableString string];
  if (start >= _visible.size() || !count) return text;
  NSUInteger end = start + MIN(count, _visible.size() - start);
  if (_visible[start].tail && start > 0) start--;
  for (NSUInteger i = start; i < end; i++) {
    if (!_visible[i].spacer) [text appendString:_visible[i].text.length ? _visible[i].text : @" "];
    if ((i + 1) % _columns == 0 && i + 1 < end && !_wrapped[i / _columns]) {
      while ([text hasSuffix:@" "]) [text deleteCharactersInRange:NSMakeRange(text.length - 1, 1)];
      [text appendString:@"\n"];
    }
  }
  return text;
}
- (BOOL)mouseReporting {
  bool mode = false;
  ghostty_terminal_get(_terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &mode);
  return mode && !self.readOnly;
}
- (BOOL)sendMouseAt:(CGPoint)point button:(NSUInteger)button action:(NSUInteger)action modifiers:(NSUInteger)modifiers {
  if (!self.mouseReporting || !self.writeInput || (modifiers & 1) || button > 11 || action > 2) return NO;
  ghostty_mouse_encoder_setopt_from_terminal(_mouseEncoder, _terminal);
  // Encode cell coordinates using integral cell units; font advances can be fractional.
  GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
  size.screen_width = (uint32_t)_columns; size.screen_height = (uint32_t)_rows; size.cell_width = 1; size.cell_height = 1;
  ghostty_mouse_encoder_setopt(_mouseEncoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
  bool pressed = button >= 1 && button <= 3 && action != 1;
  ghostty_mouse_encoder_setopt(_mouseEncoder, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &pressed);
  ghostty_mouse_event_set_action(_mouseEvent, (GhosttyMouseAction)action);
  if (button) ghostty_mouse_event_set_button(_mouseEvent, (GhosttyMouseButton)button); else ghostty_mouse_event_clear_button(_mouseEvent);
  ghostty_mouse_event_set_mods(_mouseEvent, (GhosttyMods)modifiers);
  GhosttyMousePosition position = {(float)MAX(0, (point.x - 8) / _cellWidth), (float)MAX(0, (point.y - 8) / _cellHeight)};
  ghostty_mouse_event_set_position(_mouseEvent, position);
  char bytes[128]; size_t written = 0;
  if (ghostty_mouse_encoder_encode(_mouseEncoder, _mouseEvent, bytes, sizeof(bytes), &written) != GHOSTTY_SUCCESS) return NO;
  if (written) self.writeInput([NSData dataWithBytes:bytes length:written]);
  return YES;
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
  [self updateFrame];
  CGContextSaveGState(context);
  CGContextClipToRect(context, CGRectMake(0, 0, size.width, size.height));
  CGContextSetRGBFillColor(context, 30/255.0, 30/255.0, 46/255.0, 1);
  CGContextFillRect(context, CGRectMake(0, 0, size.width, size.height));
  CGContextSetShouldAntialias(context, false);
  // Backgrounds precede glyphs so a wide glyph is not erased by its tail cell.
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    if (8 + i / _columns * _cellHeight >= size.height) break;
    if (8 + i % _columns * _cellWidth >= size.width) continue;
    fillColor(context, _visible[i].background);
    CGContextFillRect(context, CGRectMake(8 + i % _columns * _cellWidth, 8 + i / _columns * _cellHeight, _cellWidth, _cellHeight));
  }
  const BOOL cursorVisible = _cursor.visible && _cursor.viewport_has_value;
  const NSUInteger cursorCell = cursorVisible ? _cursor.viewport_y * _columns + _cursor.viewport_x : NSNotFound;
  const BOOL blockCursor = cursorVisible && _cursor.visual_style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  if (blockCursor) { fillColor(context, _cursorColor); CGContextFillRect(context, self.cursorRect); }
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    if (8 + i / _columns * _cellHeight >= size.height) break;
    if (8 + i % _columns * _cellWidth >= size.width) continue;
    CGContextSetShouldAntialias(context, true);
    const auto &cell = _visible[i];
    if (!cell.text.length || cell.invisible) continue;
    CGFloat x = 8 + i % _columns * _cellWidth, y = 8 + i / _columns * _cellHeight;
    GhosttyColorRgb foreground = blockCursor && i == cursorCell ? cell.background : cell.foreground;
    NSString *cacheKey = [NSString stringWithFormat:@"%d:%d:%u:%u:%u:%@", cell.bold, cell.italic, foreground.r, foreground.g, foreground.b, cell.text];
    id cached = [_lineCache objectForKey:cacheKey];
    CTLineRef line = (__bridge CTLineRef)cached;
    if (!line) {
      CGFloat components[] = {foreground.r/255.0, foreground.g/255.0, foreground.b/255.0, 1};
      CGColorRef color = CGColorCreate(_colorSpace, components);
      CTFontRef font = cell.bold && cell.italic ? _boldItalicFont : cell.bold ? _boldFont : cell.italic ? _italicFont : _font;
      NSDictionary *attributes = @{(__bridge NSString *)kCTFontAttributeName: (__bridge id)(font ?: _font), (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)color};
      NSAttributedString *string = [[NSAttributedString alloc] initWithString:cell.text attributes:attributes];
      line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)string);
      cached = CFBridgingRelease(line); [_lineCache setObject:cached forKey:cacheKey]; CGColorRelease(color);
    }
    CGContextSaveGState(context); CGContextTranslateCTM(context, x, y + _ascent); CGContextScaleCTM(context, 1, -1);
    CGContextSetTextMatrix(context, CGAffineTransformIdentity); CGContextSetTextPosition(context, 0, 0); CTLineDraw(line, context);
    CGContextRestoreGState(context);
    fillColor(context, cell.foreground);
    if (cell.underline) CGContextFillRect(context, CGRectMake(x, y + _cellHeight - 2, _cellWidth, 1));
    if (cell.strike) CGContextFillRect(context, CGRectMake(x, y + _cellHeight / 2, _cellWidth, 1));
  }
  if (cursorVisible && !blockCursor) {
    CGRect cursor = self.cursorRect;
    fillColor(context, _cursorColor);
    switch (_cursor.visual_style) {
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR:
        cursor.size.width = 2; CGContextFillRect(context, cursor); break;
      case GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE:
        cursor.origin.y += cursor.size.height - 2; cursor.size.height = 2;
        CGContextFillRect(context, cursor); break;
      default:
        CGContextSetRGBStrokeColor(context, _cursorColor.r/255.0, _cursorColor.g/255.0, _cursorColor.b/255.0, 1);
        CGContextStrokeRectWithWidth(context, CGRectInset(cursor, 0.5, 0.5), 1); break;
    }
  }
  CGContextRestoreGState(context);
}
// The square native surface sits one CSS border-width inside the web frame.
// Paint the part of its rounded stroke that overlaps this surface, after content,
// so the native background cannot erase the corner arcs. Never round the clip.
- (void)drawFocusBorderInContext:(CGContextRef)context size:(CGSize)size {
  if (_focusBorderWidth <= 0 || size.width <= 0 || size.height <= 0) return;
  CGFloat half = _focusBorderWidth / 2;
  CGRect rect = CGRectInset(CGRectMake(0, 0, size.width, size.height), -half, -half);
  CGFloat radius = MAX(0, _focusBorderRadius - half);
  CGPathRef path = CGPathCreateWithRoundedRect(rect, radius, radius, NULL);
  CGContextSaveGState(context);
  CGContextClipToRect(context, CGRectMake(0, 0, size.width, size.height));
  CGContextSetRGBStrokeColor(context, ((_focusBorderRGB >> 16) & 255)/255.0, ((_focusBorderRGB >> 8) & 255)/255.0, (_focusBorderRGB & 255)/255.0, 1);
  CGContextSetLineWidth(context, _focusBorderWidth);
  CGContextAddPath(context, path); CGContextStrokePath(context);
  CGContextRestoreGState(context); CGPathRelease(path);
}
- (void)scrollLines:(NSInteger)lines {
  GhosttyTerminalScrollViewport scroll = {GHOSTTY_SCROLL_VIEWPORT_DELTA, {}};
  scroll.value.delta = lines;
  ghostty_terminal_scroll_viewport(_terminal, scroll);
  [self updateFrame];
}
@end

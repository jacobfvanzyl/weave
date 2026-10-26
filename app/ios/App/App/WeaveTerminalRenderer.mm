// Brought back from e30f6e93 (product/alpha/native/ghostty) by way of the WVE-150 spike.
#import "WeaveTerminalRenderer.h"
#import <CoreText/CoreText.h>
#include <ghostty/vt.h>
#include "weave_ghostty_pin.h"
#include <vector>
#include <algorithm>

static BOOL fontsRegistered = NO;
static const CGFloat padding = 8;
// Catppuccin Mocha, the app's own colors.
static const GhosttyColorRgb themeBackground = {30, 30, 46}, themeForeground = {205, 214, 244}, themeCursor = {245, 224, 220};
static const GhosttyColorRgb themePalette[] = {{69,71,90},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{186,194,222},
  {88,91,112},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{166,173,200}};

struct WeaveCell {
  __strong NSString *text = @"";
  GhosttyColorRgb foreground{}, background{};
  bool tail = false, spacer = false, bold = false, italic = false, underline = false, strike = false, invisible = false;
};

/** The embedder's defaults: programs' own colors (OSC 4, 10, 11) stay over them. */
static void applyTheme(GhosttyTerminal terminal) {
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &themeBackground);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &themeForeground);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &themeCursor);
  GhosttyColorRgb palette[256];
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, NULL);
  ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT, &palette);
  std::copy(std::begin(themePalette), std::end(themePalette), palette);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, &palette);
  size_t bytes = 16 * 1024 * 1024, lines = 10000, noImages = 0;
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &bytes);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &noImages);
  // A replica registers no PTY or effect callbacks: the holder answers the program's queries,
  // once. Its key and mouse encoders still read the modes.
}

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
  CGFloat _fontSize;
  NSUInteger _columns, _rows;
  CGFloat _cellWidth, _cellHeight, _ascent;
  NSUInteger _restores;
  std::vector<WeaveCell> _visible;
  std::vector<bool> _wrapped;
  GhosttyRenderStateCursor _cursor;
  GhosttyColorRgb _cursorColor;
  NSString *_visibleTextCache;
  NSCache<NSString *, id> *_lineCache;
  CGColorSpaceRef _colorSpace;
}
@synthesize columns = _columns, rows = _rows, cellWidth = _cellWidth, cellHeight = _cellHeight;

+ (NSString *)codec {
  static NSString *codec;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // libghostty-vt reports one snapshot version at every commit, so the commit tells builds apart.
    unsigned version = 0;
    GhosttyTerminal blank = NULL;
    if (ghostty_terminal_new(NULL, &blank, 2, 2) == GHOSTTY_SUCCESS) {
      uint8_t *bytes = NULL; size_t length = 0;
      if (ghostty_snapshot_encode_alloc(blank, NULL, &bytes, &length) == GHOSTTY_SUCCESS && length >= 10) version = bytes[8] | bytes[9] << 8;
      if (bytes) ghostty_free(NULL, bytes, length);
      ghostty_terminal_free(blank);
    }
    codec = [NSString stringWithFormat:@"ghostty %s snapshot %u", WEAVE_GHOSTTY_COMMIT, version];
  });
  return codec;
}
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
+ (instancetype)rendererWithFontSize:(CGFloat)fontSize {
  // Web @font-face doesn't register fonts for CoreText; the bundle ships the same files.
  if (![self registerFontsAtURL:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"TerminalFonts"]]) return nil;
  return [[self alloc] initWithFontSize:fontSize];
}
- (NSString *)fontName { return CFBridgingRelease(CTFontCopyPostScriptName(_font)); }
- (instancetype)initWithFontSize:(CGFloat)fontSize {
  if (!(self = [super init])) return nil;
  _columns = 80; _rows = 24;
  _lineCache = [NSCache new]; _lineCache.countLimit = 4096;
  _colorSpace = CGColorSpaceCreateDeviceRGB();
  if (![self loadFontsOfSize:fontSize]) return nil;
  if (ghostty_mouse_encoder_new(NULL, &_mouseEncoder) != GHOSTTY_SUCCESS || ghostty_mouse_event_new(NULL, &_mouseEvent) != GHOSTTY_SUCCESS || ghostty_key_encoder_new(NULL, &_keyEncoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &_keyEvent) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &_frame) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &_iterator) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &_cells) != GHOSTTY_SUCCESS || ![self resetToColumns:_columns rows:_rows]) return nil;
  return self;
}
- (void)dealloc {
  ghostty_mouse_event_free(_mouseEvent); ghostty_mouse_encoder_free(_mouseEncoder);
  ghostty_key_encoder_free(_keyEncoder);
  ghostty_key_event_free(_keyEvent);
  ghostty_terminal_free(_terminal);
  ghostty_render_state_row_cells_free(_cells);
  ghostty_render_state_row_iterator_free(_iterator);
  ghostty_render_state_free(_frame);
  if (_colorSpace) CGColorSpaceRelease(_colorSpace);
  [self releaseFonts];
}
- (void)releaseFonts {
  if (_font) CFRelease(_font);
  if (_boldFont) CFRelease(_boldFont);
  if (_italicFont) CFRelease(_italicFont);
  if (_boldItalicFont) CFRelease(_boldItalicFont);
  _font = _boldFont = _italicFont = _boldItalicFont = NULL;
}
- (BOOL)loadFontsOfSize:(CGFloat)size {
  size = std::clamp(size, (CGFloat)8, (CGFloat)32);
  CTFontRef font = CTFontCreateWithName(CFSTR("JetBrainsMonoNF-Regular"), size, NULL);
  NSString *name = font ? CFBridgingRelease(CTFontCopyPostScriptName(font)) : nil;
  if (![name isEqualToString:@"JetBrainsMonoNF-Regular"]) { if (font) CFRelease(font); return NO; }
  [self releaseFonts];
  _font = font; _fontSize = size;
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
  [_lineCache removeAllObjects];
  return YES;
}
- (CGFloat)fontSize { return _fontSize; }
- (void)setFontSize:(CGFloat)fontSize {
  if (fontSize == _fontSize || ![self loadFontsOfSize:fontSize]) return;
  // The grid is the terminal's: only the pixel sizes the program can ask for change.
  ghostty_terminal_resize(_terminal, (uint16_t)_columns, (uint16_t)_rows, (uint32_t)ceil(_cellWidth), (uint32_t)ceil(_cellHeight));
}
- (void)replaceTerminal:(GhosttyTerminal)next {
  ghostty_terminal_free(_terminal); _terminal = next;
  uint16_t columns = 0, rows = 0;
  ghostty_terminal_get(_terminal, GHOSTTY_TERMINAL_DATA_COLS, &columns);
  ghostty_terminal_get(_terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows);
  _columns = std::max<NSUInteger>(columns, 1); _rows = std::max<NSUInteger>(rows, 1);
  _visible.clear(); _wrapped.clear(); _visibleTextCache = nil;
}
- (BOOL)resetToColumns:(NSUInteger)columns rows:(NSUInteger)rows {
  NSAssert(NSThread.isMainThread, @"A terminal's screen is used on the main thread");
  if (columns < 1 || columns > 1000 || rows < 1 || rows > 500) return NO;
  GhosttyTerminal next = NULL;
  if (ghostty_terminal_new(NULL, &next, (uint16_t)columns, (uint16_t)rows) != GHOSTTY_SUCCESS) return NO;
  applyTheme(next);
  GhosttyTerminalModeConfig graphemes = {GHOSTTY_MODE_GRAPHEME_CLUSTER, true};
  ghostty_terminal_set(next, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  ghostty_terminal_resize(next, (uint16_t)columns, (uint16_t)rows, (uint32_t)ceil(_cellWidth), (uint32_t)ceil(_cellHeight));
  _restores++;
  [self replaceTerminal:next];
  return YES;
}
- (void)restoreSnapshot:(NSData *)snapshot completion:(void (^)(BOOL))completion {
  NSAssert(NSThread.isMainThread, @"A terminal's screen is used on the main thread");
  // A restore that another overtakes is dropped.
  NSUInteger restore = ++_restores;
  __weak WeaveTerminalRenderer *weakSelf = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    GhosttySnapshotDecoder decoder = NULL; GhosttyTerminal next = NULL;
    if (ghostty_snapshot_decoder_new_buf(NULL, &decoder, (const uint8_t *)snapshot.bytes, snapshot.length) == GHOSTTY_SUCCESS &&
        ghostty_snapshot_decoder_decode(decoder, &next) != GHOSTTY_SUCCESS) next = NULL;
    ghostty_snapshot_decoder_free(decoder);
    if (next) applyTheme(next);
    dispatch_async(dispatch_get_main_queue(), ^{
      WeaveTerminalRenderer *renderer = weakSelf;
      if (!renderer || renderer->_restores != restore) { ghostty_terminal_free(next); if (renderer) completion(NO); return; }
      if (next) [renderer replaceTerminal:next];
      completion(next != NULL);
    });
  });
}
- (void)write:(NSData *)output {
  NSAssert(NSThread.isMainThread, @"A terminal's screen is used on the main thread");
  ghostty_terminal_vt_write(_terminal, (const uint8_t *)output.bytes, output.length);
}
- (BOOL)resizeToColumns:(NSUInteger)columns rows:(NSUInteger)rows {
  if (columns < 1 || columns > 1000 || rows < 1 || rows > 500) return NO;
  if (columns == _columns && rows == _rows) return YES;
  if (ghostty_terminal_resize(_terminal, (uint16_t)columns, (uint16_t)rows, (uint32_t)ceil(_cellWidth), (uint32_t)ceil(_cellHeight)) != GHOSTTY_SUCCESS) return NO;
  _columns = columns; _rows = rows;
  return [self updateFrame];
}
- (CGSize)gridForViewportSize:(CGSize)size {
  NSUInteger columns = std::clamp((NSInteger)floor((size.width - 2 * padding) / _cellWidth), (NSInteger)2, (NSInteger)500);
  NSUInteger rows = std::clamp((NSInteger)floor((size.height - 2 * padding) / _cellHeight), (NSInteger)2, (NSInteger)300);
  return CGSizeMake(columns, rows);
}
- (BOOL)updateFrame {
  if (ghostty_render_state_update(_frame, _terminal) != GHOSTTY_SUCCESS) return NO;
  GhosttyColorRgb background = themeBackground, foreground = themeForeground;
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_BACKGROUND, &background);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_FOREGROUND, &foreground);
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &_iterator);
  if (_visible.size() != _rows * _columns) {
    _visible.assign(_rows * _columns, WeaveCell()); _wrapped.assign(_rows, false); _visibleTextCache = nil;
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
  _cursorColor = themeCursor;
  ghostty_render_state_get(_frame, GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR, &_cursorColor);
  ghostty_render_state_clean(_frame);
  return YES;
}
- (CGRect)cursorRect { [self updateFrame]; return CGRectMake(padding + _cursor.viewport_x * _cellWidth, padding + _cursor.viewport_y * _cellHeight, _cellWidth, _cellHeight); }
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
  GhosttyMousePosition position = {(float)MAX(0, (point.x - padding) / _cellWidth), (float)MAX(0, (point.y - padding) / _cellHeight)};
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
/** The US layout's key for a character, and whether it takes Shift. */
static NSString *usKey(unichar character, BOOL *shifted) {
  *shifted = NO;
  if (character >= 'a' && character <= 'z') return [NSString stringWithFormat:@"Key%C", (unichar)(character - 32)];
  if (character >= 'A' && character <= 'Z') { *shifted = YES; return [NSString stringWithFormat:@"Key%C", character]; }
  if (character >= '0' && character <= '9') return [NSString stringWithFormat:@"Digit%C", character];
  static NSDictionary<NSString *, NSString *> *plain, *shift;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    plain = @{@" ": @"Space", @"-": @"Minus", @"=": @"Equal", @"[": @"BracketLeft", @"]": @"BracketRight", @"\\": @"Backslash", @";": @"Semicolon", @"'": @"Quote", @",": @"Comma", @".": @"Period", @"/": @"Slash", @"`": @"Backquote"};
    shift = @{@"_": @"Minus", @"+": @"Equal", @"{": @"BracketLeft", @"}": @"BracketRight", @"|": @"Backslash", @":": @"Semicolon", @"\"": @"Quote", @"<": @"Comma", @">": @"Period", @"?": @"Slash", @"~": @"Backquote",
      @"!": @"Digit1", @"@": @"Digit2", @"#": @"Digit3", @"$": @"Digit4", @"%": @"Digit5", @"^": @"Digit6", @"&": @"Digit7", @"*": @"Digit8", @"(": @"Digit9", @")": @"Digit0"};
  });
  NSString *string = [NSString stringWithCharacters:&character length:1];
  if (shift[string]) { *shifted = YES; return shift[string]; }
  return plain[string];
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
- (BOOL)sendText:(NSString *)value modifiers:(NSUInteger)modifiers {
  if (self.readOnly || !self.writeInput) return NO;
  BOOL sent = YES;
  NSMutableString *text = [NSMutableString string];
  void (^flush)(void) = ^{
    if (text.length) { if (![self sendKey:@"Unidentified" text:text modifiers:0 action:1]) return; [text setString:@""]; }
  };
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar character = [value characterAtIndex:i];
    if (character < 32 || character == 127) {
      // The keyboard's control characters, as the keys that make them.
      flush();
      NSString *key; NSUInteger mods = 0;
      switch (character) {
        case 10: case 13: key = @"Enter"; break;
        case 9: key = @"Tab"; break;
        case 27: key = @"Escape"; break;
        case 127: key = @"Backspace"; break;
        case 0: key = @"Space"; mods = 2; break;
        case 28: key = @"Backslash"; mods = 2; break;
        case 29: key = @"BracketRight"; mods = 2; break;
        case 30: key = @"Digit6"; mods = 2; break;
        case 31: key = @"Minus"; mods = 2; break;
        default: key = [NSString stringWithFormat:@"Key%C", (unichar)(character + 64)]; mods = 2;
      }
      sent = [self sendKey:key text:@"" modifiers:mods | modifiers action:1] && sent;
      continue;
    }
    BOOL shifted = NO;
    NSString *key = modifiers ? usKey(character, &shifted) : nil;
    if (key) {
      flush();
      sent = [self sendKey:key text:[value substringWithRange:NSMakeRange(i, 1)] modifiers:modifiers | (shifted ? 1 : 0) action:1] && sent;
    } else {
      NSRange composed = [value rangeOfComposedCharacterSequenceAtIndex:i];
      [text appendString:[value substringWithRange:composed]];
      i = NSMaxRange(composed) - 1;
    }
  }
  flush();
  return sent && !text.length;
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
  fillColor(context, themeBackground);
  CGContextFillRect(context, CGRectMake(0, 0, size.width, size.height));
  CGContextSetShouldAntialias(context, false);
  // Backgrounds precede glyphs so a wide glyph is not erased by its tail cell.
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    if (padding + i / _columns * _cellHeight >= size.height) break;
    if (padding + i % _columns * _cellWidth >= size.width) continue;
    fillColor(context, _visible[i].background);
    CGContextFillRect(context, CGRectMake(padding + i % _columns * _cellWidth, padding + i / _columns * _cellHeight, _cellWidth, _cellHeight));
  }
  const BOOL cursorVisible = _cursor.visible && _cursor.viewport_has_value;
  const NSUInteger cursorCell = cursorVisible ? _cursor.viewport_y * _columns + _cursor.viewport_x : NSNotFound;
  const BOOL blockCursor = cursorVisible && _cursor.visual_style == GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  if (blockCursor) { fillColor(context, _cursorColor); CGContextFillRect(context, self.cursorRect); }
  for (NSUInteger i = 0; i < _visible.size(); i++) {
    if (padding + i / _columns * _cellHeight >= size.height) break;
    if (padding + i % _columns * _cellWidth >= size.width) continue;
    CGContextSetShouldAntialias(context, true);
    const auto &cell = _visible[i];
    if (!cell.text.length || cell.invisible) continue;
    CGFloat x = padding + i % _columns * _cellWidth, y = padding + i / _columns * _cellHeight;
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
- (void)scrollLines:(NSInteger)lines {
  GhosttyTerminalScrollViewport scroll = {GHOSTTY_SCROLL_VIEWPORT_DELTA, {}};
  scroll.value.delta = lines;
  ghostty_terminal_scroll_viewport(_terminal, scroll);
  [self updateFrame];
}

// For the native tests (`Tests/WeaveTerminalRendererTests.mm`), which declare them.

/** The screen as the holder's snapshot of it would be. */
- (NSData *)snapshot {
  uint8_t *bytes = NULL; size_t length = 0;
  if (ghostty_snapshot_encode_alloc(_terminal, NULL, &bytes, &length) != GHOSTTY_SUCCESS) return [NSData data];
  NSData *data = [NSData dataWithBytes:bytes length:length];
  ghostty_free(NULL, bytes, length);
  return data;
}
/** The visible screen as the formatter's VT, as a holder restores a client of another codec. */
- (NSData *)screenVT {
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_VT;
  options.extra = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalExtra);
  options.extra.palette = options.extra.modes = options.extra.scrolling_region = options.extra.tabstops = options.extra.pwd = options.extra.keyboard = true;
  options.extra.screen = GHOSTTY_INIT_SIZED(GhosttyFormatterScreenExtra);
  options.extra.screen.cursor = options.extra.screen.style = options.extra.screen.hyperlink = options.extra.screen.protection = options.extra.screen.kitty_keyboard = options.extra.screen.charsets = true;
  GhosttySelection screen = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyPoint first = {GHOSTTY_POINT_TAG_ACTIVE, {}}, last = {GHOSTTY_POINT_TAG_ACTIVE, {}};
  first.value.coordinate = {0, 0};
  last.value.coordinate = {(uint16_t)(_columns - 1), (uint32_t)(_rows - 1)};
  screen.start = GHOSTTY_INIT_SIZED(GhosttyGridRef); screen.end = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  if (ghostty_terminal_grid_ref(_terminal, first, &screen.start) != GHOSTTY_SUCCESS || ghostty_terminal_grid_ref(_terminal, last, &screen.end) != GHOSTTY_SUCCESS) return [NSData data];
  options.selection = &screen;
  GhosttyFormatter formatter = NULL;
  if (ghostty_formatter_terminal_new(NULL, &formatter, _terminal, options) != GHOSTTY_SUCCESS) return [NSData data];
  uint8_t *bytes = NULL; size_t length = 0;
  GhosttyResult result = ghostty_formatter_format_alloc(formatter, NULL, &bytes, &length);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS) return [NSData data];
  NSData *data = [NSData dataWithBytes:bytes length:length];
  ghostty_free(NULL, bytes, length);
  return data;
}
@end

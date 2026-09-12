#import <AppKit/AppKit.h>
#import "WeaveTerminalRenderer.h"
#include <node_api.h>
#include <cmath>
#include <vector>

static NSString *macKey(unsigned short code) {
  static NSDictionary<NSNumber *, NSString *> *keys;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    keys = @{@82:@"Numpad0", @83:@"Numpad1", @84:@"Numpad2", @85:@"Numpad3", @86:@"Numpad4", @87:@"Numpad5", @88:@"Numpad6", @89:@"Numpad7", @91:@"Numpad8", @92:@"Numpad9", @76:@"NumpadEnter", @69:@"NumpadAdd", @78:@"NumpadSubtract", @67:@"NumpadMultiply", @75:@"NumpadDivide", @65:@"NumpadDecimal", @81:@"NumpadEqual", @71:@"NumLock", @0:@"KeyA", @1:@"KeyS", @2:@"KeyD", @3:@"KeyF", @4:@"KeyH", @5:@"KeyG", @6:@"KeyZ", @7:@"KeyX", @8:@"KeyC", @9:@"KeyV", @11:@"KeyB", @12:@"KeyQ", @13:@"KeyW", @14:@"KeyE", @15:@"KeyR", @16:@"KeyY", @17:@"KeyT",
      @18:@"Digit1", @19:@"Digit2", @20:@"Digit3", @21:@"Digit4", @22:@"Digit6", @23:@"Digit5", @24:@"Equal", @25:@"Digit9", @26:@"Digit7", @27:@"Minus", @28:@"Digit8", @29:@"Digit0", @30:@"BracketRight", @31:@"KeyO", @32:@"KeyU", @33:@"BracketLeft", @34:@"KeyI", @35:@"KeyP", @36:@"Enter", @37:@"KeyL", @38:@"KeyJ", @39:@"Quote", @40:@"KeyK", @41:@"Semicolon", @42:@"Backslash", @43:@"Comma", @44:@"Slash", @45:@"KeyN", @46:@"KeyM", @47:@"Period", @48:@"Tab", @49:@"Space", @50:@"Backquote", @51:@"Backspace", @53:@"Escape",
      @122:@"F1", @120:@"F2", @99:@"F3", @118:@"F4", @96:@"F5", @97:@"F6", @98:@"F7", @100:@"F8", @101:@"F9", @109:@"F10", @103:@"F11", @111:@"F12", @105:@"F13", @107:@"F14", @113:@"F15", @106:@"F16", @64:@"F17", @79:@"F18", @80:@"F19", @90:@"F20",
      @115:@"Home", @119:@"End", @116:@"PageUp", @121:@"PageDown", @114:@"Insert", @117:@"Delete", @123:@"ArrowLeft", @124:@"ArrowRight", @125:@"ArrowDown", @126:@"ArrowUp"};
  });
  return keys[@(code)] ?: @"Unidentified";
}
static NSUInteger weaveKeyModifiers(NSEventModifierFlags flags) {
  return ((flags & NSEventModifierFlagShift) ? 1 : 0) | ((flags & NSEventModifierFlagControl) ? 2 : 0) |
    ((flags & NSEventModifierFlagOption) ? 4 : 0) | ((flags & NSEventModifierFlagCommand) ? 8 : 0) |
    ((flags & NSEventModifierFlagCapsLock) ? 16 : 0);
}
static NSString *printableText(NSString *text) {
  for (NSUInteger i = 0; i < text.length; i++) { unichar c = [text characterAtIndex:i]; if (c < 32 || c == 127 || (c >= 0xF700 && c <= 0xF8FF)) return @""; }
  return text ?: @"";
}
@interface WeaveTerminalNSView : NSView <NSTextInputClient>
@property(nonatomic, strong) WeaveTerminalRenderer *terminal;
@property(nonatomic, copy) void (^event)(NSDictionary *value);
@property(nonatomic) NSRange selection;
@property(nonatomic) NSRange markedSelection;
@property(nonatomic) NSUInteger selectionAnchor;
@property(nonatomic) BOOL selecting;
@property(nonatomic) BOOL inputBlocked;
@property(nonatomic, strong) NSTrackingArea *mouseArea;
@property(nonatomic, strong) NSMutableAttributedString *marked;
@property(nonatomic, strong) NSEvent *interpretingEvent;
@property(nonatomic, strong) NSMutableSet<NSNumber *> *pressedKeys;
@end
@implementation WeaveTerminalNSView
- (BOOL)isFlipped { return YES; }
- (BOOL)clipsToBounds { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder { if (self.event) self.event(@{@"kind": @"focus"}); return YES; }
- (BOOL)resignFirstResponder {
  for (NSNumber *code in self.pressedKeys) [self.terminal sendKey:macKey(code.unsignedShortValue) text:@"" modifiers:weaveKeyModifiers(NSEvent.modifierFlags) action:0];
  [self.pressedKeys removeAllObjects];
  BOOL resigned = [super resignFirstResponder];
  if (resigned && self.event) self.event(@{@"kind": @"blur"});
  return resigned;
}
- (void)drawRect:(NSRect)rect {
  [self.terminal drawInContext:NSGraphicsContext.currentContext.CGContext size:self.bounds.size];
  if (self.marked.length) {
    [self.marked addAttributes:@{NSFontAttributeName: [NSFont fontWithName:self.terminal.fontName size:13], NSForegroundColorAttributeName:NSColor.textColor, NSBackgroundColorAttributeName:NSColor.textBackgroundColor, NSUnderlineStyleAttributeName:@(NSUnderlineStyleSingle)} range:NSMakeRange(0, self.marked.length)];
    [self.marked drawAtPoint:self.terminal.cursorRect.origin];
  }
  if (self.selection.length) {
    [[NSColor colorWithSRGBRed:180/255.0 green:190/255.0 blue:254/255.0 alpha:0.35] setFill];
    NSUInteger cols = self.terminal.columns;
    for (NSUInteger index = self.selection.location; index < NSMaxRange(self.selection); index++) {
      NSRectFillUsingOperation(NSMakeRect(8 + index % cols * self.terminal.cellWidth, 8 + index / cols * self.terminal.cellHeight, self.terminal.cellWidth, self.terminal.cellHeight), NSCompositingOperationSourceOver);
    }
  }
  [self.terminal drawDimmingInContext:NSGraphicsContext.currentContext.CGContext size:self.bounds.size];
  [self.terminal drawFocusBorderInContext:NSGraphicsContext.currentContext.CGContext size:self.bounds.size];
}
- (void)sendKey:(NSString *)key text:(NSString *)text event:(NSEvent *)event modifiers:(NSUInteger)modifiers {
  if (self.terminal.readOnly) return;
  self.selection = NSMakeRange(0, 0);
  if ([self.terminal sendKey:key text:text modifiers:modifiers action:event.isARepeat ? 2 : 1] && event) {
    if (!self.pressedKeys) self.pressedKeys = [NSMutableSet set];
    [self.pressedKeys addObject:@(event.keyCode)];
  }
  self.needsDisplay = YES;
}
- (void)keyDown:(NSEvent *)event {
  if (self.terminal.readOnly) return;
  NSString *key = macKey(event.keyCode);
  NSString *text = printableText(event.charactersIgnoringModifiers);
  BOOL special = [key hasPrefix:@"Arrow"] || [key hasPrefix:@"F"] || [key hasPrefix:@"Numpad"] ||
    [@[@"Enter", @"Escape", @"Tab", @"Backspace", @"Delete", @"Home", @"End", @"PageUp", @"PageDown", @"Insert"] containsObject:key];
  // Let the input method own composition and ordinary layout text. Physical
  // control/function keys use the VT's current keyboard protocol directly.
  if (!self.hasMarkedText && (special || (event.modifierFlags & NSEventModifierFlagControl))) {
    [self sendKey:key text:text event:event modifiers:weaveKeyModifiers(event.modifierFlags)]; return;
  }
  self.interpretingEvent = event;
  [self interpretKeyEvents:@[event]];
  self.interpretingEvent = nil;
}
- (void)keyUp:(NSEvent *)event {
  if (![self.pressedKeys containsObject:@(event.keyCode)]) return;
  [self.pressedKeys removeObject:@(event.keyCode)];
  [self.terminal sendKey:macKey(event.keyCode) text:printableText(event.charactersIgnoringModifiers) modifiers:weaveKeyModifiers(event.modifierFlags) action:0];
}
- (void)insertText:(id)value replacementRange:(NSRange)range {
  NSString *text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  NSEvent *event = self.hasMarkedText ? nil : self.interpretingEvent;
  self.marked = nil; self.needsDisplay = YES;
  [self sendKey:event ? macKey(event.keyCode) : @"Unidentified" text:text event:event modifiers:event ? weaveKeyModifiers(event.modifierFlags) : 0];
}
- (void)doCommandBySelector:(SEL)selector {
  NSDictionary *commands = @{@"insertNewline:": @"Enter", @"deleteBackward:": @"Backspace", @"deleteForward:": @"Delete", @"insertTab:": @"Tab", @"insertBacktab:": @"Tab", @"cancelOperation:": @"Escape", @"moveUp:": @"ArrowUp", @"moveDown:": @"ArrowDown", @"moveRight:": @"ArrowRight", @"moveLeft:": @"ArrowLeft", @"moveToBeginningOfLine:": @"Home", @"moveToEndOfLine:": @"End", @"pageUp:": @"PageUp", @"pageDown:": @"PageDown"};
  NSString *key = commands[NSStringFromSelector(selector)];
  NSUInteger modifiers = weaveKeyModifiers(self.interpretingEvent.modifierFlags);
  if (selector == @selector(insertBacktab:)) modifiers |= 1;
  if (key) [self sendKey:key text:@"" event:self.interpretingEvent modifiers:modifiers];
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
  if (self.terminal.readOnly) return;
  self.markedSelection = selection; self.needsDisplay = YES;
  self.marked = [[NSMutableAttributedString alloc] initWithAttributedString:[value isKindOfClass:NSAttributedString.class] ? value : [[NSAttributedString alloc] initWithString:value]];
}
- (void)unmarkText { NSString *text = self.marked.string; self.marked = nil; self.needsDisplay = YES; if (text.length) [self sendKey:@"Unidentified" text:text event:nil modifiers:0]; }
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return self.marked.length ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return self.marked.length ? self.markedSelection : NSMakeRange(NSNotFound, 0); }
- (NSArray *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual { if (actual) *actual = NSMakeRange(NSNotFound, 0); return nil; }
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  if (actual) *actual = NSMakeRange(0, 0);
  return [self.window convertRectToScreen:[self convertRect:self.terminal.cursorRect toView:nil]];
}
- (NSUInteger)cellAt:(NSPoint)point {
  NSInteger x = MAX(0, MIN((NSInteger)self.terminal.columns - 1, (NSInteger)((point.x - 8) / self.terminal.cellWidth)));
  NSInteger y = MAX(0, MIN((NSInteger)self.terminal.rows - 1, (NSInteger)((point.y - 8) / self.terminal.cellHeight)));
  return y * self.terminal.columns + x;
}
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (self.mouseArea) [self removeTrackingArea:self.mouseArea];
  self.mouseArea = [[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseMoved | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect owner:self userInfo:nil];
  [self addTrackingArea:self.mouseArea];
}
- (BOOL)reportMouse:(NSEvent *)event button:(NSUInteger)button action:(NSUInteger)action {
  return [self.terminal sendMouseAt:[self convertPoint:event.locationInWindow fromView:nil] button:button action:action modifiers:weaveKeyModifiers(event.modifierFlags)];
}
- (void)mouseDown:(NSEvent *)event {
  [self.window makeFirstResponder:self];
  if (self.event) self.event(@{@"kind": @"focus", @"intent": @"pointer"});
  self.selecting = ![self reportMouse:event button:1 action:0];
  if (self.selecting) { self.selectionAnchor = [self cellAt:[self convertPoint:event.locationInWindow fromView:nil]]; self.selection = NSMakeRange(self.selectionAnchor, 0); self.needsDisplay = YES; }
}
- (void)mouseDragged:(NSEvent *)event {
  if (!self.selecting) { [self reportMouse:event button:1 action:2]; return; }
  NSUInteger cell = [self cellAt:[self convertPoint:event.locationInWindow fromView:nil]];
  self.selection = NSMakeRange(MIN(self.selectionAnchor, cell), MAX(self.selectionAnchor, cell) - MIN(self.selectionAnchor, cell) + 1);
  self.needsDisplay = YES;
}
- (void)mouseUp:(NSEvent *)event { if (!self.selecting) [self reportMouse:event button:1 action:1]; self.selecting = NO; }
- (void)mouseMoved:(NSEvent *)event { [self reportMouse:event button:0 action:2]; }
- (void)rightMouseDown:(NSEvent *)event { if (![self reportMouse:event button:2 action:0]) [super rightMouseDown:event]; }
- (void)rightMouseUp:(NSEvent *)event { [self reportMouse:event button:2 action:1]; }
- (void)rightMouseDragged:(NSEvent *)event { [self reportMouse:event button:2 action:2]; }
- (void)otherMouseDown:(NSEvent *)event { [self reportMouse:event button:3 action:0]; }
- (void)otherMouseUp:(NSEvent *)event { [self reportMouse:event button:3 action:1]; }
- (void)otherMouseDragged:(NSEvent *)event { [self reportMouse:event button:3 action:2]; }
- (void)copy:(id)sender {
  if (!self.selection.length) return;
  // Clipboard extraction uses the renderer's cell identities, not NSString offsets.
  NSString *value = [self.terminal textFromCell:self.selection.location count:self.selection.length];
  [NSPasteboard.generalPasteboard clearContents];
  [NSPasteboard.generalPasteboard setString:value forType:NSPasteboardTypeString];
}
- (void)paste:(id)sender {
  NSString *value = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
  if (value && !self.terminal.readOnly) [self.terminal pasteText:value];
}
- (void)scrollWheel:(NSEvent *)event {
  if (event.scrollingDeltaY && [self reportMouse:event button:event.scrollingDeltaY > 0 ? 4 : 5 action:0]) return;
  [self.terminal scrollLines:(NSInteger)(-event.scrollingDeltaY)]; self.needsDisplay = YES;
}
- (BOOL)isAccessibilityElement { return !self.inputBlocked && !self.hidden; }
- (NSString *)accessibilityRole { return NSAccessibilityTextAreaRole; }
- (NSString *)accessibilityLabel { return @"Terminal input"; }
- (id)accessibilityValue { return self.terminal.visibleText; }
@end

@interface WeaveSurfaceContainer : NSView
@end
@implementation WeaveSurfaceContainer
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point {
  NSPoint local = [self convertPoint:point fromView:self.superview];
  if (!NSPointInRect(local, self.bounds)) return nil;
  for (NSView *child in self.subviews.reverseObjectEnumerator) {
    if (![child isKindOfClass:WeaveTerminalNSView.class]) continue;
    WeaveTerminalNSView *terminal = (WeaveTerminalNSView *)child;
    if (!terminal.hidden && !terminal.inputBlocked) {
      NSView *hit = [terminal hitTest:local];
      if (hit) return hit;
    }
  }
  return [super hitTest:point];
}
@end

@interface WeaveNativeSurface : NSObject
@property(nonatomic, strong) WeaveTerminalNSView *view;
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic) BOOL inputFailed;
@property(nonatomic) BOOL failureReported;
@end
@implementation WeaveNativeSurface @end
static NSMutableDictionary<NSNumber *, WeaveNativeSurface *> *surfaces;
static int64_t nextId = 1;
static napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
static napi_value error(napi_env env, const char *message) { napi_throw_error(env, NULL, message); return NULL; }
static void eventJs(napi_env env, napi_value callback, void *context, void *data) {
  NSDictionary *event = CFBridgingRelease(data);
  if (!env || !callback) return;
  WeaveNativeSurface *entry = (__bridge WeaveNativeSurface *)context;
  if (entry.inputFailed) {
    if (entry.failureReported) return;
    entry.failureReported = YES;
    event = @{@"kind": @"error", @"message": @"Native input queue overflowed. Reopen this terminal view to resume."};
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  napi_value value, ignored;
  napi_create_string_utf8(env, (const char *)json.bytes, json.length, &value);
  napi_call_function(env, undefined(env), callback, 1, &value, &ignored);
}
static void releaseEventContext(napi_env env, void *data, void *hint) { CFBridgingRelease(data); }
static WeaveNativeSurface *surface(napi_env env, napi_value id) {
  int64_t number = 0;
  if (napi_get_value_int64(env, id, &number) != napi_ok) return nil;
  return surfaces[@(number)];
}
static napi_value create(napi_env env, napi_callback_info info) {
  size_t count = 3, length; napi_value args[3]; void *bytes;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 3 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *) || surfaces.count >= 64) return error(env, "Invalid native terminal container");
  NSView *parent = (__bridge NSView *)(*(void **)bytes);
  if (!parent || !parent.window) return error(env, "Native window is unavailable");
  size_t fontLength = 0;
  if (napi_get_value_string_utf8(env, args[2], NULL, 0, &fontLength) != napi_ok || fontLength > 4096) return error(env, "Invalid terminal font directory");
  std::vector<char> fontPath(fontLength + 1);
  napi_get_value_string_utf8(env, args[2], fontPath.data(), fontPath.size(), &fontLength);
  if (![WeaveTerminalRenderer registerFontsAtURL:[NSURL fileURLWithPath:@(fontPath.data())]]) return error(env, "Bundled terminal fonts are unavailable");
  WeaveTerminalRenderer *terminal = [WeaveTerminalRenderer make];
  if (!terminal) return error(env, "Native terminal allocation failed");
  WeaveNativeSurface *entry = [WeaveNativeSurface new];
  entry.view = [WeaveTerminalNSView new]; entry.view.terminal = terminal; entry.view.hidden = YES;
  entry.view.terminal.readOnly = YES;
  napi_value name; napi_create_string_utf8(env, "weave-native-terminal", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  void *context = (void *)CFBridgingRetain(entry);
  if (napi_create_threadsafe_function(env, args[1], NULL, name, 256, 1, context, releaseEventContext, context, eventJs, &callback) != napi_ok) {
    CFBridgingRelease(context); return error(env, "Native terminal event bridge failed");
  }
  entry.callback = callback;
  __weak WeaveNativeSurface *weakEntry = entry;
  entry.view.event = ^(NSDictionary *value) {
    WeaveNativeSurface *current = weakEntry;
    if (!current || !current.callback) return;
    void *retained = (void *)CFBridgingRetain(value);
    if (napi_call_threadsafe_function(current.callback, retained, napi_tsfn_nonblocking) != napi_ok) {
      CFBridgingRelease(retained);
      // Stop accepting keys if the bounded event channel cannot keep up.
      current.inputFailed = YES; current.view.terminal.readOnly = YES;
      // The next already-queued callback reports failure exactly once, then
      // drops the remaining queued keys. No unbounded retry queue is needed.
    }
  };
  __weak WeaveTerminalNSView *weakView = entry.view;
  terminal.writeInput = ^(NSData *data) { WeaveTerminalNSView *view = weakView; if (view.event) view.event(@{@"kind": @"input", @"data": [data base64EncodedStringWithOptions:0]}); };
  WeaveSurfaceContainer *container = nil;
  for (NSView *child in parent.subviews) if ([child isKindOfClass:WeaveSurfaceContainer.class]) container = (WeaveSurfaceContainer *)child;
  if (!container) {
    container = [[WeaveSurfaceContainer alloc] initWithFrame:parent.bounds];
    container.wantsLayer = YES;
    container.layer.backgroundColor = [NSColor colorWithSRGBRed:30/255.0 green:30/255.0 blue:46/255.0 alpha:1].CGColor;
    container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    NSArray<NSView *> *webViews = parent.subviews.copy;
    [parent addSubview:container];
    for (NSView *web in webViews) { [web removeFromSuperview]; [container addSubview:web]; }
  }
  entry.view.inputBlocked = YES;
  [container addSubview:entry.view positioned:NSWindowBelow relativeTo:nil];
  int64_t id = nextId++; surfaces[@(id)] = entry;
  napi_value result; napi_create_int64(env, id, &result); return result;
}
static napi_value layout(napi_env env, napi_callback_info info) {
  size_t count = 12; napi_value args[12]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 12) return error(env, "Invalid native geometry");
  WeaveNativeSurface *entry = surface(env, args[0]);
  if (!entry) return error(env, "Native terminal is unavailable");
  double values[4]; bool visible, readOnly;
  for (size_t i = 0; i < 4; i++) if (napi_get_value_double(env, args[i+1], &values[i]) != napi_ok || !std::isfinite(values[i])) return error(env, "Invalid native geometry");
  if (values[2] < 0 || values[3] < 0 || napi_get_value_bool(env, args[5], &visible) != napi_ok || napi_get_value_bool(env, args[6], &readOnly) != napi_ok) return error(env, "Invalid native geometry");
  double borderWidth, borderRadius; uint32_t borderRGB;
  if (napi_get_value_double(env, args[7], &borderWidth) != napi_ok || napi_get_value_double(env, args[8], &borderRadius) != napi_ok || napi_get_value_uint32(env, args[9], &borderRGB) != napi_ok || !std::isfinite(borderWidth) || !std::isfinite(borderRadius) || borderWidth < 0 || borderRadius < 0 || borderWidth > 1000 || borderRadius > 1000 || borderRGB > 0xffffff) return error(env, "Invalid native border");
  double dimAmount;
  if (napi_get_value_double(env, args[10], &dimAmount) != napi_ok || !std::isfinite(dimAmount) || dimAmount < 0 || dimAmount > 1) return error(env, "Invalid native dim amount");
  bool inputBlocked;
  if (napi_get_value_bool(env, args[11], &inputBlocked) != napi_ok) return error(env, "Invalid native input state");
  entry.view.inputBlocked = inputBlocked;
  [entry.view setAccessibilityElement:!inputBlocked && visible];
  if (inputBlocked && entry.view.window.firstResponder == entry.view) [entry.view.window makeFirstResponder:nil];
  entry.view.terminal.dimAmount = dimAmount;
  entry.view.terminal.focusBorderWidth = borderWidth; entry.view.terminal.focusBorderBottomRightRadius = borderRadius; entry.view.terminal.focusBorderRGB = borderRGB;
  NSView *parent = entry.view.superview;
  NSRect rectangle = NSMakeRect(values[0], parent.isFlipped ? values[1] : parent.bounds.size.height - values[1] - values[3], values[2], values[3]);
  if (values[2] > 0 && values[3] > 0) entry.view.frame = NSIntersectionRect(rectangle, parent.bounds);
  if ((!visible) && entry.view.window.firstResponder == entry.view) [entry.view.window makeFirstResponder:nil];
  entry.view.hidden = !visible; entry.view.terminal.readOnly = readOnly || entry.inputFailed;
  CGSize grid = [entry.view.terminal gridForViewportSize:entry.view.bounds.size]; entry.view.needsDisplay = YES;
  napi_value result, cols, rows; napi_create_object(env, &result);
  napi_create_uint32(env, (uint32_t)grid.width, &cols); napi_set_named_property(env, result, "cols", cols);
  napi_create_uint32(env, (uint32_t)grid.height, &rows); napi_set_named_property(env, result, "rows", rows);
  return result;
}
static napi_value write(napi_env env, napi_callback_info info) {
  size_t count = 6, length; napi_value args[6]; void *bytes; bool reset, history; uint32_t cols, rows;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 6 || napi_get_value_bool(env, args[5], &history) != napi_ok || napi_get_value_uint32(env, args[3], &cols) != napi_ok || napi_get_value_uint32(env, args[4], &rows) != napi_ok || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok || length > 64 * 1024 * 1024 || napi_get_value_bool(env, args[2], &reset) != napi_ok) return error(env, "Invalid native output");
  WeaveNativeSurface *entry = surface(env, args[0]);
  NSData *data = [NSData dataWithBytesNoCopy:bytes length:length freeWhenDone:NO];
  if (!entry || !(history ? [entry.view.terminal appendHistory:data] : reset && cols ? [entry.view.terminal restoreData:data columns:cols rows:rows] : [entry.view.terminal consume:data reset:reset])) return error(env, "Native output could not be consumed");
  if (reset) entry.view.selection = NSMakeRange(0, 0);
  entry.view.needsDisplay = YES; return undefined(env);
}
static napi_value focus(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  WeaveNativeSurface *entry = count == 1 ? surface(env, args[0]) : nil;
  if (!entry) return error(env, "Native terminal is unavailable");
  if (entry.view.hidden || entry.view.inputBlocked || !entry.view.window || ![entry.view.window makeFirstResponder:entry.view]) return error(env, "Native terminal is not visible for input");
  return undefined(env);
}
static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  WeaveNativeSurface *entry = count == 1 ? surface(env, args[0]) : nil;
  if (!entry) return error(env, "Native terminal is unavailable");
  const char *text = entry.view.terminal.visibleText.UTF8String;
  napi_value result; napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value close(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 1) return undefined(env);
  int64_t id; if (napi_get_value_int64(env, args[0], &id) != napi_ok) return undefined(env);
  WeaveNativeSurface *entry = surfaces[@(id)];
  if (entry) {
    entry.view.event = nil; entry.view.terminal.writeInput = nil;
    if (entry.view.window.firstResponder == entry.view) [entry.view.window makeFirstResponder:nil];
    [entry.view removeFromSuperview];
    napi_release_threadsafe_function(entry.callback, napi_tsfn_abort); entry.callback = NULL;
    [surfaces removeObjectForKey:@(id)];
  }
  return undefined(env);
}
#if WEAVE_ACCEPTANCE
static napi_value acceptance(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2) return error(env, "Invalid acceptance action");
  auto string = [&](napi_value value) -> NSString * {
    size_t length; if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > 1024 * 1024) return nil;
    std::vector<char> bytes(length + 1); napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length);
    return [[NSString alloc] initWithBytes:bytes.data() length:length encoding:NSUTF8StringEncoding];
  };
  NSString *action = string(args[0]), *value = string(args[1]);
  WeaveTerminalNSView *view = nil;
  for (WeaveNativeSurface *entry in surfaces.allValues) if (entry.view.window.firstResponder == entry.view) { view = entry.view; break; }
  if (!view || !action || !value) return error(env, "No focused native terminal for acceptance");
  if ([action isEqualToString:@"key"]) {
    NSString *characters = [value isEqualToString:@"Enter"] ? @"\r" : [value isEqualToString:@"Escape"] ? @"\033" : value;
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:view.window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:[value isEqualToString:@"Enter"] ? 36 : [value isEqualToString:@"Escape"] ? 53 : [value isEqualToString:@"i"] ? 34 : 0];
    [view keyDown:event];
  } else if ([action isEqualToString:@"composition"]) {
    void (^writer)(NSData *) = view.terminal.writeInput; __block BOOL premature = NO;
    view.terminal.writeInput = ^(NSData *data) { premature = YES; };
    [view setMarkedText:value selectedRange:NSMakeRange(value.length, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    view.terminal.writeInput = writer;
    if (premature) return error(env, "Composition sent uncommitted input");
    [view insertText:value replacementRange:NSMakeRange(NSNotFound, 0)];
  } else if ([action isEqualToString:@"paste"]) {
    [view paste:nil];
  } else if ([action isEqualToString:@"copyMarker"]) {
    NSArray<NSString *> *lines = [view.terminal.visibleText componentsSeparatedByString:@"\n"];
    BOOL found = NO;
    for (NSUInteger row = 0; row < lines.count; row++) {
      NSRange range = [lines[row] rangeOfString:value];
      if (range.location != NSNotFound) { view.selection = NSMakeRange(row * view.terminal.columns + range.location, range.length); found = YES; break; }
    }
    if (!found) return error(env, "Native acceptance marker missing");
    [view copy:nil]; view.needsDisplay = YES;
  } else if ([action isEqualToString:@"capture"]) {
    NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    napi_value result; napi_create_buffer_copy(env, png.length, png.bytes, NULL, &result); return result;
  } else return error(env, "Unknown native acceptance action");
  return undefined(env);
}
#endif
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value codec; napi_create_string_utf8(env, WeaveTerminalRenderer.codecIdentity.UTF8String, NAPI_AUTO_LENGTH, &codec); napi_set_named_property(env, exports, "codec", codec);
  surfaces = [NSMutableDictionary dictionary];
  const napi_property_descriptor properties[] = {
#if WEAVE_ACCEPTANCE
    {"acceptance", NULL, acceptance, NULL, NULL, NULL, napi_default, NULL},
#endif
    {"create", NULL, create, NULL, NULL, NULL, napi_default, NULL}, {"layout", NULL, layout, NULL, NULL, NULL, napi_default, NULL},
    {"write", NULL, write, NULL, NULL, NULL, napi_default, NULL}, {"focus", NULL, focus, NULL, NULL, NULL, napi_default, NULL},
    {"inspect", NULL, inspect, NULL, NULL, NULL, napi_default, NULL}, {"close", NULL, close, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(properties)/sizeof(properties[0]), properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

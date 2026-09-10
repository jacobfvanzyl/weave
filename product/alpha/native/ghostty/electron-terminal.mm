#import <AppKit/AppKit.h>
#import "WeaveTerminalRenderer.h"
#include <node_api.h>
#include <cmath>
#include <vector>

@interface WeaveTerminalNSView : NSView <NSTextInputClient>
@property(nonatomic, strong) WeaveTerminalRenderer *terminal;
@property(nonatomic, copy) void (^event)(NSDictionary *value);
@property(nonatomic) NSRange selection;
@property(nonatomic, strong) NSMutableAttributedString *marked;
@end
@implementation WeaveTerminalNSView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return !self.terminal.readOnly; }
- (BOOL)becomeFirstResponder { if (self.event) self.event(@{@"kind": @"focus"}); return YES; }
- (void)drawRect:(NSRect)rect {
  [self.terminal drawInContext:NSGraphicsContext.currentContext.CGContext size:self.bounds.size];
  if (self.selection.length) {
    [[NSColor.selectedTextBackgroundColor colorWithAlphaComponent:0.35] setFill];
    NSUInteger cols = self.terminal.columns;
    for (NSUInteger index = self.selection.location; index < NSMaxRange(self.selection); index++) {
      NSRectFillUsingOperation(NSMakeRect(8 + index % cols * self.terminal.cellWidth, 8 + index / cols * self.terminal.cellHeight, self.terminal.cellWidth, self.terminal.cellHeight), NSCompositingOperationSourceOver);
    }
  }
}
- (void)emitInput:(NSString *)text {
  if (self.terminal.readOnly || !text.length) return;
  self.selection = NSMakeRange(0, 0);
  self.event(@{@"kind": @"input", @"data": [[text dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0]});
  self.needsDisplay = YES;
}
- (void)keyDown:(NSEvent *)event {
  if (self.terminal.readOnly) return;
  if (event.charactersIgnoringModifiers.length && (event.modifierFlags & NSEventModifierFlagControl)) {
    unichar key = [event.charactersIgnoringModifiers.lowercaseString characterAtIndex:0];
    if (key >= '@' && key <= 127) { unichar control = key & 31; [self emitInput:[NSString stringWithCharacters:&control length:1]]; return; }
  }
  [self interpretKeyEvents:@[event]];
}
- (void)insertText:(id)value replacementRange:(NSRange)range {
  NSString *text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  self.marked = nil; [self emitInput:text];
}
- (void)doCommandBySelector:(SEL)selector {
  NSDictionary *commands = @{@"insertNewline:": @"\r", @"deleteBackward:": @"\177", @"deleteForward:": @"\033[3~", @"insertTab:": @"\t", @"insertBacktab:": @"\033[Z", @"cancelOperation:": @"\033", @"moveUp:": @"\033[A", @"moveDown:": @"\033[B", @"moveRight:": @"\033[C", @"moveLeft:": @"\033[D", @"moveToBeginningOfLine:": @"\033[H", @"moveToEndOfLine:": @"\033[F", @"pageUp:": @"\033[5~", @"pageDown:": @"\033[6~"};
  NSString *input = commands[NSStringFromSelector(selector)];
  if (input) [self emitInput:input];
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
  self.marked = [[NSMutableAttributedString alloc] initWithAttributedString:[value isKindOfClass:NSAttributedString.class] ? value : [[NSAttributedString alloc] initWithString:value]];
}
- (void)unmarkText { self.marked = nil; }
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return self.marked.length ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return self.selection; }
- (NSArray *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual { if (actual) *actual = NSMakeRange(NSNotFound, 0); return nil; }
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
  if (actual) *actual = NSMakeRange(0, 0);
  return [self.window convertRectToScreen:[self convertRect:NSMakeRect(8, 8, self.terminal.cellWidth, self.terminal.cellHeight) toView:nil]];
}
- (NSUInteger)cellAt:(NSPoint)point {
  NSInteger x = MAX(0, MIN((NSInteger)self.terminal.columns - 1, (NSInteger)((point.x - 8) / self.terminal.cellWidth)));
  NSInteger y = MAX(0, MIN((NSInteger)self.terminal.rows - 1, (NSInteger)((point.y - 8) / self.terminal.cellHeight)));
  return y * self.terminal.columns + x;
}
- (void)mouseDown:(NSEvent *)event {
  [self.window makeFirstResponder:self];
  NSUInteger anchor = [self cellAt:[self convertPoint:event.locationInWindow fromView:nil]];
  self.selection = NSMakeRange(anchor, 0);
  while (YES) {
    NSEvent *next = [self.window nextEventMatchingMask:NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp];
    NSUInteger cell = [self cellAt:[self convertPoint:next.locationInWindow fromView:nil]];
    self.selection = NSMakeRange(MIN(anchor, cell), MAX(anchor, cell) - MIN(anchor, cell) + (next.type == NSEventTypeLeftMouseDragged ? 1 : 0));
    self.needsDisplay = YES;
    if (next.type == NSEventTypeLeftMouseUp) break;
  }
}
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
  [self.terminal scrollLines:(NSInteger)(-event.scrollingDeltaY)]; self.needsDisplay = YES;
}
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityTextAreaRole; }
- (NSString *)accessibilityLabel { return @"Terminal input"; }
- (id)accessibilityValue { return self.terminal.visibleText; }
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
  size_t count = 2, length; napi_value args[2]; void *bytes;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *) || surfaces.count >= 64) return error(env, "Invalid native terminal container");
  NSView *parent = (__bridge NSView *)(*(void **)bytes);
  if (!parent || !parent.window) return error(env, "Native window is unavailable");
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
  [parent addSubview:entry.view];
  int64_t id = nextId++; surfaces[@(id)] = entry;
  napi_value result; napi_create_int64(env, id, &result); return result;
}
static napi_value layout(napi_env env, napi_callback_info info) {
  size_t count = 7; napi_value args[7]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 7) return error(env, "Invalid native geometry");
  WeaveNativeSurface *entry = surface(env, args[0]);
  if (!entry) return error(env, "Native terminal is unavailable");
  double values[4]; bool visible, readOnly;
  for (size_t i = 0; i < 4; i++) if (napi_get_value_double(env, args[i+1], &values[i]) != napi_ok || !std::isfinite(values[i])) return error(env, "Invalid native geometry");
  if (values[2] < 0 || values[3] < 0 || napi_get_value_bool(env, args[5], &visible) != napi_ok || napi_get_value_bool(env, args[6], &readOnly) != napi_ok) return error(env, "Invalid native geometry");
  NSView *parent = entry.view.superview;
  NSRect rectangle = NSMakeRect(values[0], parent.isFlipped ? values[1] : parent.bounds.size.height - values[1] - values[3], values[2], values[3]);
  entry.view.frame = NSIntersectionRect(rectangle, parent.bounds);
  if ((!visible || readOnly) && entry.view.window.firstResponder == entry.view) [entry.view.window makeFirstResponder:nil];
  entry.view.hidden = !visible; entry.view.terminal.readOnly = readOnly || entry.inputFailed;
  [entry.view.terminal resizeToSize:entry.view.bounds.size]; entry.view.needsDisplay = YES;
  napi_value result, cols, rows; napi_create_object(env, &result);
  napi_create_uint32(env, (uint32_t)entry.view.terminal.columns, &cols); napi_set_named_property(env, result, "cols", cols);
  napi_create_uint32(env, (uint32_t)entry.view.terminal.rows, &rows); napi_set_named_property(env, result, "rows", rows);
  return result;
}
static napi_value write(napi_env env, napi_callback_info info) {
  size_t count = 3, length; napi_value args[3]; void *bytes; bool reset;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 3 || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok || length > 2 * 1024 * 1024 || napi_get_value_bool(env, args[2], &reset) != napi_ok) return error(env, "Invalid native output");
  WeaveNativeSurface *entry = surface(env, args[0]);
  if (!entry || ![entry.view.terminal consume:[NSData dataWithBytes:bytes length:length] reset:reset]) return error(env, "Native output could not be consumed");
  if (reset) entry.view.selection = NSMakeRange(0, 0);
  entry.view.needsDisplay = YES; return undefined(env);
}
static napi_value focus(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, NULL, NULL);
  WeaveNativeSurface *entry = count == 1 ? surface(env, args[0]) : nil;
  if (!entry) return error(env, "Native terminal is unavailable");
  [entry.view.window makeFirstResponder:entry.view]; return undefined(env);
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
    NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:view.window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:[value isEqualToString:@"Enter"] ? 36 : 0];
    [view keyDown:event];
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

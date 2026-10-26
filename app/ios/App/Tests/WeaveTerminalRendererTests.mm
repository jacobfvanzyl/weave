// The native terminal's tests (WVE-153), built for macOS against the same libghostty-vt by
// `scripts/native-tests.ts`. An authority stands in for the holder: it writes the program's
// output, and its snapshot and its screen's VT are what a holder would send.
#import <Foundation/Foundation.h>
#import "WeaveTerminalRenderer.h"

@interface WeaveTerminalRenderer (Testing)
- (NSData *)snapshot;
- (NSData *)screenVT;
@end

static int failures = 0;
static void check(BOOL condition, NSString *what) {
  if (!condition) { failures++; fprintf(stderr, "  FAIL %s\n", what.UTF8String); }
}
static NSData *bytes(NSString *text) { return [text dataUsingEncoding:NSUTF8StringEncoding]; }
static NSString *escaped(NSData *data) {
  NSMutableString *text = [NSMutableString string];
  const uint8_t *raw = (const uint8_t *)data.bytes;
  for (NSUInteger i = 0; i < data.length; i++) [text appendFormat:raw[i] >= 32 && raw[i] < 127 ? @"%c" : @"\\x%02x", raw[i]];
  return text;
}
static WeaveTerminalRenderer *renderer(void) {
  WeaveTerminalRenderer *renderer = [WeaveTerminalRenderer rendererWithFontSize:13];
  if (!renderer) { fprintf(stderr, "couldn't make a renderer\n"); exit(1); }
  return renderer;
}
static BOOL restore(WeaveTerminalRenderer *renderer, NSData *snapshot) {
  __block BOOL done = NO, restored = NO;
  [renderer restoreSnapshot:snapshot completion:^(BOOL ok) { done = YES; restored = ok; }];
  while (!done) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
  return restored;
}
/** What the renderer writes to the program for one action. */
static NSData *typed(WeaveTerminalRenderer *renderer, void (^action)(WeaveTerminalRenderer *)) {
  NSMutableData *written = [NSMutableData data];
  renderer.writeInput = ^(NSData *data) { [written appendData:data]; };
  action(renderer);
  renderer.writeInput = nil;
  return written;
}
static void sameScreen(WeaveTerminalRenderer *restored, WeaveTerminalRenderer *authority, NSString *name) {
  check([restored.visibleText isEqualToString:authority.visibleText], [NSString stringWithFormat:@"%@: the text differs\n%@\n---\n%@", name, restored.visibleText, authority.visibleText]);
  check([restored.screenVT isEqualToData:authority.screenVT], [NSString stringWithFormat:@"%@: the screen's VT differs\n%@\n---\n%@", name, escaped(restored.screenVT), escaped(authority.screenVT)]);
  check(CGRectEqualToRect(restored.cursorRect, authority.cursorRect), [NSString stringWithFormat:@"%@: the cursor differs", name]);
  check(restored.columns == authority.columns && restored.rows == authority.rows, [NSString stringWithFormat:@"%@: the size differs", name]);
}

static void codecNamesThePin(void) {
  NSString *codec = WeaveTerminalRenderer.codec;
  NSRegularExpression *shape = [NSRegularExpression regularExpressionWithPattern:@"^ghostty [0-9a-f]{40} snapshot [0-9]+$" options:0 error:nil];
  check([shape numberOfMatchesInString:codec options:0 range:NSMakeRange(0, codec.length)] == 1, [NSString stringWithFormat:@"the codec is %@", codec]);
  // The holder built from the same pin names the same codec, so the Host sends this app snapshots.
  NSString *holder = NSProcessInfo.processInfo.environment[@"WEAVE_HOLDER_CODEC"];
  if (holder.length) check([holder isEqualToString:codec], [NSString stringWithFormat:@"the holder's codec is %@, the app's %@", holder, codec]);
}

static void restoresFromASnapshotAndFromVTAgree(void) {
  WeaveTerminalRenderer *authority = renderer();
  [authority resizeToColumns:60 rows:12];
  NSMutableString *output = [NSMutableString string];
  for (int line = 1; line <= 40; line++) [output appendFormat:@"history line %d\r\n", line];
  [output appendString:@"\x1b]0;a title\x07\x1b[1;31mbold red\x1b[0m plain \x1b[4;38;5;208munderlined\x1b[0m\r\n"];
  [output appendString:@"wide 日本語 and 👍🏽 done\r\n"];
  [output appendString:@"\x1b[?1h\x1b[?2004h\x1b[3;10r\x1b[6;12H\x1b[7mreversed\x1b[0m\x1b[H\x1b[2B\x1b[5C"];
  [authority write:bytes(output)];

  WeaveTerminalRenderer *fromSnapshot = renderer();
  check(restore(fromSnapshot, authority.snapshot), @"the snapshot restores");
  WeaveTerminalRenderer *fromVT = renderer();
  check([fromVT resetToColumns:authority.columns rows:authority.rows], @"a blank screen of the terminal's size");
  [fromVT write:authority.screenVT];
  sameScreen(fromSnapshot, authority, @"after a snapshot");
  sameScreen(fromVT, authority, @"after the VT");

  // The same output, after either restore, draws the same screen: the scrolling region, the
  // cursor and the pen came through.
  NSString *more = @"next\x1b[32m green\x1b[0m\r\nscrolls\r\nin\r\nthe\r\nregion\r\n\x1b[r\x1b[12;1Hlast row\x1b[1;1H\x1b[1Ptop";
  for (WeaveTerminalRenderer *each in @[authority, fromSnapshot, fromVT]) [each write:bytes(more)];
  sameScreen(fromSnapshot, authority, @"a snapshot, then output");
  sameScreen(fromVT, authority, @"the VT, then output");

  // Modes came through too, so keys and pastes encode as the program asked.
  for (WeaveTerminalRenderer *each in @[fromSnapshot, fromVT]) {
    check([typed(each, ^(WeaveTerminalRenderer *r) { [r sendKey:@"ArrowUp" text:@"" modifiers:0 action:1]; }) isEqualToData:bytes(@"\x1bOA")], @"application cursor keys after a restore");
    check([typed(each, ^(WeaveTerminalRenderer *r) { [r pasteText:@"pasted"]; }) isEqualToData:bytes(@"\x1b[200~pasted\x1b[201~")], @"bracketed paste after a restore");
  }

  // History from before attaching is in the snapshot's screen alone.
  [fromSnapshot scrollLines:-20];
  check([fromSnapshot.visibleText containsString:@"history line"], @"a snapshot brings history");
}

static void aResyncReplacesTheScreen(void) {
  WeaveTerminalRenderer *authority = renderer(), *client = renderer();
  [authority write:bytes(@"before\r\n")];
  check(restore(client, authority.snapshot), @"the first snapshot restores");
  [authority write:bytes(@"\x1b[2J\x1b[Hafter the client fell behind")];
  check(restore(client, authority.snapshot), @"the resync's snapshot restores");
  sameScreen(client, authority, @"after a resync");

  // A restore that a newer one overtakes is dropped.
  __block BOOL done = NO, restored = YES;
  [client restoreSnapshot:authority.snapshot completion:^(BOOL ok) { done = YES; restored = ok; }];
  [client resetToColumns:30 rows:5];
  [client write:bytes(@"the newer restore")];
  while (!done) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
  check(!restored && client.columns == 30 && [client.visibleText hasPrefix:@"the newer restore"], @"an overtaken restore is dropped");
  check(!restore(client, bytes(@"not a snapshot")), @"a bad snapshot is refused");
  check([client.visibleText hasPrefix:@"the newer restore"], @"a refused snapshot keeps the screen");
}

static void keysAndTheKeyBar(void) {
  WeaveTerminalRenderer *terminal = renderer();
  NSData *(^key)(NSString *, NSUInteger) = ^(NSString *name, NSUInteger modifiers) {
    return typed(terminal, ^(WeaveTerminalRenderer *r) { [r sendKey:name text:@"" modifiers:modifiers action:1]; });
  };
  NSData *(^text)(NSString *, NSUInteger) = ^(NSString *value, NSUInteger modifiers) {
    return typed(terminal, ^(WeaveTerminalRenderer *r) { [r sendText:value modifiers:modifiers]; });
  };
  check([key(@"Escape", 0) isEqualToData:bytes(@"\x1b")], @"Esc");
  check([key(@"Tab", 0) isEqualToData:bytes(@"\t")], @"Tab");
  check([key(@"ArrowLeft", 0) isEqualToData:bytes(@"\x1b[D")], [NSString stringWithFormat:@"Left is %@", escaped(key(@"ArrowLeft", 0))]);
  check([key(@"ArrowUp", 0) isEqualToData:bytes(@"\x1b[A")], @"Up");
  check([key(@"ArrowRight", 2) isEqualToData:bytes(@"\x1b[1;5C")], [NSString stringWithFormat:@"Ctrl-Right is %@", escaped(key(@"ArrowRight", 2))]);
  [terminal write:bytes(@"\x1b[?1h")];
  check([key(@"ArrowDown", 0) isEqualToData:bytes(@"\x1bOB")], @"Down in application cursor mode");
  // The key bar's Ctrl applies to the next character typed.
  check([text(@"c", 2) isEqualToData:[NSData dataWithBytes:"\x03" length:1]], [NSString stringWithFormat:@"Ctrl-C is %@", escaped(text(@"c", 2))]);
  check([text(@"d", 2) isEqualToData:[NSData dataWithBytes:"\x04" length:1]], @"Ctrl-D");
  check([text(@"hi there", 0) isEqualToData:bytes(@"hi there")], @"text");
  check([text(@"ls\n", 0) isEqualToData:bytes(@"ls\r")], @"a return");
  check([text(@"\x7f", 0) isEqualToData:[NSData dataWithBytes:"\x7f" length:1]], @"Backspace");
  check([text(@"é👍🏽", 0) isEqualToData:bytes(@"é👍🏽")], @"text beyond ASCII");
  terminal.readOnly = YES;
  check(typed(terminal, ^(WeaveTerminalRenderer *r) { [r sendText:@"x" modifiers:0]; }).length == 0, @"a read-only terminal sends nothing");
}

static void theGridIsTheTerminals(void) {
  WeaveTerminalRenderer *terminal = renderer();
  check([terminal resizeToColumns:120 rows:40] && terminal.columns == 120 && terminal.rows == 40, @"the terminal's size");
  CGSize grid = [terminal gridForViewportSize:CGSizeMake(16 + terminal.cellWidth * 50 + 1, 16 + terminal.cellHeight * 20 + 1)];
  check(grid.width == 50 && grid.height == 20, [NSString stringWithFormat:@"a view's grid is %.0fx%.0f", grid.width, grid.height]);
  check(terminal.columns == 120, @"measuring a view leaves the terminal's size");
  CGFloat width = terminal.cellWidth;
  terminal.fontSize = 20;
  check(terminal.cellWidth > width && terminal.columns == 120, @"a font size measures cells again and keeps the grid");
  terminal.fontSize = 100;
  check(terminal.fontSize == 32, @"font sizes stop at 32");
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSString *fonts = NSProcessInfo.processInfo.environment[@"WEAVE_TERMINAL_FONTS"];
    if (!fonts || ![WeaveTerminalRenderer registerFontsAtURL:[NSURL fileURLWithPath:fonts]]) { fprintf(stderr, "set WEAVE_TERMINAL_FONTS to ios/App/Native/TerminalFonts\n"); return 1; }
    struct { const char *name; void (*run)(void); } tests[] = {
      {"the codec names the pin", codecNamesThePin},
      {"restores from a snapshot and from VT agree", restoresFromASnapshotAndFromVTAgree},
      {"a resync replaces the screen", aResyncReplacesTheScreen},
      {"keys and the key bar", keysAndTheKeyBar},
      {"the grid is the terminal's", theGridIsTheTerminals},
    };
    for (auto &test : tests) {
      int before = failures;
      test.run();
      printf("%s %s\n", failures == before ? "ok  " : "FAIL", test.name);
    }
    printf(failures ? "%d failed\n" : "all passed\n", failures);
    return failures ? 1 : 0;
  }
}

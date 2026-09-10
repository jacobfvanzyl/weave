#import "WeaveTerminalRenderer.h"
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <stdio.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    WeaveTerminalRenderer *renderer = [WeaveTerminalRenderer make];
    if (!renderer || ![renderer resizeToSize:CGSizeMake(720, 360)]) return 1;
    NSMutableData *replies = [NSMutableData data];
    renderer.writeInput = ^(NSData *data) { [replies appendData:data]; };
    NSString *text = @"Weave native libghostty\r\n\033[32mGreen\033[0m — 界 👩🏽‍💻 é\r\n\033[1mBold\033[0m \033[3mItalic\033[0m \033[4mUnderline\033[0m\r\n\033[38;2;255;80;80mTrue color\033[0m\r\n";
    NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding];
    for (NSUInteger i = 0; i < bytes.length; i++) {
      if (![renderer consume:[bytes subdataWithRange:NSMakeRange(i, 1)] reset:NO]) return 2;
    }
    if (![renderer.visibleText containsString:@"Weave native libghostty"] || ![renderer.visibleText containsString:@"界"] || ![renderer.visibleText containsString:@"é"]) return 3;
    [renderer consume:[@"\033[?1049h\033[HALTERNATE\033[?1049l" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if ([renderer.visibleText containsString:@"ALTERNATE"] || ![renderer.visibleText containsString:@"Weave native"]) return 4;
    [renderer consume:[@"\033[6n" dataUsingEncoding:NSUTF8StringEncoding] reset:NO];
    if (!replies.length) return 5;
    [replies setLength:0];
    [renderer consume:[@"\033[6n" dataUsingEncoding:NSUTF8StringEncoding] reset:YES];
    if (replies.length) return 6;
    [renderer consume:bytes reset:YES];
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
    puts("{\"passed\":true,\"fragmentedUtf8\":true,\"alternateScreen\":true,\"protocolReplies\":true,\"snapshotReplySuppression\":true,\"coreTextRendered\":true,\"wideGraphemeText\":true,\"bracketedPaste\":true,\"readOnlyInput\":true}");
  }
  return 0;
}

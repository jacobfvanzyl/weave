// Native Client Browser; public N-API and AppKit hosting only.
#import <AppKit/AppKit.h>
#import "WeaveClientBrowser-Swift.h"
#include <node_api.h>
#include <cmath>
#include <vector>
// Chromium's content view publishes only its own accessibility children. Own
// an ordinary AppKit root and keep the shell and SwiftUI hosts as siblings so
// AppKit can expose both trees. No Chromium/SwiftUI private API is patched.
@interface WVClientBrowserRoot : NSView
@property NSMutableArray<WVClientBrowser *> *browsers;
@property id pointerMonitor;
- (BOOL)handleBrowserKey:(NSEvent *)event;
@end
@implementation WVClientBrowserRoot
- (BOOL)isFlipped { return YES; }
- (void)dealloc { if (_pointerMonitor) [NSEvent removeMonitor:_pointerMonitor]; }
- (BOOL)handleBrowserKey:(NSEvent *)event {
  NSEventModifierFlags flags=event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  NSString *key=event.charactersIgnoringModifiers.lowercaseString;
  if ((flags & (NSEventModifierFlagCommand|NSEventModifierFlagControl|NSEventModifierFlagOption)) == NSEventModifierFlagCommand) {
    for (WVClientBrowser *browser in self.browsers) if (!browser.view.hidden && [browser ownsFocus]) {
      if ([key isEqualToString:@"l"]) { [browser focusAddress]; return YES; }
      NSString *action=[key isEqualToString:@"r"] ? @"reload" : [key isEqualToString:@"["] ? @"back" : [key isEqualToString:@"]"] ? @"forward" : nil;
      if(action) return [browser command:action address:@""];
    }
  }
  return NO;
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
  return [self handleBrowserKey:event] || [super performKeyEquivalent:event];
}
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityGroupRole; }
- (NSArray *)accessibilityChildren { return NSAccessibilityUnignoredChildren(self.subviews); }
@end
static NSView *browserRoot(NSView *original) {
  NSWindow *window=original.window;
  if ([window.contentView isKindOfClass:WVClientBrowserRoot.class]) return window.contentView;
  NSView *shell=window.contentView;
  WVClientBrowserRoot *root=[[WVClientBrowserRoot alloc] initWithFrame:shell.frame];
  root.browsers=[NSMutableArray new];
  __weak WVClientBrowserRoot *weakRoot=root;
  root.pointerMonitor=[NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown|NSEventMaskRightMouseDown|NSEventMaskKeyDown) handler:^NSEvent *(NSEvent *event) {
    WVClientBrowserRoot *current=weakRoot;
    if(current && event.window==current.window && event.type==NSEventTypeKeyDown) {
      // WebKit's responder and Electron's menu can consume shortcuts before
      // the AppKit root receives performKeyEquivalent. Route only keys owned
      // by the focused local page, before either framework handles them.
      return [current handleBrowserKey:event] ? nil : event;
    }
    if(current && event.window==current.window) for(WVClientBrowser *browser in current.browsers) {
      NSView *view=browser.view;
      if(!view.hidden && NSPointInRect([view convertPoint:event.locationInWindow fromView:nil],view.bounds)) { [browser activate]; break; }
    }
    return event;
  }];
  root.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
  // Electron's hidden titlebar extends its own content view into the titlebar
  // without this AppKit style. A plain replacement view otherwise loses that
  // space, putting the shell's top rail below the native traffic lights.
  if (window.titlebarAppearsTransparent) window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  window.contentView=root;
  [root addSubview:shell];
  // Attaching Chromium's view resets its frame. Size it after reparenting so
  // its rendered controls also occupy real AppKit mouse hit-test bounds.
  shell.frame=root.bounds; shell.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
  return root;
}
@interface WVClientBrowserEntry : NSObject
@property WVClientBrowser *browser;
@property napi_threadsafe_function callback;
@end
@implementation WVClientBrowserEntry
@end
static NSMutableDictionary<NSNumber *, WVClientBrowserEntry *> *entries;
static int64_t nextId = 0;
static napi_value fail(napi_env env, const char *message) { napi_throw_error(env, nullptr, message); return nullptr; }
static void deliver(napi_env env, napi_value callback, void *, void *data) {
  NSString *json = CFBridgingRelease(data);
  if (!env || !callback) return;
  napi_value value, receiver;
  napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &value);
  napi_get_undefined(env, &receiver); napi_call_function(env, receiver, callback, 1, &value, nullptr);
}
static napi_value invoke(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Client Browser requires the main thread");
  size_t count=9; napi_value args[9]; void *operation;
  napi_get_cb_info(env, info, &count, args, nullptr, &operation);
  const char *method=(const char *)operation;
  if (!strcmp(method,"prepare")) {
    void *pointer; size_t length;
    if(count!=1 || napi_get_buffer_info(env,args[0],&pointer,&length)!=napi_ok || length!=sizeof(void *)) return fail(env,"Invalid parent view");
    NSView *parent=(__bridge NSView *)(*(void **)pointer);
    if(!parent.window) return fail(env,"Missing Client Browser window");
    browserRoot(parent); napi_value result; napi_get_undefined(env,&result); return result;
  }
  if (!strcmp(method,"create") || !strcmp(method,"adopt")) {
    void *pointer; size_t length;
    if ((count!=3 && count!=4) || entries.count>=128 || napi_get_buffer_info(env,args[0],&pointer,&length)!=napi_ok || length!=sizeof(void *)) return fail(env,"Invalid parent view");
    size_t size;
    if (napi_get_value_string_utf8(env,args[1],nullptr,0,&size)!=napi_ok || size>16384) return fail(env,"Invalid address");
    std::vector<char> buffer(size+1); napi_get_value_string_utf8(env,args[1],buffer.data(),buffer.size(),&size);
    NSView *parent=(__bridge NSView *)(*(void **)pointer);
    if (!parent.window) return fail(env,"Missing browser window");
    parent=browserRoot(parent);
    WVClientBrowserEntry *entry=[WVClientBrowserEntry new]; napi_value name;
    napi_create_string_utf8(env,"weave-client-browser",NAPI_AUTO_LENGTH,&name);
    napi_threadsafe_function callback;
    if(napi_create_threadsafe_function(env,args[2],nullptr,name,128,1,nullptr,nullptr,nullptr,deliver,&callback)!=napi_ok) return fail(env,"Event bridge unavailable");
    entry.callback=callback;
    __weak WVClientBrowserEntry *weak=entry;
    void (^handler)(NSDictionary *) = ^(NSDictionary *event){
      WVClientBrowserEntry *current=weak; if(!current.callback)return;
      NSString *json=[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:event options:0 error:nil] encoding:NSUTF8StringEncoding];
      void *data=(void *)CFBridgingRetain(json);
      if(napi_call_threadsafe_function(current.callback,data,napi_tsfn_nonblocking)!=napi_ok) CFBridgingRelease(data);
    };
    NSString *argument=[NSString stringWithUTF8String:buffer.data()];
    NSString *paneKey=nil;
    if(count==4) {
      size_t keySize;
      if(napi_get_value_string_utf8(env,args[3],nullptr,0,&keySize)!=napi_ok || keySize>1024) { napi_release_threadsafe_function(entry.callback,napi_tsfn_release); return fail(env,"Invalid Client Browser pane key"); }
      std::vector<char> keyBuffer(keySize+1); napi_get_value_string_utf8(env,args[3],keyBuffer.data(),keyBuffer.size(),&keySize);
      paneKey=[NSString stringWithUTF8String:keyBuffer.data()];
    }
    entry.browser = !strcmp(method,"adopt") ? [WVClientBrowser adoptPopup:argument event:handler] : paneKey ? [[WVClientBrowser alloc] initWithAddress:argument paneKey:paneKey event:handler] : [[WVClientBrowser alloc] initWithAddress:argument event:handler];
    if(paneKey && !strcmp(method,"adopt")) [entry.browser bindPane:paneKey];
    if (!entry.browser) { napi_release_threadsafe_function(entry.callback,napi_tsfn_release); return fail(env,"Popup expired or already adopted"); }
    [parent addSubview:entry.browser.view positioned:NSWindowAbove relativeTo:nil];
    [((WVClientBrowserRoot *)parent).browsers addObject:entry.browser];
    int64_t id=++nextId; entries[@(id)]=entry; napi_value result; napi_create_int64(env,id,&result); return result;
  }
  int64_t id;
  if (!count || napi_get_value_int64(env,args[0],&id)!=napi_ok) return fail(env,"Invalid browser identity");
  WVClientBrowserEntry *entry=entries[@(id)];
  if(!entry) return fail(env,"Missing browser surface");
  if(!strcmp(method,"layout")) {
    double x,y,w,h; bool visible,blocked;
    if(count!=7 || napi_get_value_double(env,args[1],&x)!=napi_ok || napi_get_value_double(env,args[2],&y)!=napi_ok || napi_get_value_double(env,args[3],&w)!=napi_ok || napi_get_value_double(env,args[4],&h)!=napi_ok || !std::isfinite(x)||!std::isfinite(y)||!std::isfinite(w)||!std::isfinite(h)||w<0||h<0 || napi_get_value_bool(env,args[5],&visible)!=napi_ok || napi_get_value_bool(env,args[6],&blocked)!=napi_ok) return fail(env,"Invalid geometry");
    NSView *parent=entry.browser.view.superview;
    double nativeY=parent.isFlipped?y:parent.bounds.size.height-y-h;
    [entry.browser presentWithX:x y:nativeY width:w height:h visible:visible && !blocked blocked:blocked];
  } else if(!strcmp(method,"snapshot")) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:[entry.browser snapshot] options:0 error:nil];
    napi_value value; napi_create_string_utf8(env,((NSString *)[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding]).UTF8String,NAPI_AUTO_LENGTH,&value); return value;
  } else if(!strcmp(method,"focus")) {
    [entry.browser focusPage];
  } else if(!strcmp(method,"command")) {
    if(count!=3) return fail(env,"Invalid browser command");
    NSString *(^read)(napi_value)=^NSString *(napi_value value) {
      size_t size;
      if(napi_get_value_string_utf8(env,value,nullptr,0,&size)!=napi_ok || size>16384) return nil;
      std::vector<char> buffer(size+1); napi_get_value_string_utf8(env,value,buffer.data(),buffer.size(),&size);
      return [[NSString alloc] initWithBytes:buffer.data() length:size encoding:NSUTF8StringEncoding];
    };
    NSString *action=read(args[1]), *address=read(args[2]);
    if(!action || !address || ![entry.browser command:action address:address]) return fail(env,"Invalid browser command or address");
  } else if(!strcmp(method,"close")) {
    NSView *root=entry.browser.view.superview;
    while(root && ![root isKindOfClass:WVClientBrowserRoot.class]) root=root.superview;
    [((WVClientBrowserRoot *)root).browsers removeObject:entry.browser];
    [entry.browser close]; napi_release_threadsafe_function(entry.callback,napi_tsfn_release); entry.callback=nullptr; [entries removeObjectForKey:@(id)];
  } else return fail(env,"Unknown browser operation");
  napi_value result; napi_get_undefined(env,&result); return result;
}
static napi_value initialize(napi_env env,napi_value exports){
  entries=[NSMutableDictionary new];
  for(const char *name:{"prepare","create","adopt","layout","snapshot","focus","command","close"}){napi_value fn;napi_create_function(env,name,NAPI_AUTO_LENGTH,invoke,(void *)name,&fn);napi_set_named_property(env,exports,name,fn);}return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)

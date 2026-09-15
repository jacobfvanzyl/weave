#import "WeaveBrowserSurface.h"
#include <node_api.h>
#include <vector>
#include <cmath>
@interface BrowserEntry : NSObject
@property WeaveBrowserSurface *surface;
@property napi_threadsafe_function callback;
@end
@implementation BrowserEntry
@end
static NSMutableDictionary<NSNumber *, BrowserEntry *> *entries;
static int64_t nextId = 1;
static napi_value error(napi_env env, const char *message) { napi_throw_error(env, NULL, message); return NULL; }
static NSString *string(napi_env env, napi_value value, size_t maximum) {
  size_t length = 0; if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > maximum) return nil;
  std::vector<char> bytes(length + 1); napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length);
  return [[NSString alloc] initWithBytes:bytes.data() length:length encoding:NSUTF8StringEncoding];
}
static void deliver(napi_env env, napi_value callback, void *, void *data) {
  NSString *json = CFBridgingRelease(data);
  if (!env || !callback) return;
  napi_value value, receiver; napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &value); napi_get_undefined(env, &receiver); napi_call_function(env, receiver, callback, 1, &value, NULL);
}
static napi_value create(napi_env env, napi_callback_info info) {
  size_t count = 2, length; napi_value args[2]; void *pointer;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2 || entries.count >= 16 || napi_get_buffer_info(env, args[0], &pointer, &length) != napi_ok || length != sizeof(void *)) return error(env, "Invalid Browser container");
  NSView *parent = (__bridge NSView *)(*(void **)pointer);
  if (!parent.window) return error(env, "Browser window is unavailable");
  BrowserEntry *entry = [BrowserEntry new];
  napi_value name; napi_create_string_utf8(env, "weave-native-browser", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  if (napi_create_threadsafe_function(env, args[1], NULL, name, 256, 1, NULL, NULL, NULL, deliver, &callback) != napi_ok) return error(env, "Browser event bridge failed");
  entry.callback = callback;
  __weak BrowserEntry *weak = entry;
  entry.surface = [[WeaveBrowserSurface alloc] initWithEvent:^(NSDictionary *value) {
    BrowserEntry *strong = weak; if (!strong.callback) return;
    NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] encoding:NSUTF8StringEncoding];
    void *data = (void *)CFBridgingRetain(json);
    if (napi_call_threadsafe_function(strong.callback, data, napi_tsfn_nonblocking) != napi_ok) { CFBridgingRelease(data); [strong.surface close]; }
  }];
  // Terminals may already have wrapped the web content in their hit-test
  // container. Keep pixels beneath that same transparent web layer. If a
  // terminal is created later, it reparents these siblings in their order.
  for (NSView *child in parent.subviews) {
    if ([child.identifier isEqualToString:@"weave-native-surfaces"]) { parent = child; break; }
  }
  [parent addSubview:entry.surface.view positioned:NSWindowBelow relativeTo:nil];
  int64_t id = nextId++; entries[@(id)] = entry;
  napi_value result; napi_create_int64(env, id, &result); return result;
}
static napi_value operate(napi_env env, napi_callback_info info) {
  size_t count = 8; napi_value args[8]; void *method;
  napi_get_cb_info(env, info, &count, args, NULL, &method);
  int64_t id; if (!count || napi_get_value_int64(env, args[0], &id) != napi_ok) return error(env, "Invalid Browser surface");
  BrowserEntry *entry = entries[@(id)];
  if (!entry) return error(env, "Browser surface is unavailable");
  const char *operation = (const char *)method;
  if (!strcmp(operation, "close")) { [entry.surface close]; napi_release_threadsafe_function(entry.callback, napi_tsfn_release); entry.callback = NULL; [entries removeObjectForKey:@(id)]; }
  else if (!strcmp(operation, "layout")) {
    if (count != 7) return error(env, "Invalid Browser geometry");
    double x,y,w,h,dim; bool visible;
    if (napi_get_value_double(env,args[1],&x) || napi_get_value_double(env,args[2],&y) || napi_get_value_double(env,args[3],&w) || napi_get_value_double(env,args[4],&h) || napi_get_value_bool(env,args[5],&visible) || napi_get_value_double(env,args[6],&dim) || !std::isfinite(x+y+w+h+dim) || w<0 || h<0) return error(env,"Invalid Browser geometry");
    NSView *parent = entry.surface.view.superview;
    NSRect frame = NSMakeRect(x, parent.isFlipped ? y : parent.bounds.size.height-y-h, w, h);
    frame = [parent backingAlignedRect:frame options:NSAlignAllEdgesNearest];
    [entry.surface layout:NSIntersectionRect(frame, parent.bounds) visible:visible dim:dim];
  } else {
    NSString *value = count == 2 ? string(env, args[1], !strcmp(operation,"connect") ? 8192 : 65536) : nil;
    if (!value) return error(env, "Invalid Browser request");
    if (!strcmp(operation,"connect")) [entry.surface connect:value]; else [entry.surface sendControl:value];
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value capture(napi_env env, napi_callback_info info) {
  size_t count=1; napi_value args[1]; int64_t surfaceId;
  napi_get_cb_info(env,info,&count,args,NULL,NULL);
  if (count!=1 || napi_get_value_int64(env,args[0],&surfaceId)!=napi_ok) return error(env,"Invalid Browser capture");
  BrowserEntry *entry=entries[@(surfaceId)]; id image=entry.surface.view.layer.contents;
  if (!image) return error(env,"Browser has no native frame");
  NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithCGImage:(__bridge CGImageRef)image];
  NSData *data=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  napi_value result; napi_create_buffer_copy(env,data.length,data.bytes,NULL,&result); return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  entries = [NSMutableDictionary dictionary];
  napi_property_descriptor methods[] = {
    {"capture",NULL,capture,NULL,NULL,NULL,napi_default,NULL},
    {"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},
    {"connect",NULL,operate,NULL,NULL,NULL,napi_default,(void *)"connect"},
    {"control",NULL,operate,NULL,NULL,NULL,napi_default,(void *)"control"},
    {"layout",NULL,operate,NULL,NULL,NULL,napi_default,(void *)"layout"},
    {"close",NULL,operate,NULL,NULL,NULL,napi_default,(void *)"close"}
  };
  napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

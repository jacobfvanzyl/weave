// Read-only AppKit geometry probe for the Electron window acceptance test.
#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t count=1, length; napi_value args[1]; void *bytes;
  napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  if(count!=1 || napi_get_buffer_info(env,args[0],&bytes,&length)!=napi_ok || length!=sizeof(void *)) {
    napi_throw_error(env,nullptr,"Invalid native window"); return nullptr;
  }
  NSView *view=(__bridge NSView *)(*(void **)bytes);
  NSWindow *window=view.window;
  if(!window) { napi_throw_error(env,nullptr,"Missing native window"); return nullptr; }
  NSRect root=[window.contentView convertRect:window.contentView.bounds toView:nil];
  NSView *content=window.contentView;
  NSView *hit=[content hitTest:[content convertPoint:NSMakePoint(50,100) toView:content.superview]];
  NSDictionary *geometry=@{@"windowHeight":@(window.frame.size.height),@"contentWidth":@(root.size.width),@"contentHeight":@(root.size.height),@"contentY":@(root.origin.y),
    @"shellWidth":@(view.bounds.size.width),@"shellHeight":@(view.bounds.size.height),@"hitShell":@(hit && (hit==view || [hit isDescendantOf:view]))};
  NSData *data=[NSJSONSerialization dataWithJSONObject:geometry options:0 error:nil];
  napi_value result;
  napi_create_string_utf8(env,((NSString *)[[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding]).UTF8String,NAPI_AUTO_LENGTH,&result);
  return result;
}
static napi_value initialize(napi_env env,napi_value exports) {
  napi_value fn; napi_create_function(env,"inspect",NAPI_AUTO_LENGTH,inspect,nullptr,&fn);
  napi_set_named_property(env,exports,"inspect",fn); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)

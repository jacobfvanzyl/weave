// Managed CEF pages and lossless RFB. This process belongs to one Host Profile.
// Control uses private stdin/stdout JSON-RPC; each RFB listener is a private
// Unix socket.
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_display_handler.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_parser.h"
#include "include/cef_render_handler.h"
#include "include/cef_render_process_handler.h"
#include "include/cef_version.h"
#include "include/cef_task.h"
#include <functional>
#include "rfb-display.h"
#include "wheel-input.h"
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <random>
#include <rfb/rfb.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>
#ifdef __APPLE__
#include "include/cef_application_mac.h"
#include "include/cef_sandbox_mac.h"
#include "include/wrapper/cef_library_loader.h"
@interface WeaveBrowserApplication : NSApplication <CefAppProtocol>
@property(nonatomic) BOOL handlingSendEvent;
@end
@implementation WeaveBrowserApplication
- (BOOL)isHandlingSendEvent {
  return self.handlingSendEvent;
}
- (void)sendEvent:(NSEvent *)event {
  CefScopedSendingEvent scoped;
  [super sendEvent:event];
}
@end
#endif
using Dict = CefRefPtr<CefDictionaryValue>;
static std::string socketsDirectory;
static volatile sig_atomic_t running = 1;
static bool initialized = false;
static void stop(int) { running = 0; }
static Dict object() { return CefDictionaryValue::Create(); }
static void emit(Dict dict) {
  auto value = CefValue::Create();
  value->SetDictionary(dict);
  printf("%s\n", CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString().c_str());
  fflush(stdout);
}
static void reply(int id, Dict result) {
  auto msg = object();
  msg->SetString("jsonrpc", "2.0");
  msg->SetInt("id", id);
  msg->SetDictionary("result", result);
  emit(msg);
}
static void fail(int id, const std::string &reason) {
  auto msg = object(), error = object();
  msg->SetString("jsonrpc", "2.0");
  msg->SetInt("id", id);
  error->SetInt("code", -32000);
  error->SetString("message", reason);
  msg->SetDictionary("error", error);
  emit(msg);
}
static std::string uuid() {
  static std::random_device random;
  const char *hex = "0123456789abcdef";
  std::string id;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23)
      id += '-';
    else
      id += hex[i == 14 ? 4 : i == 19 ? 8 + (random() % 4) : random() % 16];
  }
  return id;
}
class BrowserTask final : public CefTask {
 public:
  explicit BrowserTask(std::function<void()> fn):fn_(std::move(fn)) {}
  void Execute() override { fn_(); }
 private:
  std::function<void()> fn_;
  IMPLEMENT_REFCOUNTING(BrowserTask);
};
class Page;
static std::map<std::string, CefRefPtr<Page>> pages;
class Page final : public CefClient,
                   public CefRenderHandler,
                   public CefLifeSpanHandler,
                   public CefDisplayHandler,
                   public CefContextMenuHandler,
                   public CefDevToolsMessageObserver {
public:
  std::string id, opener, socketPath, title, url;
  CefRefPtr<CefBrowser> browser;
  CefRefPtr<CefRegistration> observer;
  std::shared_ptr<RfbDisplay> display;
  int width = 800, height = 600, createRequest = 0,
      closeRequest = 0;
  double deviceScaleFactor = 1;
  bool closing = false;
  std::map<int, int> cdpRequests;
  int nextCdp = 0;
  std::string selection;
  int cursorType = 0, inputMode = CEF_TEXT_INPUT_MODE_NONE, contextRequest = 0;
  WheelInput wheel;
  Page(std::string pageId) : id(pageId) {}
  ~Page() override { if(display)display->close(); }
  bool initialize() {
    socketPath=socketsDirectory+"/"+id+".sock";
    display=rfbExecutor().create(socketPath,width,height);
    return display!=nullptr;
  }
  Dict state() {
    auto d = object();
    d->SetString("pageId", id);
    d->SetString("title", title);
    d->SetString("url", url);
    d->SetString("rfbSocket", socketPath);
    d->SetInt("width", width);
    d->SetInt("height", height);
    d->SetDouble("deviceScaleFactor", deviceScaleFactor);
    d->SetBool("canGoBack", browser && browser->CanGoBack());
    d->SetBool("canGoForward", browser && browser->CanGoForward());
    if (!opener.empty())
      d->SetString("openerPageId", opener);
    return d;
  }
  void event(const char *method) {
    auto e = object();
    e->SetString("jsonrpc", "2.0");
    e->SetString("method", method);
    e->SetDictionary("params", state());
    emit(e);
  }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  void OnBeforeContextMenu(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefContextMenuParams> params, CefRefPtr<CefMenuModel> model) override {
    if(contextRequest){
      auto result=object();int flags=params->GetEditStateFlags();
      auto text=params->GetSelectionText().ToString();if(text.size()>32768)text.clear();
      result->SetString("text",text);
      result->SetBool("canCopy",(flags & CM_EDITFLAG_CAN_COPY) && !text.empty());
      result->SetBool("canCut",(flags & CM_EDITFLAG_CAN_CUT) && !text.empty());
      // Server clipboard contents do not describe the client's clipboard.
      result->SetBool("canPaste",params->IsEditable() && (flags & CM_EDITFLAG_CAN_PASTE));
      result->SetBool("canSelectAll",flags & CM_EDITFLAG_CAN_SELECT_ALL);
      reply(contextRequest,result);contextRequest=0;
    }
    model->Clear();
  }
  void OnVirtualKeyboardRequested(CefRefPtr<CefBrowser>, TextInputMode mode) override { inputMode=mode; }
  void requestContext(int request,int x,int y) {
    if(contextRequest){fail(request,"Browser context menu is busy");return;}
    contextRequest=request;
    CefMouseEvent event;event.x=x;event.y=y;
    browser->GetHost()->SendMouseClickEvent(event,MBT_RIGHT,false,1);
    browser->GetHost()->SendMouseClickEvent(event,MBT_RIGHT,true,1);
    CefRefPtr<Page> self=this;
    CefPostDelayedTask(TID_UI,new BrowserTask([self,request]{
      if(self->contextRequest==request){self->contextRequest=0;reply(request,object());}
    }),750); // A webpage may cancel its contextmenu event.
  }
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect &r) override {
    r = CefRect(0, 0, width, height);
  }
  bool GetScreenPoint(CefRefPtr<CefBrowser>, int x, int y, int& screenX, int& screenY) override {
#ifdef __APPLE__
    screenX = x; screenY = y;
#else
    screenX = (int)std::round(x * deviceScaleFactor); screenY = (int)std::round(y * deviceScaleFactor);
#endif
    return true;
  }
  bool GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo &info) override {
    info.device_scale_factor = static_cast<float>(deviceScaleFactor);
    info.depth = 24; info.depth_per_component = 8;
    info.rect = info.available_rect = CefRect(0, 0, width, height);
    return true;
  }
  void OnAfterCreated(CefRefPtr<CefBrowser> b) override {
    browser = b;
    observer = b->GetHost()->AddDevToolsMessageObserver(this);
    event("page.created");
    if (createRequest)
      reply(createRequest, state());
  }
  void OnBeforeClose(CefRefPtr<CefBrowser>) override {
    if(contextRequest){fail(contextRequest,"Page closed");contextRequest=0;}
    observer = nullptr;
    browser = nullptr;
    event("page.closed");
    if (closeRequest)
      reply(closeRequest, object());
    for (auto [_, request] : cdpRequests)
      fail(request, "Page closed");
    cdpRequests.clear();
    pages.erase(id);
  }
  void OnAddressChange(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                       const CefString &address) override {
    if (frame->IsMain()) {
      url = address;
      event("page.changed");
    }
  }
  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString &value) override {
    title = value;
    event("page.changed");
  }
  bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int,
                     const CefString &, const CefString &,
                     WindowOpenDisposition, bool, const CefPopupFeatures &,
                     CefWindowInfo &info, CefRefPtr<CefClient> &client,
                     CefBrowserSettings &settings,
                     CefRefPtr<CefDictionaryValue> &, bool *) override {
    if (pages.size() >= 32 || !running)
      return true;
    CefRefPtr<Page> page = new Page(uuid());
    page->opener = id;
    if (!page->initialize())
      return true;
    pages[page->id] = page;
    info.SetAsWindowless(0);
    settings.windowless_frame_rate = 60;
    client = page;
    return false;
  }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int messageId,
                              bool success, const void *result,
                              size_t size) override {
    auto it = cdpRequests.find(messageId);
    if (it == cdpRequests.end())
      return;
    int request = it->second;
    cdpRequests.erase(it);
    auto value =
        CefParseJSON(std::string((const char *)result, size), JSON_PARSER_RFC);
    if (!success) {
      fail(request, "CDP: " + std::string((const char *)result, size));
      return;
    }
    reply(request, value && value->GetType() == VTYPE_DICTIONARY
                       ? value->GetDictionary()
                       : object());
  }
  void OnDevToolsEvent(CefRefPtr<CefBrowser>, const CefString &method,
                       const void *params, size_t size) override {
    auto e = object(), p = object();
    p->SetString("pageId", id);
    p->SetString("method", method);
    auto value =
        CefParseJSON(std::string((const char *)params, size), JSON_PARSER_RFC);
    if (value && value->GetType() == VTYPE_DICTIONARY)
      p->SetDictionary("params", value->GetDictionary());
    e->SetString("jsonrpc", "2.0");
    e->SetString("method", "page.cdp.event");
    e->SetDictionary("params", p);
    emit(e);
  }
  bool OnCursorChange(CefRefPtr<CefBrowser>, CefCursorHandle,
                      cef_cursor_type_t type, const CefCursorInfo&) override {
    cursorType = static_cast<int>(type); return true;
  }
  void OnTextSelectionChanged(CefRefPtr<CefBrowser>, const CefString& text,
                              const CefRange&) override {
    selection = text.ToString();
    if (selection.size() > 32768) selection.clear();
  }
  Dict interaction() {
    auto result = object(); result->SetInt("cursor", cursorType);
    result->SetString("text", selection); result->SetInt("inputMode",inputMode); return result;
  }
  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType type,
               const RectList &dirty, const void *pixels, int w,
               int h) override {
    if(type==PET_VIEW && display)display->paint(pixels,w,h,dirty);
  }
  void resize(int w, int h, double scale) {
    wheel.reset();
    // Focus claims can repeat the existing size. Clearing that framebuffer
    // loses unchanged pixels because Chromium only repaints its dirty region.
    if (w == width && h == height && scale == deviceScaleFactor) return;
    width = w;
    height = h;
    deviceScaleFactor = scale;
    int pixelWidth = (int)std::ceil(w * scale), pixelHeight = (int)std::ceil(h * scale);
    display->resize(pixelWidth,pixelHeight);
    browser->GetHost()->NotifyScreenInfoChanged();
    browser->GetHost()->WasResized();
    browser->GetHost()->Invalidate(PET_VIEW);
    event("page.changed");
  }

private:
  IMPLEMENT_REFCOUNTING(Page);
};
class Application final : public CefApp,
                          public CefBrowserProcessHandler,
                          public CefRenderProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
    return this;
  }
  void OnBeforeCommandLineProcessing(const CefString &,
                                     CefRefPtr<CefCommandLine> cmd) override {
    if (getenv("WEAVE_BROWSER_CDP_PIPE")) cmd->AppendSwitch("remote-debugging-pipe");
    // Opt-in diagnostic comparison; installed defaults remain unchanged.
    if (!(getenv("WEAVE_BROWSER_DIAGNOSTICS") && std::string(getenv("WEAVE_BROWSER_DIAGNOSTICS")) == "1" && getenv("WEAVE_BROWSER_GPU") && std::string(getenv("WEAVE_BROWSER_GPU")) == "1")) {
      cmd->AppendSwitch("disable-gpu");
      cmd->AppendSwitch("disable-gpu-compositing");
    }
    cmd->AppendSwitch("mute-audio");
    cmd->AppendSwitch("disable-background-timer-throttling");
    cmd->AppendSwitch("no-first-run");
    cmd->AppendSwitch("no-default-browser-check");
#ifndef __APPLE__
    cmd->AppendSwitchWithValue("ozone-platform", "headless");
#endif
  }
  bool OnAlreadyRunningAppRelaunch(CefRefPtr<CefCommandLine>,
                                   const CefString &) override {
    return true;
  }
  void OnContextInitialized() override {
    initialized = true;
    auto e = object(), p = object();
    e->SetString("jsonrpc", "2.0");
    e->SetString("method", "runtime.ready");
    p->SetInt("version", 4);
    p->SetString("cefVersion", CEF_VERSION);
    e->SetDictionary("params", p);
    emit(e);
  }

private:
  IMPLEMENT_REFCOUNTING(Application);
};
static void command(const std::string &line) {
  auto value = CefParseJSON(line, JSON_PARSER_RFC);
  if (!value || value->GetType() != VTYPE_DICTIONARY)
    return;
  auto message = value->GetDictionary();
  int request = message->GetInt("id");
  auto params = message->GetDictionary("params");
  std::string method = message->GetString("method");
  if (request < 1 || !params) {
    fail(request, "Invalid request");
    return;
  }
  if (method == "runtime.close") {
    reply(request, object());
    running = 0;
    return;
  }
  if (method == "page.list") {
    auto result = object();
    auto list = CefListValue::Create();
    size_t i = 0;
    for (auto &[_, page] : pages)
      list->SetDictionary(i++, page->state());
    result->SetList("pages", list);
    reply(request, result);
    return;
  }
  if (method == "page.create") {
    if (pages.size() >= 32) {
      fail(request, "Page capacity exceeded");
      return;
    }
    std::string id = params->GetString("pageId");
    if (id.size() != 36 ||
        id.find_first_not_of("0123456789abcdef-") != std::string::npos) {
      fail(request, "Invalid page ID");
      return;
    }
    if (pages.count(id)) {
      reply(request, pages[id]->state());
      return;
    }
    CefRefPtr<Page> page = new Page(id);
    page->createRequest = request;
    page->url = params->GetString("url");
    if (!page->initialize()) {
      fail(request, "RFB socket unavailable");
      return;
    }
    pages[id] = page;
    CefWindowInfo info;
    info.SetAsWindowless(0);
    CefBrowserSettings settings;
    settings.windowless_frame_rate = 60;
    settings.background_color = CefColorSetARGB(255, 255, 255, 255);
    if (!CefBrowserHost::CreateBrowser(info, page, page->url, settings, nullptr,
                                       nullptr)) {
      pages.erase(id);
      fail(request, "CEF page creation failed");
    }
    return;
  }
  std::string id = params->GetString("pageId");
  auto found = pages.find(id);
  if (found == pages.end() || !found->second->browser ||
      found->second->closing) {
    fail(request, "Page unavailable");
    return;
  }
  auto page = found->second;
  auto host = page->browser->GetHost();
  if (method == "page.close") {
    page->closing = true;
    page->closeRequest = request;
    host->CloseBrowser(true);
    return;
  }
  if(method=="page.context"){
    int x=params->GetInt("x"),y=params->GetInt("y");
    if(x<0 || y<0 || x>=page->width || y>=page->height){fail(request,"Invalid context menu point");return;}
    page->requestContext(request,x,y);return;
  }
  if (method == "page.interaction") { reply(request, page->interaction()); return; }
  if (method == "page.navigate")
    page->browser->GetMainFrame()->LoadURL(params->GetString("url"));
  else if (method == "page.back")
    page->browser->GoBack();
  else if (method == "page.forward")
    page->browser->GoForward();
  else if (method == "page.reload")
    page->browser->Reload();
  else if (method == "page.resize") {
    int w = params->GetInt("width"), h = params->GetInt("height");
    double scale = !params->HasKey("deviceScaleFactor") ? 1 : params->GetType("deviceScaleFactor") == VTYPE_INT ? params->GetInt("deviceScaleFactor") : params->GetDouble("deviceScaleFactor");
    // CEF stores scale as a float; use that exact value for framebuffer sizing.
    scale = static_cast<float>(scale);
    if (w < 1 || h < 1 || w > 4096 || h > 4096 || (int64_t)w * h > 8388608 || !std::isfinite(scale) || scale < 1 || scale > 2 || std::ceil(w * scale) > 8192 || std::ceil(h * scale) > 8192 || std::ceil(w * scale) * std::ceil(h * scale) > 16777216) {
      fail(request, "Invalid viewport");
      return;
    }
    host->SetFocus(true);
    page->resize(w, h, scale);
  } else if (method == "page.cdp") {
    // Human display input can use CEF's embedding API without waiting for a
    // DevTools wheel acknowledgement. Agent CDP calls keep their full response
    // semantics. The optional private hint is ignored safely by older runtimes.
    auto input = params->GetDictionary("arguments");
    if (params->GetBool("nativeInput") &&
        params->GetString("method") == "Input.dispatchMouseEvent" && input &&
        input->GetString("type") == "mouseWheel") {
      bool supported = true;
      CefDictionaryValue::KeyList keys; input->GetKeys(keys);
      for (const auto &key : keys)
        if (key != "type" && key != "x" && key != "y" && key != "deltaX" &&
            key != "deltaY" && key != "modifiers") supported = false;
      auto number = [&](const char *key) {
        auto type = input->GetType(key);
        double value = type == VTYPE_INT ? input->GetInt(key) : input->GetDouble(key);
        if ((type != VTYPE_INT && type != VTYPE_DOUBLE) || !std::isfinite(value) || std::abs(value) > 1000000) supported = false;
        return value;
      };
      double x = number("x"), y = number("y"), dx = number("deltaX"), dy = number("deltaY");
      int modifiers = input->GetInt("modifiers");
      if (input->HasKey("modifiers") && (input->GetType("modifiers") != VTYPE_INT || modifiers < 0 || modifiers > 15)) supported = false;
      if (supported) {
        auto [deltaX, deltaY] = page->wheel.take(dx, dy, x, y, modifiers,
            params->GetString("inputEpoch"), BrowserDiagnostics::now());
        CefMouseEvent event; event.x = (int)std::floor(x); event.y = (int)std::floor(y);
        event.modifiers = ((modifiers & 1) ? EVENTFLAG_ALT_DOWN : 0) |
            ((modifiers & 2) ? EVENTFLAG_CONTROL_DOWN : 0) |
            ((modifiers & 4) ? EVENTFLAG_COMMAND_DOWN : 0) |
            ((modifiers & 8) ? EVENTFLAG_SHIFT_DOWN : 0) |
            // Client wheel deltas are CSS pixels. Preserve precise scrolling
            // instead of Linux treating them as discrete mouse-wheel steps.
            EVENTFLAG_PRECISION_SCROLLING_DELTA;
        if (deltaX || deltaY) host->SendMouseWheelEvent(event, -deltaX, -deltaY);
        reply(request, object()); return;
      }
    }
    if (params->GetBool("nativeInput") && params->GetString("method") == "Input.dispatchMouseEvent" && input) {
      auto type = input->GetString("type").ToString();
      if (type == "mouseMoved" || type == "mousePressed" || type == "mouseReleased") {
        page->wheel.reset();
        auto number = [&](const char* key) { return input->GetType(key) == VTYPE_INT ? (double)input->GetInt(key) : input->GetDouble(key); };
        double x = number("x"), y = number("y");
        if (!std::isfinite(x) || !std::isfinite(y) || std::abs(x) > 1000000 || std::abs(y) > 1000000) { fail(request, "Invalid pointer position"); return; }
        CefMouseEvent event; event.x = (int)std::floor(x); event.y = (int)std::floor(y);
        int mods = input->GetInt("modifiers"), buttons = input->GetInt("buttons");
        event.modifiers = ((mods & 1) ? EVENTFLAG_ALT_DOWN : 0) | ((mods & 2) ? EVENTFLAG_CONTROL_DOWN : 0) |
          ((mods & 4) ? EVENTFLAG_COMMAND_DOWN : 0) | ((mods & 8) ? EVENTFLAG_SHIFT_DOWN : 0) |
          ((buttons & 1) ? EVENTFLAG_LEFT_MOUSE_BUTTON : 0) | ((buttons & 2) ? EVENTFLAG_RIGHT_MOUSE_BUTTON : 0) | ((buttons & 4) ? EVENTFLAG_MIDDLE_MOUSE_BUTTON : 0);
        if (type == "mouseMoved") host->SendMouseMoveEvent(event, input->GetBool("mouseLeave"));
        else {
          auto button = input->GetString("button").ToString();
          host->SendMouseClickEvent(event, button == "right" ? MBT_RIGHT : button == "middle" ? MBT_MIDDLE : MBT_LEFT,
                                   type == "mouseReleased", std::max(1, std::min(3, input->GetInt("clickCount"))));
        }
        reply(request, object()); return;
      }
    }
    page->wheel.reset();
    int messageId = ++page->nextCdp;
    page->cdpRequests[messageId] = request;
    if (!host->ExecuteDevToolsMethod(messageId, params->GetString("method"),
                                     params->GetDictionary("arguments"))) {
      page->cdpRequests.erase(messageId);
      fail(request, "CDP rejected request");
    }
    return;
  } else {
    fail(request, "Unknown operation");
    return;
  }
  reply(request, page->state());
}
int main(int argc, char **argv) {
#ifdef __APPLE__
  @autoreleasepool {
    bool helper = false;
    for (int i = 1; i < argc; i++)
      if (strncmp(argv[i], "--type=", 7) == 0)
        helper = true;
    CefScopedSandboxContext sandbox;
    if (helper && !sandbox.Initialize(argc, argv))
      return 7;
    CefScopedLibraryLoader loader;
    if (!(helper ? loader.LoadInHelper() : loader.LoadInMain()))
      return 2;
#endif
    CefMainArgs args(argc, argv);
    CefRefPtr<Application> app = new Application;
    int code = CefExecuteProcess(args, app, nullptr);
    if (code >= 0)
      return code;
#ifdef __APPLE__
    [WeaveBrowserApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
#endif
    if (argc < 3)
      return 2;
    umask(0077);
    socketsDirectory = argv[2];
    CefSettings settings;
    settings.no_sandbox = false;
    settings.command_line_args_disabled = true;
    settings.windowless_rendering_enabled = true;
    settings.log_severity = LOGSEVERITY_WARNING;
    CefString(&settings.root_cache_path) = argv[1];
    CefString(&settings.cache_path) = std::string(argv[1]) + "/profile";
#ifndef __APPLE__
    if (const char *resources = getenv("CEF_RESOURCES")) {
      CefString(&settings.resources_dir_path) = resources;
      CefString(&settings.locales_dir_path) =
          std::string(resources) + "/locales";
    }
#endif
    if (!CefInitialize(args, settings, app, nullptr))
      return 4;
    signal(SIGTERM, stop);
    signal(SIGINT, stop);
    signal(SIGPIPE, SIG_IGN);
    fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
    std::string input;
    while (running) {
      CefDoMessageLoopWork();
      if (initialized) {
        char buffer[8192];
        ssize_t n = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (n > 0)
          input.append(buffer, n);
        else if (n == 0)
          running = 0;
        if (input.size() > 1048576)
          running = 0;
        size_t end;
        while ((end = input.find('\n')) != std::string::npos) {
          auto line = input.substr(0, end);
          input.erase(0, end + 1);
          command(line);
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    {
      auto current = pages;
      for (auto &[_, page] : current)
        if (page->browser)
          page->browser->GetHost()->CloseBrowser(true);
    }
    for (int i = 0; i < 500 && !pages.empty(); i++) {
      CefDoMessageLoopWork();
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (!pages.empty())
      return 8;
    CefShutdown();
#ifdef __APPLE__
  }
#endif
  return 0;
}

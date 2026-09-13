// CEF offscreen pixels -> existing RFB library. Isolated feasibility adapter.
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_render_handler.h"
#include "include/cef_render_process_handler.h"
#include "include/cef_command_line.h"
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <arpa/inet.h>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <rfb/rfb.h>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>
#ifdef __APPLE__
#include "include/cef_application_mac.h"
#include "include/cef_sandbox_mac.h"
#include "include/wrapper/cef_library_loader.h"
@interface SpikeApplication : NSApplication <CefAppProtocol>
@property(nonatomic) BOOL handlingSendEvent;
@end
@implementation SpikeApplication
- (BOOL)isHandlingSendEvent {
  return self.handlingSendEvent;
}
- (void)sendEvent:(NSEvent *)event {
  CefScopedSendingEvent scoped;
  [super sendEvent:event];
}
@end
#endif
static rfbScreenInfoPtr screen = nullptr;
static CefRefPtr<CefBrowser> browser;
static std::vector<CefRefPtr<CefBrowser>> allBrowsers;
static int viewW = 800, viewH = 600, viewers = 0;
static bool closed = false;
static volatile sig_atomic_t running = 1;
static std::string url;
static int paints = 0;
static int buttons = 0;
static void stop(int) { running = 0; }
static void format() {
  screen->serverFormat.redShift = 16;
  screen->serverFormat.greenShift = 8;
  screen->serverFormat.blueShift = 0;
  auto it = rfbGetClientIterator(screen);
  while (auto c = rfbClientIteratorNext(it))
    rfbSetTranslateFunction(c);
  rfbReleaseClientIterator(it);
}
static void resizeBuffer(int w, int h) {
  char *next = (char *)calloc((size_t)w * h, 4);
  char *old = screen->frameBuffer;
  rfbNewFramebuffer(screen, next, w, h, 8, 3, 4);
  format();
  free(old);
}
class Client final : public CefClient,
                     public CefRenderHandler,
                     public CefLifeSpanHandler,
                     public CefLoadHandler {
public:
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  void GetViewRect(CefRefPtr<CefBrowser>, CefRect &r) override {
    r = CefRect(0, 0, viewW, viewH);
  }
  void OnAfterCreated(CefRefPtr<CefBrowser> b) override {
    allBrowsers.push_back(b);
    if(!browser)browser = b;
    printf("{\"event\":\"browser-created\"}\n");
    fflush(stdout);
  }
  void OnBeforeClose(CefRefPtr<CefBrowser> b) override {
    allBrowsers.erase(std::remove_if(allBrowsers.begin(),allBrowsers.end(),[&](const auto& x){return x->IsSame(b);}),allBrowsers.end());
    if(browser && browser->IsSame(b))browser = nullptr;
    closed = allBrowsers.empty();
  }
  void OnLoadEnd(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> f,
                 int status) override {
    if (f->IsMain()) {
      printf("{\"event\":\"loaded\",\"status\":%d}\n", status);
      fflush(stdout);
    }
  }
  void OnPaint(CefRefPtr<CefBrowser> b, PaintElementType type,
               const RectList &dirty, const void *data, int w, int h) override {
    if (!browser || !browser->IsSame(b)) return; // Only the first fixture page feeds this validation framebuffer.
    if (type != PET_VIEW) {
      printf("{\"event\":\"unsupported-popup-paint\"}\n");
      fflush(stdout);
      return;
    }
    if (w != screen->width || h != screen->height)
      resizeBuffer(w, h);
    for (auto &r : dirty) {
      int x = std::max(0, r.x), y = std::max(0, r.y),
          right = std::min(w, r.x + r.width),
          bottom = std::min(h, r.y + r.height);
      for (int row = y; row < bottom; row++)
        memcpy(screen->frameBuffer + ((size_t)row * w + x) * 4,
               (const char *)data + ((size_t)row * w + x) * 4, (right - x) * 4);
      rfbMarkRectAsModified(screen, x, y, right, bottom);
    }
    paints++;
    if (paints % 60 == 1) {
      printf("{\"event\":\"paint\",\"count\":%d,\"width\":%d,\"height\":%d,"
             "\"dirtyRects\":%zu,\"viewers\":%d}\n",
             paints, w, h, dirty.size(), viewers);
      fflush(stdout);
    }
  }

private:
  IMPLEMENT_REFCOUNTING(Client);
};
static void probeCanary(const char* role, const std::string& path) {
  if(path.empty()) return;
  errno=0; int fd=open(path.c_str(),O_RDONLY); int error=errno;
  printf("{\"event\":\"sandbox-canary\",\"role\":\"%s\",\"pid\":%d,\"readAllowed\":%s,\"errno\":%d}\n",role,getpid(),fd>=0?"true":"false",error);
  if(fd>=0)close(fd); fflush(stdout);
}
class Application final : public CefApp, public CefBrowserProcessHandler, public CefRenderProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }
  void OnBeforeChildProcessLaunch(CefRefPtr<CefCommandLine> cmd) override {
    if(const char* path=getenv("FOUNDATION_CANARY"))cmd->AppendSwitchWithValue("foundation-canary",path);
  }
  void OnWebKitInitialized() override {
    probeCanary("renderer",CefCommandLine::GetGlobalCommandLine()->GetSwitchValue("foundation-canary"));
  }
  void OnBeforeCommandLineProcessing(const CefString &,
                                     CefRefPtr<CefCommandLine> cmd) override {
    cmd->AppendSwitch("disable-gpu");
    cmd->AppendSwitch("disable-gpu-compositing");
    if(getenv("FOUNDATION_UNSANDBOXED")) cmd->AppendSwitch("no-sandbox");
    cmd->AppendSwitch("mute-audio");
    cmd->AppendSwitch("disable-background-timer-throttling");
    cmd->AppendSwitch("no-first-run");
    cmd->AppendSwitch("no-default-browser-check");
  }
  void OnContextInitialized() override {
    printf("{\"event\":\"context-initialized\"}\n");
    fflush(stdout);
    CefWindowInfo wi;
    wi.SetAsWindowless(0);
    CefBrowserSettings bs;
    bs.windowless_frame_rate = 30;
    bs.background_color = CefColorSetARGB(255, 255, 255, 255);
    CefBrowserHost::CreateBrowser(wi, new Client, url, bs, nullptr, nullptr);
    if(getenv("FOUNDATION_TWO_PAGES")) CefBrowserHost::CreateBrowser(wi,new Client,url+"?native-second=1",bs,nullptr,nullptr);
  }

private:
  IMPLEMENT_REFCOUNTING(Application);
};
static void gone(rfbClientPtr) {
  viewers--;
  printf("{\"event\":\"viewer-left\",\"viewers\":%d}\n", viewers);
  fflush(stdout);
}
static enum rfbNewClientAction joined(rfbClientPtr c) {
  viewers++;
  c->clientGoneHook = gone;
  printf("{\"event\":\"viewer-joined\",\"viewers\":%d}\n", viewers);
  fflush(stdout);
  return RFB_CLIENT_ACCEPT;
}
static int resize(int w, int h, int n, rfbExtDesktopScreen *, rfbClientPtr) {
  if (n != 1 || w < 320 || h < 200 || w > 2048 || h > 1536)
    return rfbExtDesktopSize_InvalidScreenLayout;
  viewW = w;
  viewH = h;
  resizeBuffer(w, h);
  if (browser)
    browser->GetHost()->WasResized();
  printf("{\"event\":\"viewport\",\"width\":%d,\"height\":%d}\n", w, h);
  fflush(stdout);
  return rfbExtDesktopSize_Success;
}
static void pointer(int mask, int x, int y, rfbClientPtr c) {
  if (browser) {
    CefMouseEvent event;
    event.x = x;
    event.y = y;
    if ((mask & 1) != (buttons & 1))
      browser->GetHost()->SendMouseClickEvent(event, MBT_LEFT, !(mask & 1), 1);
    else
      browser->GetHost()->SendMouseMoveEvent(event, false);
  }
  buttons = mask;
  rfbDefaultPtrAddEvent(mask, x, y, c);
}
int main(int argc, char **argv) {
#ifdef __APPLE__
  @autoreleasepool {
    bool helper = false;
    for (int i = 1; i < argc; i++)
      if (strncmp(argv[i], "--type=", 7) == 0)
        helper = true;
    CefScopedSandboxContext sandbox;
    if (helper && !getenv("FOUNDATION_UNSANDBOXED") && !sandbox.Initialize(argc,argv)) {
      fprintf(stderr,"CEF sandbox initialization failed\n"); return 7;
    }
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
    [SpikeApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
#endif
    if (argc < 6) {
      fprintf(stderr, "cef-host bind port seconds profile url\n");
      return 2;
    }
    url = argv[5];
    int seconds = atoi(argv[3]);
    int ac = 1;
    screen = rfbGetScreen(&ac, argv, viewW, viewH, 8, 3, 4);
    screen->frameBuffer = (char *)calloc((size_t)viewW * viewH, 4);
    screen->desktopName = "WVE-79 Chromium framebuffer";
    screen->alwaysShared = TRUE;
    screen->dontDisconnect = TRUE;
    screen->port = atoi(argv[2]);
    screen->ipv6port = -1;
    screen->listenInterface = inet_addr(argv[1]);
    screen->newClientHook = joined;
    screen->setDesktopSizeHook = resize;
    screen->ptrAddEvent = pointer;
    screen->deferUpdateTime = 5;
    format();
    rfbInitServer(screen);
    if(const char* path=getenv("FOUNDATION_CANARY"))probeCanary("browser",path);
    CefSettings settings;
    settings.no_sandbox = getenv("FOUNDATION_UNSANDBOXED") != nullptr;
    settings.windowless_rendering_enabled = true;
    settings.remote_debugging_port = 19329;
    CefString(&settings.root_cache_path) = argv[4];
    CefString(&settings.cache_path) = std::string(argv[4]) + "/profile";
    settings.log_severity = LOGSEVERITY_WARNING;
#ifndef __APPLE__
    if (const char *resources = getenv("CEF_RESOURCES")) {
      CefString(&settings.resources_dir_path) = resources;
      CefString(&settings.locales_dir_path) =
          std::string(resources) + "/locales";
    }
#endif

    printf("{\"event\":\"initializing\"}\n");
    fflush(stdout);
    if (!CefInitialize(args, settings, app, nullptr))
      return 4;
    printf("{\"event\":\"initialized\"}\n");
    fflush(stdout);
    signal(SIGTERM, stop);
    signal(SIGINT, stop);
    signal(SIGPIPE, SIG_IGN);
    auto start = std::chrono::steady_clock::now();
    while (running && std::chrono::duration<double>(
                          std::chrono::steady_clock::now() - start)
                              .count() < seconds) {
      CefDoMessageLoopWork();
      rfbProcessEvents(screen, 1000);
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    { const auto closingBrowsers=allBrowsers;
    for (const auto& b : closingBrowsers) b->GetHost()->CloseBrowser(true); }
    for (int i = 0; i < 500 && !closed; i++) {
      CefDoMessageLoopWork();
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    allBrowsers.clear(); browser=nullptr;
    CefShutdown();
    rfbShutdownServer(screen, TRUE);
    free(screen->frameBuffer);
    screen->frameBuffer = nullptr;
    rfbScreenCleanup(screen);
#ifdef __APPLE__
  }
#endif
  return 0;
}

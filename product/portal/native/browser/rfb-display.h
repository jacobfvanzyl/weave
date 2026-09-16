#pragma once
#include "diagnostics.h"
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>
#include <thread>
#include <chrono>
#include <algorithm>
#include <cstring>
#include <set>
#include <string>
#include <rfb/rfb.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <fcntl.h>
#include <unistd.h>

// All LibVNC calls belong to one executor per Profile process. LibVNC is built
// WITH_THREADS=OFF: its per-screen initialization otherwise reinitializes a
// process-global client-list mutex. CEF never touches a LibVNC framebuffer.
#if defined(LIBVNCSERVER_HAVE_LIBPTHREAD) || defined(LIBVNCSERVER_HAVE_WIN32THREADS)
#error "The Browser RFB executor requires LibVNC WITH_THREADS=OFF"
#endif
class RfbDisplay {
  struct Rect { int x, y, width, height; };
  std::mutex pixelsMutex, socketsMutex;
  int width, height;
  std::vector<char> pixels;
  std::vector<Rect> dirty;
  unsigned paints = 0;
  double dirtyArea = 0;
  // Duplicates remain valid even if LibVNC closes/reuses its own descriptor.
  // shutdown cancels I/O without reusing descriptors. Linux write-select may
  // still wait for LibVNC's five-second retry; Page close never joins it.
  std::set<int> sockets;
  int pendingSocket=-1; // Executor-only handshake registration.
  std::atomic<bool> stopped{false};
  int listener = -1;
  std::string path;
  rfbScreenInfoPtr screen = nullptr; // Executor thread only.
  BrowserDiagnostics diagnostics; // Executor thread only after construction.
  struct Client { RfbDisplay *display; int socket; };
  friend class RfbExecutor;
  bool open() {
    if (path.size() >= sizeof(sockaddr_un::sun_path)) return false;
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) return false;
    sockaddr_un address{}; address.sun_family=AF_UNIX;
    memcpy(address.sun_path,path.c_str(),path.size()+1);
    if (bind(listener,(sockaddr*)&address,sizeof(address)) || chmod(path.c_str(),0600) || listen(listener,8)) return false;
    fcntl(listener,F_SETFL,O_NONBLOCK); fcntl(listener,F_SETFD,FD_CLOEXEC);
    return true;
  }
  void forget(int fd) {
    std::lock_guard lock(socketsMutex);
    auto it=sockets.find(fd);
    if(it!=sockets.end()){::close(*it);sockets.erase(it);}
  }
  void initialize() {
    int argc=1; char name[]="weave-browser"; char *argv[]={name,nullptr};
    screen=rfbGetScreen(&argc,argv,800,600,8,3,4);
    screen->screenData=this; screen->frameBuffer=(char*)calloc(800*600,4);
    screen->desktopName="Weave Browser";
    screen->serverFormat.redShift=16;screen->serverFormat.greenShift=8;screen->serverFormat.blueShift=0;
    screen->port=-1;screen->ipv6port=-1;screen->alwaysShared=TRUE;screen->dontDisconnect=TRUE;screen->deferUpdateTime=0;
    screen->ptrAddEvent=[](int,int,int,rfbClientPtr){};
    screen->kbdAddEvent=[](rfbBool,rfbKeySym,rfbClientPtr){};
    screen->setDesktopSizeHook=[](int,int,int,rfbExtDesktopScreen*,rfbClientPtr){return rfbExtDesktopSize_ResizeProhibited;};
    screen->newClientHook=[](rfbClientPtr client){
      auto display=(RfbDisplay*)client->screen->screenData;
      client->clientData=new Client{display,display->pendingSocket};
      client->clientGoneHook=[](rfbClientPtr client){auto data=(Client*)client->clientData;data->display->forget(data->socket);delete data;};
      return RFB_CLIENT_ACCEPT;
    };
    rfbInitServer(screen);
  }
  void apply() {
    int w,h;
    {std::lock_guard lock(pixelsMutex);if(dirty.empty())return;w=width;h=height;}
    if(screen->width!=w || screen->height!=h){
      char *old=screen->frameBuffer;
      rfbNewFramebuffer(screen,(char*)calloc((size_t)w*h,4),w,h,8,3,4);free(old);
      screen->serverFormat.redShift=16;screen->serverFormat.greenShift=8;screen->serverFormat.blueShift=0;
      auto it=rfbGetClientIterator(screen);while(auto client=rfbClientIteratorNext(it))rfbSetTranslateFunction(client);rfbReleaseClientIterator(it);
    }
    std::vector<Rect> changed;
    {
      std::lock_guard lock(pixelsMutex);
      if(width!=w || height!=h)return;
      for(auto &r:dirty)for(int row=r.y;row<r.y+r.height;row++)
        memcpy(screen->frameBuffer+((size_t)row*w+r.x)*4,pixels.data()+((size_t)row*w+r.x)*4,(size_t)r.width*4);
      changed.swap(dirty);diagnostics.paint(dirtyArea,paints);paints=0;dirtyArea=0;
    }
    for(auto &r:changed)rfbMarkRectAsModified(screen,r.x,r.y,r.x+r.width,r.y+r.height);
  }
  void pump() {
    if(!screen)initialize();
    int fd=accept(listener,nullptr,nullptr);
    if(fd>=0){
      fcntl(fd,F_SETFD,FD_CLOEXEC);
      int duplicate=fcntl(fd,F_DUPFD_CLOEXEC,0);
      bool accepted=false;
      if(duplicate>=0){std::lock_guard lock(socketsMutex);if(!stopped && sockets.size()<16){sockets.insert(duplicate);accepted=true;}}
      if(!accepted){if(duplicate>=0)::close(duplicate);::close(fd);}
      else {pendingSocket=duplicate;if(!rfbNewClient(screen,fd))forget(duplicate);pendingSocket=-1;}
    }
    apply();
    const double start=diagnostics.enabled()?BrowserDiagnostics::now():0;
    rfbProcessEvents(screen,0);
    if(diagnostics.enabled())diagnostics.pump(start);
  }
  void cleanup() {
    if(listener>=0){::close(listener);listener=-1;}
    unlink(path.c_str());
    if(screen){rfbShutdownServer(screen,TRUE);free(screen->frameBuffer);screen->frameBuffer=nullptr;rfbScreenCleanup(screen);screen=nullptr;}
    std::lock_guard lock(socketsMutex);for(auto duplicate:sockets)::close(duplicate);sockets.clear();
  }
public:
  RfbDisplay(std::string path,int w,int h):width(w),height(h),path(std::move(path)){}
  ~RfbDisplay(){if(listener>=0)::close(listener);unlink(path.c_str());}
  void close() {
    stopped=true;
    std::lock_guard lock(socketsMutex);
    for(auto duplicate:sockets)shutdown(duplicate,SHUT_RDWR);
  }
  void resize(int w,int h){
    std::lock_guard lock(pixelsMutex);
    if(w==width && h==height)return;
    width=w;height=h;pixels.clear();dirty.clear();paints=0;dirtyArea=0;
  }
  template<class Rectangles> void paint(const void *source,int w,int h,const Rectangles &rectangles){
    std::lock_guard lock(pixelsMutex);
    if(stopped || width!=w || height!=h)return;
    if(pixels.empty()){
      pixels.resize((size_t)w*h*4);memcpy(pixels.data(),source,pixels.size());dirty={{0,0,w,h}};
    }else{
      for(auto &r:rectangles){
        int x=std::max(0,r.x),y=std::max(0,r.y),right=std::min(w,r.x+r.width),bottom=std::min(h,r.y+r.height);
        if(right<=x || bottom<=y)continue;
        for(int row=y;row<bottom;row++)memcpy(pixels.data()+((size_t)row*w+x)*4,(const char*)source+((size_t)row*w+x)*4,(size_t)(right-x)*4);
        if(dirty.size()<256)dirty.push_back({x,y,right-x,bottom-y});else dirty={{0,0,w,h}};
      }
    }
    paints++;for(auto &r:rectangles)dirtyArea+=(double)r.width*r.height;
  }
};
class RfbExecutor {
  std::mutex mutex;
  std::vector<std::shared_ptr<RfbDisplay>> displays;
  bool stopping=false;
  std::thread worker;
public:
  RfbExecutor():worker([this]{
    for(;;){
      std::vector<std::shared_ptr<RfbDisplay>> current;
      {std::lock_guard lock(mutex);if(stopping)break;current=displays;}
      for(auto &display:current)if(!display->stopped)display->pump();
      {std::lock_guard lock(mutex);std::erase_if(displays,[](auto &display){if(!display->stopped)return false;display->cleanup();return true;});}
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    for(auto &display:displays)display->cleanup();
  }){}
  ~RfbExecutor(){
    {std::lock_guard lock(mutex);stopping=true;for(auto &display:displays)display->close();}
    worker.join();
  }
  std::shared_ptr<RfbDisplay> create(const std::string &path,int w,int h){
    auto display=std::make_shared<RfbDisplay>(path,w,h);if(!display->open())return {};
    std::lock_guard lock(mutex);displays.push_back(display);return display;
  }
};
inline RfbExecutor &rfbExecutor(){static RfbExecutor executor;return executor;}

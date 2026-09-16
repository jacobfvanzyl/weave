#include "rfb-display.h"
#include <cassert>
#include <poll.h>
#include <cstdlib>
#include <iostream>
#include <csignal>

int connectDisplay(const std::string &path){
  int fd=socket(AF_UNIX,SOCK_STREAM,0);assert(fd>=0);
  sockaddr_un address{};address.sun_family=AF_UNIX;memcpy(address.sun_path,path.c_str(),path.size()+1);
  assert(connect(fd,(sockaddr*)&address,sizeof(address))==0);return fd;
}
void greeting(int fd,int timeout=1000){
  pollfd wait{fd,POLLIN,0};assert(poll(&wait,1,timeout)==1);
  char version[12];assert(recv(fd,version,12,MSG_WAITALL)==12);assert(!memcmp(version,"RFB ",4));
}
void readBytes(int fd,void *bytes,size_t length){
  pollfd wait{fd,POLLIN,0};assert(poll(&wait,1,1000)==1);assert(recv(fd,bytes,length,MSG_WAITALL)==(ssize_t)length);
}
void requestRaw(int fd){
  assert(write(fd,"RFB 003.008\n",12)==12);
  unsigned char types[2];readBytes(fd,types,2);assert(types[0]==1 && types[1]==1);
  assert(write(fd,"\1",1)==1);unsigned char result[4];readBytes(fd,result,4);
  assert(write(fd,"\1",1)==1);unsigned char init[24];readBytes(fd,init,24);
  unsigned length=(init[20]<<24)|(init[21]<<16)|(init[22]<<8)|init[23];assert(length<1024);
  std::vector<char> name(length);readBytes(fd,name.data(),length);
  unsigned char raw[]={2,0,0,1,0,0,0,0};assert(write(fd,raw,sizeof(raw))==sizeof(raw));
  unsigned char request[]={3,0,0,0,0,0,3,32,2,88};assert(write(fd,request,sizeof(request))==sizeof(request));
}
int main(){
  signal(SIGPIPE,SIG_IGN);
  char path[]="/tmp/weave-rfb-worker-test-XXXXXX";assert(mkdtemp(path));
  {
    RfbExecutor executor;
    auto stalled=executor.create(std::string(path)+"/stalled.sock",32,32);assert(stalled);
    int fd=connectDisplay(std::string(path)+"/stalled.sock");greeting(fd);
    // An incomplete protocol reply puts the stock blocking reader to sleep.
    assert(write(fd,"R",1)==1);std::this_thread::sleep_for(std::chrono::milliseconds(30));
    auto start=std::chrono::steady_clock::now();
    stalled->close();
    auto next=executor.create(std::string(path)+"/next.sock",32,32);assert(next);
    int nextFD=connectDisplay(std::string(path)+"/next.sock");greeting(nextFD);
    assert(std::chrono::steady_clock::now()-start<std::chrono::milliseconds(500));
    ::close(fd);::close(nextFD);next->close();
    // A client that stops consuming raw pixels must not hold the staging lock
    // or prevent cancellation, even inside LibVNC's blocking output loop.
    auto slow=executor.create(std::string(path)+"/slow.sock",800,600);assert(slow);
    std::vector<unsigned> frame(800*600,0xff123456);
    struct Dirty{int x,y,width,height;};slow->paint(frame.data(),800,600,std::vector<Dirty>{{0,0,800,600}});
    int slowFD=connectDisplay(std::string(path)+"/slow.sock");int small=1024;setsockopt(slowFD,SOL_SOCKET,SO_RCVBUF,&small,sizeof(small));greeting(slowFD);requestRaw(slowFD);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    start=std::chrono::steady_clock::now();
    slow->paint(frame.data(),800,600,std::vector<Dirty>{{0,0,800,600}});slow->resize(640,480);slow->close();
    auto recovered=executor.create(std::string(path)+"/recovered.sock",32,32);assert(recovered);
    assert(std::chrono::steady_clock::now()-start<std::chrono::milliseconds(100));
    int recoveredFD=connectDisplay(std::string(path)+"/recovered.sock");
    // Linux select(write) need not wake on local shutdown while the peer's
    // receive buffer is full. Stock LibVNC retries after five seconds. Page
    // close/staging above must still return immediately on the CEF thread.
    greeting(recoveredFD,6000);
    assert(std::chrono::steady_clock::now()-start<std::chrono::milliseconds(5500));
    ::close(slowFD);::close(recoveredFD);recovered->close();
    // Exercise asynchronous disposal and initialization of several screens.
    for(int n=0;n<32;n++){
      auto page=executor.create(std::string(path)+"/"+std::to_string(n)+".sock",32,32);assert(page);
      std::vector<unsigned> pixels(64*64,0xff123456);
      struct Rect{int x,y,width,height;};
      for(int i=0;i<16;i++){page->resize(64,64);page->paint(pixels.data(),64,64,std::vector<Rect>{{0,0,64,64}});}
      page->close();
    }
    auto shutdown=executor.create(std::string(path)+"/shutdown.sock",32,32);assert(shutdown);
    int shutdownFD=connectDisplay(std::string(path)+"/shutdown.sock");greeting(shutdownFD);
    assert(write(shutdownFD,"R",1)==1);::close(shutdownFD);
  }
  assert(rmdir(path)==0);
  std::cout<<"RFB worker cancellation, resize handoff and lifecycle passed\n";
}

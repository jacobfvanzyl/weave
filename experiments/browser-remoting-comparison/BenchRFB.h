// Measurement-only instrumentation. Monotonic client clock; no clock synchronization.
#import <ImageIO/ImageIO.h>
#import <mach/mach.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <netinet/tcp.h>
static double benchNow(void) { return NSProcessInfo.processInfo.systemUptime; }
static double benchStart, benchPhaseAt, benchLastStats, benchSentAt, benchLastClick;
static int benchPhase=-1,benchCounter,benchExpected=-1,benchClicks,benchFrames,benchDpr=1;
static BOOL benchStarted,benchSaved;
static void benchFrame(rfbClient *c) {
  double at=benchNow(); int d=c->width/960; if(d<1 || c->height<70*d)return; benchDpr=d;
  if(c->frameBuffer[(58*d*c->width+(8+360+6)*d)*4] <= 128) return; // Reject uninitialized resize frames.
  uint32_t bits=0;for(int i=0;i<28;i++){const uint8_t *p=c->frameBuffer+((58*d*c->width)+(8+i*12+6)*d)*4;if(p[0]>128)bits|=1u<<i;}
  int phase=(bits>>8)&15,counter=bits&255; if(phase>7)return;
  if(phase!=benchPhase){benchPhase=phase;benchPhaseAt=at;printf("{\"event\":\"phase\",\"phase\":%d,\"t\":%.6f,\"width\":%d,\"height\":%d}\n",phase,at,c->width,c->height);}
  if(benchExpected>=0 && counter==benchExpected){printf("{\"event\":\"latency\",\"phase\":%d,\"counter\":%d,\"ms\":%.3f}\n",phase,counter,(at-benchSentAt)*1000);benchExpected=-1;}
  benchCounter=counter;benchFrames++;
  printf("{\"event\":\"frame\",\"t\":%.6f,\"phase\":%d,\"sequence\":%u}\n",at,phase,bits>>12);
}
static void benchTick(rfbClient *c) {
 double at=benchNow(); if(!benchStart)benchStart=at;
 if(!benchStarted && benchFrames && at-benchStart>2){SendPointerEvent(c,40*benchDpr,20*benchDpr,1);SendPointerEvent(c,40*benchDpr,20*benchDpr,0);benchStarted=YES;}
 if(benchPhase==2 && at-benchLastClick>.6 && benchClicks<24 && benchExpected<0){benchExpected=(benchCounter+1)&255;benchSentAt=at;benchLastClick=at;benchClicks++;SendPointerEvent(c,540*benchDpr,20*benchDpr,1);SendPointerEvent(c,540*benchDpr,20*benchDpr,0);}
 if(benchExpected>=0 && at-benchSentAt>2){printf("{\"event\":\"input-timeout\",\"counter\":%d}\n",benchExpected);benchExpected=-1;}
 if(at-benchLastStats>1){benchLastStats=at;struct tcp_connection_info info={0};socklen_t len=sizeof(info);int ok=getsockopt(c->sock,IPPROTO_TCP,TCP_CONNECTION_INFO,&info,&len);struct rusage ru;getrusage(RUSAGE_SELF,&ru);double cpu=ru.ru_utime.tv_sec+ru.ru_utime.tv_usec/1e6+ru.ru_stime.tv_sec+ru.ru_stime.tv_usec/1e6;mach_task_basic_info_data_t m;mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&m,&count);
 printf("{\"event\":\"stats\",\"t\":%.6f,\"phase\":%d,\"frames\":%d,\"rxBytes\":%llu,\"tcpStatsOk\":%s,\"cpuSeconds\":%.6f,\"rssBytes\":%llu}\n",at,benchPhase,benchFrames,(unsigned long long)info.tcpi_rxbytes,ok==0?"true":"false",cpu,(unsigned long long)m.resident_size);printf("{\"event\":\"tcp\",\"t\":%.6f,\"phase\":%d,\"rttMs\":%u,\"srttMs\":%u,\"rxWindow\":%u,\"outOfOrderBytes\":%llu}\n",at,benchPhase,info.tcpi_rttcur,info.tcpi_srtt,info.tcpi_rcv_wnd,(unsigned long long)info.tcpi_rxoutoforderbytes);fflush(stdout);}
 if(benchPhase==6 && at-benchPhaseAt>2 && !benchSaved){benchSaved=YES;NSData *data=[NSData dataWithBytes:c->frameBuffer length:(NSUInteger)c->width*c->height*4];CGDataProviderRef p=CGDataProviderCreateWithCFData((__bridge CFDataRef)data);CGColorSpaceRef cs=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);CGImageRef im=CGImageCreate(c->width,c->height,8,32,c->width*4,cs,kCGBitmapByteOrder32Little|kCGImageAlphaNoneSkipFirst,p,NULL,NO,kCGRenderingIntentDefault);NSString *path=NSProcessInfo.processInfo.environment[@"BENCH_SNAPSHOT"] ?: [NSTemporaryDirectory() stringByAppendingPathComponent:@"rfb-quality.png"];CGImageDestinationRef dest=CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path],CFSTR("public.png"),1,NULL);CGImageDestinationAddImage(dest,im,NULL);BOOL ok=CGImageDestinationFinalize(dest);printf("{\"event\":\"snapshot\",\"ok\":%s}\n",ok?"true":"false");CFRelease(dest);CGImageRelease(im);CGColorSpaceRelease(cs);CGDataProviderRelease(p);}
 if(benchPhase==7 || at-benchStart>115){printf("{\"event\":\"complete\",\"phase\":%d,\"clicksSent\":%d}\n",benchPhase,benchClicks);fflush(stdout);exit(benchPhase==7 && benchClicks==24?0:5);}
}

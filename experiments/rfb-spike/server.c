// Synthetic framebuffer producer using upstream LibVNCServer. Audio is absent.
#include <arpa/inet.h>
#include <rfb/rfb.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static int live = 0, nextID = 0, toggle = 0;
static uint32_t frame = 0;
static volatile sig_atomic_t running = 1;
static void stop(int sig) { running = 0; }
static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}
static void gone(rfbClientPtr c) {
  live--;
  printf("{\"event\":\"left\",\"viewer\":%ld,\"viewers\":%d}\n",
         (long)c->clientData, live);
  fflush(stdout);
}
static enum rfbNewClientAction joined(rfbClientPtr c) {
  c->clientData = (void *)(intptr_t)++nextID;
  c->clientGoneHook = gone;
  live++;
  printf("{\"event\":\"joined\",\"viewer\":%d,\"viewers\":%d}\n", nextID, live);
  fflush(stdout);
  return RFB_CLIENT_ACCEPT;
}
static void pointer(int buttons, int x, int y, rfbClientPtr c) {
  if (buttons & 1) {
    toggle = !toggle;
    printf("{\"event\":\"click\",\"viewer\":%ld,\"x\":%d,\"y\":%d,\"toggle\":%"
           "d}\n",
           (long)c->clientData, x, y, toggle);
    fflush(stdout);
  }
  rfbDefaultPtrAddEvent(buttons, x, y, c);
}
static int resize(int w, int h, int count, rfbExtDesktopScreen *screens,
                  rfbClientPtr c) {
  if (w < 320 || h < 200 || w > 2048 || h > 1536 || count != 1)
    return rfbExtDesktopSize_InvalidScreenLayout;
  char *pixels = calloc((size_t)w * h, 4);
  if (!pixels)
    return rfbExtDesktopSize_OutOfResources;
  char *old = c->screen->frameBuffer;
  rfbNewFramebuffer(c->screen, pixels, w, h, 8, 3, 4);
  c->screen->serverFormat.redShift = 16;
  c->screen->serverFormat.greenShift = 8;
  c->screen->serverFormat.blueShift = 0;
  rfbClientIteratorPtr it = rfbGetClientIterator(c->screen);
  rfbClientPtr viewer;
  while ((viewer = rfbClientIteratorNext(it)))
    rfbSetTranslateFunction(viewer);
  rfbReleaseClientIterator(it);
  free(old);
  printf("{\"event\":\"viewport\",\"viewer\":%ld,\"width\":%d,\"height\":%d}\n",
         (long)c->clientData, w, h);
  fflush(stdout);
  return rfbExtDesktopSize_Success;
}
int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "server bind-ip port seconds\n");
    return 2;
  }
  signal(SIGINT, stop);
  signal(SIGTERM, stop);
  signal(SIGPIPE, SIG_IGN);
  int port = atoi(argv[2]), seconds = atoi(argv[3]);
  in_addr_t bind = inet_addr(argv[1]);
  int ac = 1;
  rfbScreenInfoPtr s = rfbGetScreen(&ac, argv, 800, 600, 8, 3, 4);
  s->frameBuffer = calloc(800 * 600, 4);
  s->desktopName = "WVE-79 RFB display spike";
  s->alwaysShared = TRUE;
  s->neverShared = FALSE;
  s->dontDisconnect = TRUE;
  s->port = port;
  s->ipv6port = -1;
  s->listenInterface = bind;
  s->httpPort = 0;
  s->newClientHook = joined;
  s->ptrAddEvent = pointer;
  s->setDesktopSizeHook = resize;
  s->serverFormat.redShift = 16;
  s->serverFormat.greenShift = 8;
  s->serverFormat.blueShift = 0;
  s->deferUpdateTime = 5;
  rfbInitServer(s);
  double start = now(), last = 0;
  printf("{\"event\":\"ready\",\"audio\":false}\n");
  fflush(stdout);
  while (running && now() - start < seconds) {
    rfbProcessEvents(s, 5000);
    double t = now();
    if (t - last < 1.0 / 30)
      continue;
    last = t;
    frame++;
    int w = s->width, h = s->height;
    uint32_t *p = (uint32_t *)s->frameBuffer;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        uint32_t color =
            y < h / 3 ? 0x234763 : (y < 2 * h / 3 ? 0x385c44 : 0x694661);
        if (x > ((frame * 6) % (w - 60)) && x < ((frame * 6) % (w - 60)) + 60)
          color = 0xe9ba55;
        if (x > 30 && x < 180 && y > 40 && y < 110)
          color = toggle ? 0x45c99b : 0xd76568;
        p[y * w + x] = color;
      }
    p[w * h - 2] = frame;
    p[w * h - 1] = toggle;
    rfbMarkRectAsModified(s, 0, 0, w, h);
  }
  rfbShutdownServer(s, TRUE);
  free(s->frameBuffer);
  s->frameBuffer = NULL;
  rfbScreenCleanup(s);
  printf("{\"event\":\"stopped\",\"frame\":%u}\n", frame);
  return 0;
}

// Independent pixel checker for the synthetic producer, using LibVNCClient.
#include <rfb/rfbclient.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
static int updates = 0, checks = 0, bad = 0, resizes = 0, changes = 0;
static uint32_t first = 0, last = 0, toggleLast = 0;
static double start;
static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}
static rfbBool alloc_fb(rfbClient *c) {
  if (c->width < 1 || c->height < 1 || c->width > 4096 || c->height > 4096)
    return FALSE;
  free(c->frameBuffer);
  c->frameBuffer = calloc((size_t)c->width * c->height, 4);
  resizes++;
  return c->frameBuffer != NULL;
}
static void finished(rfbClient *c) {
  updates++;
  int w = c->width, h = c->height;
  uint32_t *p = (uint32_t *)c->frameBuffer, n = p[w * h - 2] & 0xffffff,
           toggle = p[w * h - 1] & 0xffffff;
  if (!n)
    return;
  if (!first)
    first = n;
  last = n;
  if (toggle != toggleLast)
    changes++;
  toggleLast = toggle;
  int mismatch = 0;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      if ((x < 32 && y < 32) || (x >= w - 2 && y == h - 1))
        continue;
      uint32_t color =
          y < h / 3 ? 0x234763 : (y < 2 * h / 3 ? 0x385c44 : 0x694661);
      if (x > ((n * 6) % (w - 60)) && x < ((n * 6) % (w - 60)) + 60)
        color = 0xe9ba55;
      if (x > 30 && x < 180 && y > 40 && y < 110)
        color = toggle ? 0x45c99b : 0xd76568;
      if ((p[y * w + x] & 0xffffff) != color)
        mismatch++;
    }
  checks++;
  bad += mismatch;
  if (checks % 30 == 1) {
    printf("{\"event\":\"frame\",\"seconds\":%.3f,\"width\":%d,\"height\":%d,"
           "\"marker\":%u,\"toggle\":%u,\"mismatchedPixels\":%d}\n",
           now() - start, w, h, n, toggle, mismatch);
    fflush(stdout);
  }
}
int main(int argc, char **argv) {
  if (argc != 8) {
    fprintf(stderr,
            "probe host port seconds resize-after width height click-after\n");
    return 2;
  }
  double duration = atof(argv[3]), resizeAt = atof(argv[4]),
         clickAt = atof(argv[7]);
  int width = atoi(argv[5]), height = atoi(argv[6]);
  rfbClient *c = rfbGetClient(8, 3, 4);
  c->serverHost = strdup(argv[1]);
  c->serverPort = atoi(argv[2]);
  c->appData.shareDesktop = TRUE;
  c->appData.useRemoteCursor = TRUE;
  c->appData.encodingsString = "zrle hextile raw";
  c->canHandleNewFBSize = TRUE;
  c->format.redShift = 16;
  c->format.greenShift = 8;
  c->format.blueShift = 0;
  c->format.bigEndian = FALSE;
  c->MallocFrameBuffer = alloc_fb;
  c->FinishedFrameBufferUpdate = finished;
  c->connectTimeout = 5;
  c->readTimeout = 5;
  start = now();
  int ac = 1;
  if (!rfbInitClient(c, &ac, argv))
    return 3;
  int requested = 0, clicked = 0;
  while (now() - start < duration) {
    double elapsed = now() - start;
    if (resizeAt >= 0 && !requested && elapsed >= resizeAt) {
      requested = 1;
      SendExtDesktopSize(c, width, height);
    }
    if (clickAt >= 0 && !clicked && elapsed >= clickAt) {
      clicked = 1;
      SendPointerEvent(c, 50, 60, 1);
      SendPointerEvent(c, 50, 60, 0);
    }
    int ready = WaitForMessage(c, 20000);
    if (ready < 0 || (ready > 0 && !HandleRFBServerMessage(c)))
      break;
  }
  printf("{\"event\":\"result\",\"updates\":%d,\"checkedFrames\":%d,"
         "\"mismatchedPixels\":%d,\"allocations\":%d,\"firstMarker\":%u,"
         "\"lastMarker\":%u,\"toggleChanges\":%d,\"width\":%d,\"height\":%d}\n",
         updates, checks, bad, resizes, first, last, changes, c->width,
         c->height);
  free(c->frameBuffer);
  c->frameBuffer = NULL;
  rfbClientCleanup(c);
  return checks > 0 && bad == 0 ? 0 : 1;
}

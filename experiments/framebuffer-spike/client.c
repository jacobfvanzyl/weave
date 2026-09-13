// Diagnostic client: validates decoded display and audio without presenting
// either.
#include <glib.h>
#include <math.h>
#include <spice-client.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
static guint updates, audio_packets, starts, closed;
static guint64 samples;
static double energy;
static guint first, last, changes;
static uint8_t *pixels;
static int stride;
static gint64 began;
static void event(SpiceChannel *c, SpiceChannelEvent e, gpointer p) {
  int type;
  g_object_get(c, "channel-type", &type, NULL);
  if (e == SPICE_CHANNEL_CLOSED)
    closed++;
  printf("{\"event\":\"channel\",\"type\":%d,\"action\":%d,\"seconds\":%.3f}\n",
         type, e, (g_get_monotonic_time() - began) / 1e6);
  fflush(stdout);
}
static void primary(SpiceChannel *c, int format, int w, int h, int s, int shmid,
                    gpointer data, gpointer p) {
  pixels = data;
  stride = s;
  printf("{\"event\":\"primary\",\"width\":%d,\"height\":%d,\"format\":%d}\n",
         w, h, format);
}
static void destroy(SpiceChannel *c, gpointer p) { pixels = NULL; }
static void invalidate(SpiceChannel *c, int x, int y, int w, int h,
                       gpointer p) {
  updates++;
  if (pixels) {
    guint n = ((uint32_t *)pixels)[0] & 0xffffff;
    if (!first)
      first = n;
    if (n != last)
      changes++;
    last = n;
  }
}
static void audio_start(SpiceChannel *c, int format, int channels,
                        int frequency, gpointer p) {
  starts++;
  printf("{\"event\":\"audio-start\",\"format\":%d,\"channels\":%d,"
         "\"frequency\":%d}\n",
         format, channels, frequency);
}
static void audio_data(SpiceChannel *c, gpointer data, int size, gpointer p) {
  audio_packets++;
  int16_t *s = data;
  for (int i = 0; i < size / 2; i++) {
    double v = s[i] / 32768.0;
    energy += v * v;
    samples++;
  }
}
static void channel(SpiceSession *s, SpiceChannel *c, gpointer p) {
  int type;
  g_object_get(c, "channel-type", &type, NULL);
  g_signal_connect(c, "channel-event", G_CALLBACK(event), NULL);
  if (type == SPICE_CHANNEL_DISPLAY) {
    g_signal_connect(c, "display-primary-create", G_CALLBACK(primary), NULL);
    g_signal_connect(c, "display-primary-destroy", G_CALLBACK(destroy), NULL);
    g_signal_connect(c, "display-invalidate", G_CALLBACK(invalidate), NULL);
  }
  if (type == SPICE_CHANNEL_PLAYBACK) {
    g_signal_connect(c, "playback-start", G_CALLBACK(audio_start), NULL);
    g_signal_connect(c, "playback-data", G_CALLBACK(audio_data), NULL);
  }
  spice_channel_connect(c);
}
static gboolean stop(gpointer p) {
  g_main_loop_quit(p);
  return G_SOURCE_REMOVE;
}
int main(int argc, char **argv) {
  if (argc != 4)
    return 2;
  began = g_get_monotonic_time();
  GMainLoop *l = g_main_loop_new(NULL, FALSE);
  SpiceSession *s = spice_session_new();
  g_object_set(s, "host", argv[1], "port", argv[2], "enable-audio", TRUE,
               "enable-usbredir", FALSE, NULL);
  g_signal_connect(s, "channel-new", G_CALLBACK(channel), NULL);
  spice_session_connect(s);
  g_timeout_add_seconds(atoi(argv[3]), stop, l);
  g_main_loop_run(l);
  printf("{\"event\":\"result\",\"updates\":%u,\"changes\":%u,\"firstFrame\":%"
         "u,\"lastFrame\":%u,\"audioStarts\":%u,\"audioPackets\":%u,"
         "\"audioSamples\":%llu,\"audioRMS\":%.6f,\"closed\":%u}\n",
         updates, changes, first, last, starts, audio_packets,
         (unsigned long long)samples, samples ? sqrt(energy / samples) : 0,
         closed);
  spice_session_disconnect(s);
  return updates && audio_packets ? 0 : 1;
}

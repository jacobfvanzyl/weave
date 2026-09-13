// SPDX-License-Identifier: LGPL-2.1-or-later
/*
   Copyright (C) 2009-2015 Red Hat, Inc.

   This library is free software; you can redistribute it and/or
   modify it under the terms of the GNU Lesser General Public
   License as published by the Free Software Foundation; either
   version 2.1 of the License, or (at your option) any later version.

   This library is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public
   License along with this library; if not, see <http://www.gnu.org/licenses/>.
*/

// Synthetic SPICE public-API producer for WVE-79. No browser or VM.
// QXL setup follows the LGPL-2.1-or-later spice-server 0.16.0 test producer.
#include <glib-unix.h>
#include <glib.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <spice.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct SpiceTimer {
  SpiceTimerFunc fn;
  void *data;
  guint source;
};
struct SpiceWatch {
  int fd, mask;
  SpiceWatchFunc fn;
  void *data;
  guint source;
};
static gboolean timer_fire(gpointer p) {
  SpiceTimer *t = p;
  t->source = 0;
  t->fn(t->data);
  return G_SOURCE_REMOVE;
}
static SpiceTimer *timer_add(SpiceTimerFunc fn, void *data) {
  SpiceTimer *t = g_new0(SpiceTimer, 1);
  t->fn = fn;
  t->data = data;
  return t;
}
static void timer_cancel(SpiceTimer *t) {
  if (t->source)
    g_source_remove(t->source);
  t->source = 0;
}
static void timer_start(SpiceTimer *t, uint32_t ms) {
  timer_cancel(t);
  t->source = g_timeout_add(ms, timer_fire, t);
}
static void timer_remove(SpiceTimer *t) {
  timer_cancel(t);
  g_free(t);
}
static gboolean watch_fire(gint fd, GIOCondition cond, gpointer p) {
  SpiceWatch *w = p;
  w->fn(fd,
        ((cond & G_IO_IN) ? SPICE_WATCH_EVENT_READ : 0) |
            ((cond & G_IO_OUT) ? SPICE_WATCH_EVENT_WRITE : 0),
        w->data);
  return G_SOURCE_CONTINUE;
}
static void watch_update(SpiceWatch *w, int mask) {
  if (w->source)
    g_source_remove(w->source);
  w->mask = mask;
  w->source = mask ? g_unix_fd_add(w->fd,
                                   ((mask & 1) ? G_IO_IN : 0) |
                                       ((mask & 2) ? G_IO_OUT : 0),
                                   watch_fire, w)
                   : 0;
}
static SpiceWatch *watch_add(int fd, int mask, SpiceWatchFunc fn, void *data) {
  SpiceWatch *w = g_new0(SpiceWatch, 1);
  w->fd = fd;
  w->fn = fn;
  w->data = data;
  watch_update(w, mask);
  return w;
}
static void watch_remove(SpiceWatch *w) {
  watch_update(w, 0);
  g_free(w);
}
static void channel_event(int e, SpiceChannelEventInfo *i) {
  printf(
      "{\"event\":\"channel\",\"action\":%d,\"connection\":%d,\"type\":%d}\n",
      e, i->connection_id, i->type);
  fflush(stdout);
}
static SpiceCoreInterface core = {
    .base = {.major_version = SPICE_INTERFACE_CORE_MAJOR,
             .minor_version = SPICE_INTERFACE_CORE_MINOR},
    .timer_add = timer_add,
    .timer_start = timer_start,
    .timer_cancel = timer_cancel,
    .timer_remove = timer_remove,
    .watch_add = watch_add,
    .watch_update_mask = watch_update,
    .watch_remove = watch_remove,
    .channel_event = channel_event};
static SpiceServer *server;
static QXLInstance qxl;
static SpicePlaybackInstance playback;
static uint32_t surface[640 * 360];
static GAsyncQueue *queue;
struct Update {
  QXLCommandExt ext;
  QXLDrawable draw;
  QXLImage image;
  uint32_t pixels[640 * 360];
};
static void attach(QXLInstance *q) {
  QXLDevMemSlot slot = {.virt_end = UINTPTR_MAX, .qxl_ram_size = UINT32_MAX};
  spice_qxl_add_memslot(q, &slot);
  QXLDevSurfaceCreate s = {.width = 640,
                           .height = 360,
                           .stride = -640 * 4,
                           .format = SPICE_SURFACE_FMT_32_xRGB,
                           .mem = (uintptr_t)surface};
  spice_qxl_create_primary_surface(q, 0, &s);
}
static void init_info(QXLInstance *q, QXLDevInitInfo *i) {
  memset(i, 0, sizeof(*i));
  i->num_memslots = i->num_memslots_groups = 1;
  i->memslot_gen_bits = i->memslot_id_bits = 1;
  i->n_surfaces = 1;
}
static int get_command(QXLInstance *q, QXLCommandExt *c) {
  struct Update *u = g_async_queue_try_pop(queue);
  if (!u)
    return 0;
  *c = u->ext;
  return 1;
}
static int notify(QXLInstance *q) { return g_async_queue_length(queue) == 0; }
static int no_cursor(QXLInstance *q, QXLCommandExt *c) { return 0; }
static int yes(QXLInstance *q) { return 1; }
static int flush(QXLInstance *q) { return 0; }
static void release(QXLInstance *q, QXLReleaseInfoExt r) {
  g_free((void *)(uintptr_t)r.info->id);
}
static void compression(QXLInstance *q, int level) {}
static void update(QXLInstance *q, uint32_t id) {}
static QXLInterface qif = {
    .base = {SPICE_INTERFACE_QXL, "WVE79 synthetic bitmap",
             SPICE_INTERFACE_QXL_MAJOR, SPICE_INTERFACE_QXL_MINOR},
    .attached_worker = attach,
    .set_compression_level = compression,
    .get_init_info = init_info,
    .get_command = get_command,
    .req_cmd_notification = notify,
    .release_resource = release,
    .get_cursor_command = no_cursor,
    .req_cursor_notification = yes,
    .notify_update = update,
    .flush_resources = flush};
static SpicePlaybackInterface aif = {
    .base = {SPICE_INTERFACE_PLAYBACK, "WVE79 tone",
             SPICE_INTERFACE_PLAYBACK_MAJOR, SPICE_INTERFACE_PLAYBACK_MINOR}};
static gboolean frame_tick(gpointer p) {
  static uint32_t n = 0;
  if (g_async_queue_length(queue) > 2)
    return G_SOURCE_CONTINUE;
  struct Update *u = g_new0(struct Update, 1);
  n++;
  for (int y = 0; y < 360; y++)
    for (int x = 0; x < 640; x++)
      u->pixels[y * 640 + x] =
          (x / 32 % 2 ? 0x203060 : 0x304080) ^
          ((x > (n * 8) % 600 && x < (n * 8) % 600 + 40) ? 0x90c000 : 0);
  u->pixels[0] = n;
  QXLDrawable *d = &u->draw;
  d->release_info.id = (uintptr_t)u;
  d->bbox.right = 640;
  d->bbox.bottom = 360;
  d->effect = QXL_EFFECT_OPAQUE;
  d->type = QXL_DRAW_COPY;
  d->surfaces_dest[0] = d->surfaces_dest[1] = d->surfaces_dest[2] = -1;
  d->u.copy.rop_descriptor = SPICE_ROPD_OP_PUT;
  d->u.copy.src_bitmap = (uintptr_t)&u->image;
  d->u.copy.src_area = d->bbox;
  u->image.descriptor.id = n;
  u->image.descriptor.type = SPICE_IMAGE_TYPE_BITMAP;
  u->image.descriptor.width = u->image.bitmap.x = 640;
  u->image.descriptor.height = u->image.bitmap.y = 360;
  u->image.bitmap.flags = QXL_BITMAP_DIRECT | QXL_BITMAP_TOP_DOWN;
  u->image.bitmap.stride = 640 * 4;
  u->image.bitmap.format = SPICE_BITMAP_FMT_32BIT;
  u->image.bitmap.data = (uintptr_t)u->pixels;
  u->ext.cmd.type = QXL_CMD_DRAW;
  u->ext.cmd.data = (uintptr_t)d;
  g_async_queue_push(queue, u);
  spice_qxl_wakeup(&qxl);
  return G_SOURCE_CONTINUE;
}
static gboolean audio_tick(gpointer p) {
  static uint64_t phase = 0;
  uint32_t *buf, count;
  spice_server_playback_get_buffer(&playback, &buf, &count);
  if (buf) {
    for (uint32_t i = 0; i < count; i++) {
      int16_t s = (int16_t)(1800 * sin(2 * M_PI * 440 * phase++ / 44100));
      buf[i] = (uint16_t)s | ((uint32_t)(uint16_t)s << 16);
    }
    spice_server_playback_put_samples(&playback, buf);
  }
  return G_SOURCE_CONTINUE;
}
static gboolean stop(gpointer p) {
  g_main_loop_quit(p);
  return G_SOURCE_REMOVE;
}
int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: server bind-address port seconds\n");
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);
  queue = g_async_queue_new();
  server = spice_server_new();
  spice_server_set_addr(server, argv[1], 0);
  spice_server_set_port(server, atoi(argv[2]));
  spice_server_set_noauth(server);
  spice_server_set_image_compression(server, SPICE_IMAGE_COMPRESSION_QUIC);
  spice_server_set_streaming_video(server, SPICE_STREAM_VIDEO_OFF);
  if (spice_server_init(server, &core))
    return 3;
  qxl.base.sif = &qif.base;
  spice_server_add_interface(server, &qxl.base);
  playback.base.sif = &aif.base;
  spice_server_add_interface(server, &playback.base);
  spice_server_playback_start(&playback);
  spice_server_vm_start(server);
  printf("{\"event\":\"ready\",\"compatVersion\":%d,\"multiClient\":%s}\n",
         spice_get_current_compat_version(),
         getenv("SPICE_DEBUG_ALLOW_MC") ? "true" : "false");
  fflush(stdout);
  g_timeout_add(100, frame_tick, NULL);
  g_timeout_add(23, audio_tick, NULL);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_timeout_add_seconds(atoi(argv[3]), stop, loop);
  g_main_loop_run(loop);
  spice_server_destroy(server);
  return 0;
}

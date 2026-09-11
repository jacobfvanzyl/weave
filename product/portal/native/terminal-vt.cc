#include <node_api.h>
#include <ghostty/vt.h>
#include <WeaveTerminalCodec.h>
#include <unordered_map>
#include <vector>
#include <memory>
#include <algorithm>
#include <unistd.h>
#include <limits.h>
#include <stdio.h>
#ifdef __APPLE__
#include <libproc.h>
#endif

// Only public VT APIs live here. Bun owns PTYs, scheduling and service IPC.
namespace {
struct Terminal {
  GhosttyTerminal vt = nullptr;
  std::vector<uint8_t> replies;
  bool overflow = false;
  ~Terminal() { ghostty_terminal_free(vt); }
};
std::unordered_map<uint32_t, std::unique_ptr<Terminal>> terminals;
uint32_t nextId = 1;
constexpr size_t maxBytes = 64 * 1024 * 1024;
napi_value fail(napi_env env, const char* message) { napi_throw_error(env, nullptr, message); return nullptr; }
napi_value number(napi_env env, uint32_t n) { napi_value v; napi_create_uint32(env, n, &v); return v; }
napi_value bytes(napi_env env, const void* data, size_t length) {
  napi_value v; napi_create_buffer_copy(env, length, data, nullptr, &v); return v;
}
void reply(GhosttyTerminal, void* context, const uint8_t* data, size_t length) {
  auto* t = static_cast<Terminal*>(context);
  if (t->replies.size() + length > 1024 * 1024) { t->overflow = true; return; }
  t->replies.insert(t->replies.end(), data, data + length);
}
bool snapshotWrite(void* context, const uint8_t* data, size_t length) {
  auto* output = static_cast<std::vector<uint8_t>*>(context);
  if (output->size() + length > maxBytes) return false;
  output->insert(output->end(), data, data + length); return true;
}
Terminal* get(napi_env env, napi_value value) {
  uint32_t id = 0;
  if (napi_get_value_uint32(env, value, &id) != napi_ok) return nullptr;
  auto it = terminals.find(id); return it == terminals.end() ? nullptr : it->second.get();
}
napi_value create(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; uint32_t cols = 0, rows = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2 || napi_get_value_uint32(env, args[0], &cols) != napi_ok || napi_get_value_uint32(env, args[1], &rows) != napi_ok || cols < 2 || cols > 500 || rows < 2 || rows > 300) return fail(env, "Invalid terminal dimensions");
  auto t = std::make_unique<Terminal>();
  if (ghostty_terminal_new(nullptr, &t->vt, cols, rows) != GHOSTTY_SUCCESS) return fail(env, "Cannot create VT");
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_USERDATA, t.get());
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_WRITE_PTY, reinterpret_cast<const void*>(reply));
  size_t historyBytes = 16 * 1024 * 1024, lines = 10000, continuation = 1024 * 1024, noImages = 0;
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &historyBytes);
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES, &continuation);
  // The public snapshot codec cannot restore image registries. No client
  // implements image rendering; keep graphics and native side effects disabled.
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &noImages);
  GhosttyTerminalModeConfig graphemes = {GHOSTTY_MODE_GRAPHEME_CLUSTER, true};
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  GhosttyColorRgb bg = {30,30,46}, fg = {205,214,244}, cursor = {245,224,220};
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &bg);
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &fg);
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
  GhosttyColorRgb palette[256]; ghostty_terminal_get(t->vt, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE, &palette);
  const GhosttyColorRgb theme[] = {{69,71,90},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{186,194,222},{88,91,112},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{166,173,200}};
  std::copy(std::begin(theme), std::end(theme), palette);
  ghostty_terminal_set(t->vt, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, &palette);
  const auto id = nextId++; terminals.emplace(id, std::move(t)); return number(env, id);
}
napi_value write(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2, length = 0; void* data = nullptr;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto* t = count == 2 ? get(env, args[0]) : nullptr;
  if (!t || napi_get_buffer_info(env, args[1], &data, &length) != napi_ok || length > 1024 * 1024) return fail(env, "Invalid VT write");
  t->replies.clear(); t->overflow = false;
  ghostty_terminal_vt_write(t->vt, static_cast<uint8_t*>(data), length);
  if (t->overflow) return fail(env, "VT response limit exceeded");
  return bytes(env, t->replies.data(), t->replies.size());
}
napi_value resize(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3; uint32_t cols = 0, rows = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  auto* t = count == 3 ? get(env, args[0]) : nullptr;
  if (!t || napi_get_value_uint32(env, args[1], &cols) != napi_ok || napi_get_value_uint32(env, args[2], &rows) != napi_ok || cols < 2 || cols > 500 || rows < 2 || rows > 300) return fail(env, "Invalid VT resize");
  t->replies.clear(); t->overflow = false;
  if (ghostty_terminal_resize(t->vt, cols, rows, 0, 0) != GHOSTTY_SUCCESS) return fail(env, "VT resize failed");
  return bytes(env, t->replies.data(), t->replies.size());
}
napi_value snapshot(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto* t = count == 1 ? get(env, arg) : nullptr; if (!t) return fail(env, "Terminal unavailable");
  std::vector<uint8_t> output;
  if (ghostty_snapshot_encode(t->vt, {snapshotWrite, &output}) != GHOSTTY_SUCCESS) return fail(env, "VT snapshot failed or exceeded limit");
  GhosttySnapshotDecoder decoder = nullptr; GhosttyTerminal replica = nullptr;
  if (ghostty_snapshot_decoder_new_buf(nullptr, &decoder, output.data(), output.size()) != GHOSTTY_SUCCESS || ghostty_snapshot_decoder_ready(decoder, &replica) != GHOSTTY_SUCCESS) {
    ghostty_snapshot_decoder_free(decoder); return fail(env, "Encoded snapshot cannot be restored");
  }
  napi_value result, offsets; napi_create_object(env, &result); napi_create_array(env, &offsets);
  uint32_t index = 0; size_t offset = 0;
  ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &offset);
  napi_set_element(env, offsets, index++, number(env, offset));
  GhosttyResult status;
  do {
    status = ghostty_snapshot_decoder_next(decoder);
    if (status != GHOSTTY_SUCCESS && status != GHOSTTY_NO_VALUE) break;
    ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &offset);
    napi_set_element(env, offsets, index++, number(env, offset));
  } while (status == GHOSTTY_SUCCESS);
  ghostty_snapshot_decoder_free(decoder); ghostty_terminal_free(replica);
  if (status != GHOSTTY_NO_VALUE) return fail(env, "Encoded history cannot be restored");
  napi_set_named_property(env, result, "data", bytes(env, output.data(), output.size()));
  napi_set_named_property(env, result, "offsets", offsets); return result;
}
napi_value metadata(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  auto* t = count == 1 ? get(env, arg) : nullptr; if (!t) return fail(env, "Terminal unavailable");
  napi_value result; napi_create_object(env, &result);
  for (auto key : {GHOSTTY_TERMINAL_DATA_TITLE, GHOSTTY_TERMINAL_DATA_PWD}) {
    GhosttyString s{}; ghostty_terminal_get(t->vt, key, &s);
    napi_value value; napi_create_string_utf8(env, reinterpret_cast<const char*>(s.ptr), s.len, &value);
    napi_set_named_property(env, result, key == GHOSTTY_TERMINAL_DATA_TITLE ? "title" : "directory", value);
  }
  return result;
}
napi_value close(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; uint32_t id = 0; napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count == 1 && napi_get_value_uint32(env, arg, &id) == napi_ok) terminals.erase(id);
  return number(env, 0);
}
napi_value processDirectory(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; uint32_t pid = 0; napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_uint32(env, arg, &pid) != napi_ok || pid < 2) return fail(env, "Invalid process identity");
  char directory[PATH_MAX] = {};
#ifdef __APPLE__
  struct proc_vnodepathinfo paths = {};
  if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) == sizeof(paths)) snprintf(directory, sizeof(directory), "%s", paths.pvi_cdir.vip_path);
#else
  char path[64]; snprintf(path, sizeof(path), "/proc/%u/cwd", pid);
  ssize_t length = readlink(path, directory, sizeof(directory) - 1); if (length > 0) directory[length] = 0;
#endif
  napi_value result; napi_create_string_utf8(env, directory, NAPI_AUTO_LENGTH, &result); return result;
}
napi_value init(napi_env env, napi_value exports) {
  napi_value codec; napi_create_string_utf8(env, WEAVE_TERMINAL_CODEC, NAPI_AUTO_LENGTH, &codec); napi_set_named_property(env, exports, "codec", codec);
  const napi_property_descriptor methods[] = {
    {"create",0,create,0,0,0,napi_default,0}, {"write",0,write,0,0,0,napi_default,0},
    {"resize",0,resize,0,0,0,napi_default,0}, {"snapshot",0,snapshot,0,0,0,napi_default,0},
    {"processDirectory",0,processDirectory,0,0,0,napi_default,0}, {"metadata",0,metadata,0,0,0,napi_default,0}, {"close",0,close,0,0,0,napi_default,0}
  };
  napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

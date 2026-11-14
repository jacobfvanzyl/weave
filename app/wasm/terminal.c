// The Mac's terminal, in WebAssembly (WVE-205, ADR 0032): libghostty-vt behind a few calls the
// page can make without knowing its C structs. One `Terminal` is a replica of a holder's
// screen, as `ios/App/App/WeaveTerminalRenderer.mm` is on the iPad: it's restored from a
// snapshot or the formatter's VT, written the holder's output, and read back a frame at a time
// as rows of cells the page draws on a canvas. Keys, the mouse and pastes are encoded here, by
// the modes the screen is in, and the page sends the bytes.
//
// Built by `scripts/ghostty.ts web` against the Ghostty `holder/ghostty.toml` pins, for
// wasm32-freestanding: no libc, no imports. `src/terminal/web/core.ts` is the other side, and
// reads `Frame` and `Cell` by the offsets here.
#include <ghostty/vt.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))

// Catppuccin Mocha, the app's own colors, as on the iPad.
static const GhosttyColorRgb theme_background = {30, 30, 46}, theme_foreground = {205, 214, 244}, theme_cursor = {245, 224, 220};
static const GhosttyColorRgb theme_palette[16] = {{69,71,90},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{186,194,222},
  {88,91,112},{243,139,168},{166,227,161},{249,226,175},{137,180,250},{245,194,231},{148,226,213},{166,173,200}};

enum {
  CELL_BOLD = 1, CELL_ITALIC = 2, CELL_UNDERLINE = 4, CELL_STRIKE = 8, CELL_INVISIBLE = 16,
  /** The second half of a wide character, or the cell a wrapped one left empty. */
  CELL_SPACER = 32,
  CELL_WIDE = 64, CELL_SELECTED = 128, CELL_LINK = 256,
};

/** A cell on screen: five `uint32_t`s. */
typedef struct {
  /** Its one codepoint; 0 when it's empty, or when `text_len` says it has several. */
  uint32_t codepoint;
  /** 0xRRGGBB. */
  uint32_t foreground, background;
  uint16_t flags;
  /** UTF-8 bytes of a cluster of several codepoints, at `text` in its row's text. */
  uint16_t text_len;
  uint32_t text;
} Cell;

/** What `wt_frame` answers with: `uint32_t`s the page reads in this order. */
typedef struct {
  uint32_t columns, rows;
  uint32_t cursor_x, cursor_y, cursor_visible, cursor_style, cursor_color;
  uint32_t background, foreground;
  /** Whether the program asked for the mouse. */
  uint32_t mouse;
  /** The scrollback: every row there is, the first on screen, and how many are. */
  uint32_t scroll_total, scroll_offset, scroll_len;
  /** `columns * rows` cells, a row after another. */
  Cell *cells;
  /** A byte per row: whether it changed since the frame before. */
  uint8_t *dirty;
  /** A byte per row: whether it wraps into the next. */
  uint8_t *wrapped;
  /** Each row's clusters of several codepoints: `text_stride` bytes a row. */
  uint8_t *text;
  uint32_t text_stride;
  /** Whether any row changed, or the cursor or colors may have. */
  uint32_t changed;
  /** Whether the program is on the alternate screen, which has no scrollback. */
  uint32_t alternate;
} Frame;

typedef struct {
  GhosttyTerminal terminal;
  GhosttyRenderState state;
  GhosttyRenderStateRowIterator iterator;
  GhosttyRenderStateRowCells row_cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  GhosttySelectionGesture gesture;
  GhosttySelectionGestureEvent press, drag, release;
  uint16_t columns, rows;
  uint32_t cell_width, cell_height;
  Frame frame;
  size_t cells_len, text_len;
  bool full;
  /** What a call wrote for the page to take: bytes to send, or text. */
  uint8_t *out;
  size_t out_cap, out_len;
} Terminal;

static void *allocate(size_t len) { return ghostty_alloc(NULL, len); }
static void release(void *ptr, size_t len) { if (ptr) ghostty_free(NULL, ptr, len); }
static void zero(void *ptr, size_t len) { uint8_t *bytes = ptr; for (size_t i = 0; i < len; i++) bytes[i] = 0; }
static uint32_t rgb(GhosttyColorRgb color) { return (uint32_t)color.r << 16 | (uint32_t)color.g << 8 | color.b; }
static bool same(const char *a, size_t a_len, const char *b) {
  size_t i = 0;
  for (; i < a_len && b[i]; i++) if (a[i] != b[i]) return false;
  return i == a_len && !b[i];
}

/** Memory for the page to write into, and to give back. */
EXPORT(wt_alloc) void *wt_alloc(size_t len) { return allocate(len ? len : 1); }
EXPORT(wt_free) void wt_free(void *ptr, size_t len) { release(ptr, len ? len : 1); }

/** The embedder's defaults: programs' own colors (OSC 4, 10, 11) stay over them. */
static void apply_theme(GhosttyTerminal terminal) {
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &theme_background);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &theme_foreground);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &theme_cursor);
  static GhosttyColorRgb palette[256];
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, NULL);
  ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT, &palette);
  for (int i = 0; i < 16; i++) palette[i] = theme_palette[i];
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, &palette);
  size_t bytes = 16 * 1024 * 1024, lines = 10000, no_images = 0;
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &bytes);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &no_images);
  // A replica registers no PTY or effect callbacks: the holder answers the program's queries,
  // once. Its key and mouse encoders still read the modes.
}

/** The version libghostty-vt's snapshots carry, which with the pinned commit names the codec. */
EXPORT(wt_snapshot_version) uint32_t wt_snapshot_version(void) {
  uint32_t version = 0;
  GhosttyTerminal blank = NULL;
  if (ghostty_terminal_new(NULL, &blank, 2, 2) != GHOSTTY_SUCCESS) return 0;
  uint8_t *bytes = NULL; size_t length = 0;
  if (ghostty_snapshot_encode_alloc(blank, NULL, &bytes, &length) == GHOSTTY_SUCCESS && length >= 10) version = bytes[8] | bytes[9] << 8;
  if (bytes) ghostty_free(NULL, bytes, length);
  ghostty_terminal_free(blank);
  return version;
}

static void replace(Terminal *t, GhosttyTerminal next) {
  if (t->terminal) {
    ghostty_selection_gesture_reset(t->gesture, t->terminal);
    ghostty_terminal_free(t->terminal);
  }
  t->terminal = next;
  uint16_t columns = 0, rows = 0;
  ghostty_terminal_get(next, GHOSTTY_TERMINAL_DATA_COLS, &columns);
  ghostty_terminal_get(next, GHOSTTY_TERMINAL_DATA_ROWS, &rows);
  t->columns = columns ? columns : 1; t->rows = rows ? rows : 1;
  t->full = true;
}

/** A blank screen of `columns` by `rows`, in place of the one before. */
EXPORT(wt_reset) bool wt_reset(Terminal *t, uint32_t columns, uint32_t rows) {
  if (columns < 1 || columns > 1000 || rows < 1 || rows > 500) return false;
  GhosttyTerminal next = NULL;
  if (ghostty_terminal_new(NULL, &next, (uint16_t)columns, (uint16_t)rows) != GHOSTTY_SUCCESS) return false;
  apply_theme(next);
  GhosttyTerminalModeConfig graphemes = {GHOSTTY_MODE_GRAPHEME_CLUSTER, true};
  ghostty_terminal_set(next, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT, &graphemes);
  ghostty_terminal_resize(next, (uint16_t)columns, (uint16_t)rows, t->cell_width, t->cell_height);
  replace(t, next);
  return true;
}

EXPORT(wt_close) void wt_close(Terminal *t) {
  if (!t) return;
  if (t->gesture) ghostty_selection_gesture_free(t->gesture, t->terminal);
  ghostty_selection_gesture_event_free(t->press); ghostty_selection_gesture_event_free(t->drag); ghostty_selection_gesture_event_free(t->release);
  ghostty_mouse_event_free(t->mouse_event); ghostty_mouse_encoder_free(t->mouse_encoder);
  ghostty_key_event_free(t->key_event); ghostty_key_encoder_free(t->key_encoder);
  ghostty_terminal_free(t->terminal);
  ghostty_render_state_row_cells_free(t->row_cells);
  ghostty_render_state_row_iterator_free(t->iterator);
  ghostty_render_state_free(t->state);
  release(t->frame.cells, t->cells_len * sizeof(Cell));
  release(t->frame.dirty, t->frame.rows); release(t->frame.wrapped, t->frame.rows);
  release(t->frame.text, t->text_len);
  release(t->out, t->out_cap);
  release(t, sizeof(Terminal));
}

/** A terminal of `columns` by `rows`, whose cells are `cell_width` by `cell_height` pixels. */
EXPORT(wt_new) Terminal *wt_new(uint32_t columns, uint32_t rows, uint32_t cell_width, uint32_t cell_height) {
  Terminal *t = allocate(sizeof(Terminal));
  if (!t) return NULL;
  zero(t, sizeof(Terminal));
  t->cell_width = cell_width ? cell_width : 1; t->cell_height = cell_height ? cell_height : 1;
  if (ghostty_mouse_encoder_new(NULL, &t->mouse_encoder) != GHOSTTY_SUCCESS || ghostty_mouse_event_new(NULL, &t->mouse_event) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(NULL, &t->key_encoder) != GHOSTTY_SUCCESS || ghostty_key_event_new(NULL, &t->key_event) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &t->state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &t->iterator) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &t->row_cells) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_new(NULL, &t->gesture) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(NULL, &t->press, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(NULL, &t->drag, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(NULL, &t->release, GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE) != GHOSTTY_SUCCESS ||
      !wt_reset(t, columns, rows)) { wt_close(t); return NULL; }
  return t;
}

/** The holder's snapshot as the screen, history and all; the screen stays as it was if it doesn't decode. */
EXPORT(wt_restore) bool wt_restore(Terminal *t, const uint8_t *snapshot, size_t len) {
  GhosttySnapshotDecoder decoder = NULL; GhosttyTerminal next = NULL;
  if (ghostty_snapshot_decoder_new_buf(NULL, &decoder, snapshot, len) == GHOSTTY_SUCCESS &&
      ghostty_snapshot_decoder_decode(decoder, &next) != GHOSTTY_SUCCESS) next = NULL;
  ghostty_snapshot_decoder_free(decoder);
  if (!next) return false;
  apply_theme(next);
  replace(t, next);
  return true;
}

EXPORT(wt_write) void wt_write(Terminal *t, const uint8_t *output, size_t len) {
  ghostty_terminal_vt_write(t->terminal, output, len);
}

/** The grid's size, and its cells' in pixels, which a program may ask for. */
EXPORT(wt_resize) bool wt_resize(Terminal *t, uint32_t columns, uint32_t rows, uint32_t cell_width, uint32_t cell_height) {
  if (columns < 1 || columns > 1000 || rows < 1 || rows > 500) return false;
  t->cell_width = cell_width ? cell_width : 1; t->cell_height = cell_height ? cell_height : 1;
  if (ghostty_terminal_resize(t->terminal, (uint16_t)columns, (uint16_t)rows, t->cell_width, t->cell_height) != GHOSTTY_SUCCESS) return false;
  t->columns = (uint16_t)columns; t->rows = (uint16_t)rows;
  return true;
}

static bool size_frame(Terminal *t) {
  Frame *frame = &t->frame;
  if (frame->columns == t->columns && frame->rows == t->rows && frame->cells) return true;
  release(frame->cells, t->cells_len * sizeof(Cell));
  release(frame->dirty, frame->rows); release(frame->wrapped, frame->rows);
  release(frame->text, t->text_len);
  frame->columns = t->columns; frame->rows = t->rows;
  t->cells_len = (size_t)t->columns * t->rows;
  // Room for a cluster in every cell of a row; one that doesn't fit shows its first codepoint.
  frame->text_stride = (uint32_t)t->columns * 8 + 64;
  t->text_len = (size_t)frame->text_stride * t->rows;
  frame->cells = allocate(t->cells_len * sizeof(Cell));
  frame->dirty = allocate(t->rows); frame->wrapped = allocate(t->rows);
  frame->text = allocate(t->text_len);
  if (!frame->cells || !frame->dirty || !frame->wrapped || !frame->text) { frame->columns = frame->rows = 0; return false; }
  zero(frame->cells, t->cells_len * sizeof(Cell)); zero(frame->wrapped, t->rows);
  t->full = true;
  return true;
}

/**
 * The screen as it is now: every row, with those that changed since the last call marked. The
 * frame and what it points at are the terminal's, good until the next call on it.
 */
EXPORT(wt_frame) Frame *wt_frame(Terminal *t) {
  Frame *frame = &t->frame;
  if (!size_frame(t) || ghostty_render_state_update(t->state, t->terminal) != GHOSTTY_SUCCESS) return NULL;
  if (t->full) {
    GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
    ghostty_render_state_set(t->state, GHOSTTY_RENDER_STATE_OPT_DIRTY, &dirty);
    t->full = false;
  }
  GhosttyColorRgb background = theme_background, foreground = theme_foreground;
  ghostty_render_state_get(t->state, GHOSTTY_RENDER_STATE_DATA_COLOR_BACKGROUND, &background);
  ghostty_render_state_get(t->state, GHOSTTY_RENDER_STATE_DATA_COLOR_FOREGROUND, &foreground);
  frame->changed = frame->background != rgb(background) || frame->foreground != rgb(foreground);
  frame->background = rgb(background); frame->foreground = rgb(foreground);
  zero(frame->dirty, t->rows);
  ghostty_render_state_get(t->state, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &t->iterator);
  uint16_t y = 0;
  while (ghostty_render_state_row_iterator_next_dirty(t->iterator, &y)) {
    if (y >= t->rows) break;
    frame->dirty[y] = 1; frame->changed = 1;
    GhosttyRow row = 0; bool wrapped = false;
    ghostty_render_state_row_get(t->iterator, GHOSTTY_RENDER_STATE_ROW_DATA_RAW, &row);
    ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP, &wrapped);
    frame->wrapped[y] = wrapped;
    ghostty_render_state_row_get(t->iterator, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &t->row_cells);
    uint8_t *text = frame->text + (size_t)y * frame->text_stride;
    uint32_t used = 0;
    for (uint16_t x = 0; x < t->columns && ghostty_render_state_row_cells_next(t->row_cells); x++) {
      Cell cell = {0};
      GhosttyCell raw = 0; GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) cell.flags |= CELL_SPACER;
      if (wide == GHOSTTY_CELL_WIDE_WIDE) cell.flags |= CELL_WIDE;
      bool link = false, selected = false;
      ghostty_cell_get(raw, GHOSTTY_CELL_DATA_HAS_HYPERLINK, &link);
      if (link) cell.flags |= CELL_LINK;
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, &selected);
      if (selected) cell.flags |= CELL_SELECTED;
      GhosttyColorRgb fg = foreground, bg = background;
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bg);
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &fg);
      GhosttyStyle style = {0};
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
      if (style.flags & GHOSTTY_STYLE_FLAG_INVERSE) { GhosttyColorRgb swap = fg; fg = bg; bg = swap; }
      if (style.flags & GHOSTTY_STYLE_FLAG_FAINT) { fg.r /= 2; fg.g /= 2; fg.b /= 2; }
      if (style.flags & GHOSTTY_STYLE_FLAG_BOLD) cell.flags |= CELL_BOLD;
      if (style.flags & GHOSTTY_STYLE_FLAG_ITALIC) cell.flags |= CELL_ITALIC;
      if (GHOSTTY_STYLE_UNDERLINE(style) != GHOSTTY_SGR_UNDERLINE_NONE) cell.flags |= CELL_UNDERLINE;
      if (style.flags & GHOSTTY_STYLE_FLAG_STRIKETHROUGH) cell.flags |= CELL_STRIKE;
      if (style.flags & GHOSTTY_STYLE_FLAG_INVISIBLE) cell.flags |= CELL_INVISIBLE;
      cell.foreground = rgb(fg); cell.background = rgb(bg);
      uint32_t codepoints = 0;
      ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &codepoints);
      if (codepoints >= 1) ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CODEPOINT, &cell.codepoint);
      if (codepoints > 1) {
        GhosttyBuffer buffer = {text + used, frame->text_stride - used, 0};
        if (ghostty_render_state_row_cells_get(t->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &buffer) == GHOSTTY_SUCCESS && buffer.len && buffer.len < 65536) {
          cell.text = used; cell.text_len = (uint16_t)buffer.len; used += (uint32_t)buffer.len;
        }
      }
      frame->cells[(size_t)y * t->columns + x] = cell;
    }
  }
  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(t->state, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  GhosttyColorRgb cursor_color = theme_cursor;
  ghostty_render_state_get(t->state, GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR, &cursor_color);
  uint32_t visible = cursor.visible && cursor.viewport_has_value;
  uint32_t x = visible ? cursor.viewport_x : 0, cursor_y = visible ? cursor.viewport_y : 0;
  if (frame->cursor_visible != visible || frame->cursor_x != x || frame->cursor_y != cursor_y ||
      frame->cursor_style != (uint32_t)cursor.visual_style || frame->cursor_color != rgb(cursor_color)) frame->changed = 1;
  frame->cursor_visible = visible; frame->cursor_x = x; frame->cursor_y = cursor_y;
  frame->cursor_style = (uint32_t)cursor.visual_style; frame->cursor_color = rgb(cursor_color);
  bool mouse = false;
  ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &mouse);
  frame->mouse = mouse;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
  frame->alternate = screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE;
  GhosttyTerminalScrollbar scrollbar = {0};
  ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &scrollbar);
  if (frame->scroll_offset != (uint32_t)scrollbar.offset || frame->scroll_total != (uint32_t)scrollbar.total) frame->changed = 1;
  frame->scroll_total = (uint32_t)scrollbar.total; frame->scroll_offset = (uint32_t)scrollbar.offset; frame->scroll_len = (uint32_t)scrollbar.len;
  ghostty_render_state_clean(t->state);
  return frame;
}

/** Scrolls back (negative) or forward by `lines`. */
EXPORT(wt_scroll) void wt_scroll(Terminal *t, int32_t lines) {
  GhosttyTerminalScrollViewport scroll = {GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA, {0}};
  scroll.value.delta = lines;
  ghostty_terminal_scroll_viewport(t->terminal, scroll);
}

/** Back to where the program is writing. */
EXPORT(wt_scroll_bottom) void wt_scroll_bottom(Terminal *t) {
  GhosttyTerminalScrollViewport scroll = {GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM, {0}};
  ghostty_terminal_scroll_viewport(t->terminal, scroll);
}

static bool reserve(Terminal *t, size_t len) {
  if (len <= t->out_cap) return true;
  size_t cap = len < 256 ? 256 : len;
  uint8_t *next = allocate(cap);
  if (!next) return false;
  release(t->out, t->out_cap);
  t->out = next; t->out_cap = cap;
  return true;
}

/** What the last call that says so wrote, for the page to take before its next call. */
EXPORT(wt_out) const uint8_t *wt_out(Terminal *t) { return t->out; }

static GhosttyKey physical_key(const char *name, size_t len) {
  if (len == 4 && name[0] == 'K' && name[1] == 'e' && name[2] == 'y' && name[3] >= 'A' && name[3] <= 'Z') return (GhosttyKey)(GHOSTTY_KEY_A + name[3] - 'A');
  if (len == 6 && same(name, 5, "Digit") && name[5] >= '0' && name[5] <= '9') return (GhosttyKey)(GHOSTTY_KEY_DIGIT_0 + name[5] - '0');
  if (len == 7 && same(name, 6, "Numpad") && name[6] >= '0' && name[6] <= '9') return (GhosttyKey)(GHOSTTY_KEY_NUMPAD_0 + name[6] - '0');
  if (len >= 2 && len <= 3 && name[0] == 'F' && name[1] >= '0' && name[1] <= '9') {
    int function = name[1] - '0';
    if (len == 3) { if (name[2] < '0' || name[2] > '9') return GHOSTTY_KEY_UNIDENTIFIED; function = function * 10 + name[2] - '0'; }
    if (function >= 1 && function <= 25) return (GhosttyKey)(GHOSTTY_KEY_F1 + function - 1);
  }
  static const struct { const char *name; GhosttyKey key; } keys[] = {
    {"NumpadEnter", GHOSTTY_KEY_NUMPAD_ENTER}, {"NumpadAdd", GHOSTTY_KEY_NUMPAD_ADD}, {"NumpadSubtract", GHOSTTY_KEY_NUMPAD_SUBTRACT},
    {"NumpadMultiply", GHOSTTY_KEY_NUMPAD_MULTIPLY}, {"NumpadDivide", GHOSTTY_KEY_NUMPAD_DIVIDE}, {"NumpadDecimal", GHOSTTY_KEY_NUMPAD_DECIMAL},
    {"NumpadEqual", GHOSTTY_KEY_NUMPAD_EQUAL}, {"NumLock", GHOSTTY_KEY_NUM_LOCK},
    {"ArrowUp", GHOSTTY_KEY_ARROW_UP}, {"ArrowDown", GHOSTTY_KEY_ARROW_DOWN}, {"ArrowLeft", GHOSTTY_KEY_ARROW_LEFT}, {"ArrowRight", GHOSTTY_KEY_ARROW_RIGHT},
    {"Enter", GHOSTTY_KEY_ENTER}, {"Escape", GHOSTTY_KEY_ESCAPE}, {"Backspace", GHOSTTY_KEY_BACKSPACE}, {"Tab", GHOSTTY_KEY_TAB}, {"Space", GHOSTTY_KEY_SPACE},
    {"Home", GHOSTTY_KEY_HOME}, {"End", GHOSTTY_KEY_END}, {"PageUp", GHOSTTY_KEY_PAGE_UP}, {"PageDown", GHOSTTY_KEY_PAGE_DOWN},
    {"Insert", GHOSTTY_KEY_INSERT}, {"Delete", GHOSTTY_KEY_DELETE},
    {"Backquote", GHOSTTY_KEY_BACKQUOTE}, {"Backslash", GHOSTTY_KEY_BACKSLASH}, {"BracketLeft", GHOSTTY_KEY_BRACKET_LEFT}, {"BracketRight", GHOSTTY_KEY_BRACKET_RIGHT},
    {"Comma", GHOSTTY_KEY_COMMA}, {"Equal", GHOSTTY_KEY_EQUAL}, {"Minus", GHOSTTY_KEY_MINUS}, {"Period", GHOSTTY_KEY_PERIOD}, {"Quote", GHOSTTY_KEY_QUOTE},
    {"Semicolon", GHOSTTY_KEY_SEMICOLON}, {"Slash", GHOSTTY_KEY_SLASH},
  };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) if (same(name, len, keys[i].name)) return keys[i].key;
  return GHOSTTY_KEY_UNIDENTIFIED;
}

/**
 * A key as the bytes the program expects in the modes it's in: `name` is the key's W3C code
 * (`KeyboardEvent.code`), `text` what it types in the keyboard's layout, `mods` Ghostty's
 * (shift 1, control 2, option 4, command 8), `action` release 0, press 1 or repeat 2. The
 * bytes are at `wt_out`; their count, or -1 for a key that can't be encoded.
 */
EXPORT(wt_key) int32_t wt_key(Terminal *t, const char *name, size_t name_len, const char *text, size_t text_len, uint32_t mods, uint32_t action, uint32_t unshifted) {
  if (action > 2 || mods > 63 || text_len > 1024 * 1024) return -1;
  ghostty_key_encoder_set_from_terminal(t->key_encoder, t->terminal);
  ghostty_key_event_set_action(t->key_event, (GhosttyKeyAction)action);
  ghostty_key_event_set_key(t->key_event, physical_key(name, name_len));
  ghostty_key_event_set_mods(t->key_event, (GhosttyMods)mods);
  ghostty_key_event_set_consumed_mods(t->key_event, 0);
  ghostty_key_event_set_composing(t->key_event, false);
  ghostty_key_event_set_unshifted_codepoint(t->key_event, unshifted);
  GhosttyString typed = {text_len ? (const uint8_t *)text : NULL, text_len}, none = {NULL, 0};
  ghostty_key_event_set_utf8(t->key_event, typed);
  if (!reserve(t, text_len + 256)) return -1;
  size_t written = 0;
  GhosttyResult result = ghostty_key_encoder_encode(t->key_encoder, t->key_event, t->out, t->out_cap, &written);
  if (result == GHOSTTY_OUT_OF_SPACE && written <= 2 * 1024 * 1024 && reserve(t, written))
    result = ghostty_key_encoder_encode(t->key_encoder, t->key_event, t->out, t->out_cap, &written);
  // The event borrows the text only until here.
  ghostty_key_event_set_utf8(t->key_event, none);
  if (result != GHOSTTY_SUCCESS) return -1;
  t->out_len = written;
  return (int32_t)written;
}

/**
 * The mouse at a cell, for a program that asked for it: `button` 0 for none, 1 left, 2 right,
 * 3 middle, 4 and 5 the wheel up and down; `action` press 0, release 1, motion 2. The bytes are
 * at `wt_out`; their count, or -1 when the program isn't listening.
 */
EXPORT(wt_mouse) int32_t wt_mouse(Terminal *t, float x, float y, uint32_t button, uint32_t action, uint32_t mods, uint32_t pressed) {
  bool tracking = false;
  ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &tracking);
  if (!tracking || button > 11 || action > 2) return -1;
  ghostty_mouse_encoder_set_from_terminal(t->mouse_encoder, t->terminal);
  // Encode cell coordinates using integral cell units; font advances can be fractional.
  GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
  size.screen_width = t->columns; size.screen_height = t->rows; size.cell_width = 1; size.cell_height = 1;
  ghostty_mouse_encoder_set(t->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
  bool any = pressed != 0;
  ghostty_mouse_encoder_set(t->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &any);
  ghostty_mouse_event_set_action(t->mouse_event, (GhosttyMouseAction)action);
  if (button) ghostty_mouse_event_set_button(t->mouse_event, (GhosttyMouseButton)button); else ghostty_mouse_event_clear_button(t->mouse_event);
  ghostty_mouse_event_set_mods(t->mouse_event, (GhosttyMods)mods);
  GhosttyMousePosition position = {x < 0 ? 0 : x, y < 0 ? 0 : y};
  ghostty_mouse_event_set_position(t->mouse_event, position);
  if (!reserve(t, 128)) return -1;
  size_t written = 0;
  if (ghostty_mouse_encoder_encode(t->mouse_encoder, t->mouse_event, t->out, t->out_cap, &written) != GHOSTTY_SUCCESS) return -1;
  t->out_len = written;
  return (int32_t)written;
}

/** Pasted text as the program takes it, bracketed if it asked. The bytes are at `wt_out`; their count, or -1. */
EXPORT(wt_paste) int32_t wt_paste(Terminal *t, char *text, size_t len) {
  if (len > 1024 * 1024) return -1;
  GhosttyTerminalModeConfig mode = {GHOSTTY_MODE_BRACKETED_PASTE, false};
  if (ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode) != GHOSTTY_SUCCESS) return -1;
  if (!reserve(t, len + 12)) return -1;
  size_t written = 0;
  if (ghostty_paste_encode(text, len, mode.value, t->out, t->out_cap, &written) != GHOSTTY_SUCCESS) return -1;
  t->out_len = written;
  return (int32_t)written;
}

static bool cell_at(Terminal *t, uint32_t x, uint32_t y, GhosttyGridRef *ref) {
  *ref = (GhosttyGridRef){0};
  GhosttyPoint point = {GHOSTTY_POINT_TAG_VIEWPORT, {{0}}};
  point.value.coordinate.x = (uint16_t)(x >= t->columns ? t->columns - 1 : x);
  point.value.coordinate.y = y >= t->rows ? t->rows - 1u : y;
  return ghostty_terminal_grid_ref(t->terminal, point, ref) == GHOSTTY_SUCCESS;
}

static void select(Terminal *t, const GhosttySelection *selection) {
  ghostty_terminal_set(t->terminal, GHOSTTY_TERMINAL_OPT_SELECTION, selection);
  t->full = true;
}

/**
 * The pointer selecting text: `type` press 0, release 1 or drag 2, at the cell (`x`, `y`) on
 * screen and (`px`, `py`) in pixels, at `ms`. A second press in place selects the word, a third
 * the line. Whether there's a selection now.
 */
EXPORT(wt_select) bool wt_select(Terminal *t, uint32_t type, uint32_t x, uint32_t y, double px, double py, double ms, uint32_t rectangle, uint32_t height) {
  GhosttyGridRef ref;
  if (!cell_at(t, x, y, &ref)) return false;
  GhosttySurfacePosition position = {px, py};
  GhosttySelection selection = {0};
  GhosttyResult result = GHOSTTY_NO_VALUE;
  if (type == 0) {
    // A press within half a second and a cell of the last counts on from it.
    uint64_t ns = (uint64_t)(ms * 1000000.0), interval = 500000000;
    double distance = t->cell_width;
    ghostty_selection_gesture_event_set(t->press, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_INTERVAL_NS, &interval);
    ghostty_selection_gesture_event_set(t->press, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_DISTANCE, &distance);
    ghostty_selection_gesture_event_set(t->press, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &ref);
    ghostty_selection_gesture_event_set(t->press, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, &position);
    ghostty_selection_gesture_event_set(t->press, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS, &ns);
    result = ghostty_selection_gesture_event(t->gesture, t->terminal, t->press, &selection);
    // A lone press starts over: what was selected goes.
    select(t, result == GHOSTTY_SUCCESS ? &selection : NULL);
    return result == GHOSTTY_SUCCESS;
  }
  if (type == 1) {
    ghostty_selection_gesture_event_set(t->release, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &ref);
    ghostty_selection_gesture_event(t->gesture, t->terminal, t->release, NULL);
  } else {
    GhosttySelectionGestureGeometry geometry = {t->columns, t->cell_width, 0, height ? height : t->rows * t->cell_height};
    bool block = rectangle != 0;
    ghostty_selection_gesture_event_set(t->drag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF, &ref);
    ghostty_selection_gesture_event_set(t->drag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION, &position);
    ghostty_selection_gesture_event_set(t->drag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY, &geometry);
    ghostty_selection_gesture_event_set(t->drag, GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE, &block);
    result = ghostty_selection_gesture_event(t->gesture, t->terminal, t->drag, &selection);
    if (result == GHOSTTY_SUCCESS) select(t, &selection);
  }
  GhosttySelection current = {0};
  return ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_SELECTION, &current) == GHOSTTY_SUCCESS;
}

EXPORT(wt_select_clear) void wt_select_clear(Terminal *t) {
  ghostty_selection_gesture_reset(t->gesture, t->terminal);
  select(t, NULL);
}

/** The selected text, as copying takes it: wrapped lines joined, trailing spaces gone. At `wt_out`; its bytes, or -1 with nothing selected. */
EXPORT(wt_selection) int32_t wt_selection(Terminal *t) {
  GhosttySelection selection = {0};
  if (ghostty_terminal_get(t->terminal, GHOSTTY_TERMINAL_DATA_SELECTION, &selection) != GHOSTTY_SUCCESS) return -1;
  GhosttyFormatter formatter = NULL;
  if (ghostty_formatter_terminal_new(NULL, &formatter, t->terminal) != GHOSTTY_SUCCESS) return -1;
  // A new formatter writes plain text and trims it.
  bool unwrap = true;
  uint8_t *bytes = NULL; size_t len = 0;
  bool formatted = ghostty_formatter_set(formatter, GHOSTTY_FORMATTER_OPT_UNWRAP, &unwrap) == GHOSTTY_SUCCESS
    && ghostty_formatter_set(formatter, GHOSTTY_FORMATTER_OPT_SELECTION, &selection) == GHOSTTY_SUCCESS
    && ghostty_formatter_format_alloc(formatter, NULL, &bytes, &len) == GHOSTTY_SUCCESS;
  ghostty_formatter_free(formatter);
  if (!formatted) return -1;
  bool fits = reserve(t, len);
  if (fits) { for (size_t i = 0; i < len; i++) t->out[i] = bytes[i]; t->out_len = len; }
  ghostty_free(NULL, bytes, len);
  return fits ? (int32_t)len : -1;
}

/** The address a cell links to (OSC 8), at `wt_out`; its bytes, 0 for a cell that links nowhere. */
EXPORT(wt_link) int32_t wt_link(Terminal *t, uint32_t x, uint32_t y) {
  GhosttyGridRef ref;
  if (!cell_at(t, x, y, &ref)) return 0;
  size_t len = 0;
  GhosttyResult result = ghostty_grid_ref_hyperlink_uri(&ref, NULL, 0, &len);
  if (result != GHOSTTY_OUT_OF_SPACE || !len || len > 65536 || !reserve(t, len)) return 0;
  if (ghostty_grid_ref_hyperlink_uri(&ref, t->out, t->out_cap, &len) != GHOSTTY_SUCCESS) return 0;
  t->out_len = len;
  return (int32_t)len;
}

/** The screen as the holder's snapshot of it would be: for the tests. */
EXPORT(wt_snapshot) int32_t wt_snapshot(Terminal *t) {
  uint8_t *bytes = NULL; size_t len = 0;
  if (ghostty_snapshot_encode_alloc(t->terminal, NULL, &bytes, &len) != GHOSTTY_SUCCESS) return -1;
  bool fits = reserve(t, len);
  if (fits) { for (size_t i = 0; i < len; i++) t->out[i] = bytes[i]; t->out_len = len; }
  ghostty_free(NULL, bytes, len);
  return fits ? (int32_t)len : -1;
}

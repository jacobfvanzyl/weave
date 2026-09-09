#include <ghostty/vt.h>
#include <stdio.h>
#include <string.h>

// This probe tests the native library contract, not a platform renderer.
int weave_ghostty_probe(void) {
  GhosttyTerminal terminal = NULL;
  GhosttyRenderState frame = NULL;
  GhosttyFormatter formatter = NULL;
  int failed = 1;
  if (ghostty_terminal_new(NULL, &terminal, 40, 8) != GHOSTTY_SUCCESS) goto done;
  const char *text = "Weave \033[32mGhostty\033[0m — 界\r\n";
  // Deliberately split both escape sequences and UTF-8 codepoints.
  for (size_t i = 0; i < strlen(text); i++) {
    ghostty_terminal_vt_write(terminal, (const uint8_t *)text + i, 1);
  }
  GhosttyFormatterTerminalOptions options = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.trim = true;
  if (ghostty_formatter_terminal_new(NULL, &formatter, terminal, options) != GHOSTTY_SUCCESS) goto done;
  uint8_t output[4096];
  size_t written = 0;
  if (ghostty_formatter_format_buf(formatter, output, sizeof(output) - 1, &written) != GHOSTTY_SUCCESS) goto done;
  output[written] = 0;
  if (strstr((const char *)output, "Weave Ghostty — 界") == NULL) goto done;
  const char *alternate = "\033[?1049h\033[HALTERNATE\033[?1049l";
  ghostty_terminal_vt_write(terminal, (const uint8_t *)alternate, strlen(alternate));
  if (ghostty_formatter_format_buf(formatter, output, sizeof(output) - 1, &written) != GHOSTTY_SUCCESS) goto done;
  output[written] = 0;
  if (strstr((const char *)output, "Weave Ghostty") == NULL || strstr((const char *)output, "ALTERNATE") != NULL) goto done;
  if (ghostty_terminal_resize(terminal, 60, 12, 9, 18) != GHOSTTY_SUCCESS) goto done;
  if (ghostty_render_state_new(NULL, &frame) != GHOSTTY_SUCCESS) goto done;
  if (ghostty_render_state_update(frame, terminal) != GHOSTTY_SUCCESS) goto done;
  uint16_t cols = 0, rows = 0;
  if (ghostty_render_state_get(frame, GHOSTTY_RENDER_STATE_DATA_COLS, &cols) != GHOSTTY_SUCCESS) goto done;
  if (ghostty_render_state_get(frame, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows) != GHOSTTY_SUCCESS) goto done;
  if (cols != 60 || rows != 12) goto done;
  failed = 0;
done:
  if (formatter) ghostty_formatter_free(formatter);
  if (frame) ghostty_render_state_free(frame);
  if (terminal) ghostty_terminal_free(terminal);
  return failed;
}

#ifdef WEAVE_PROBE_MAIN
int main(void) {
  if (weave_ghostty_probe()) return 1;
  puts("{\"passed\":true,\"fragmentedUtf8\":true,\"alternateScreen\":true,\"renderStateResize\":true}");
  return 0;
}
#endif

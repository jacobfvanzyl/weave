-- nvim_open, for weave's Host (WVE-233): show the file at the absolute path `path`, and the
-- place at `line` and the character `column`, both counted from 1, when given. Its arguments
-- come as arguments, never as a command line.
--
-- Only from Normal mode: in any other the person is typing, selecting or in the middle of a
-- command, and nothing is opened. A window in this tab page that shows the file already is
-- the one used. Otherwise the file goes into the current window, as `:edit` would; when that
-- window's buffer can't be let go of, as a modified one with 'hidden' off, a split of its own
-- takes the file, so no change is ever thrown away. The jumplist keeps where the person was.
local path, line, column = ...
if line == vim.NIL then
  line = nil
end
if column == vim.NIL then
  column = nil
end

local mode = vim.api.nvim_get_mode()
if mode.blocking or (mode.mode ~= 'n' and mode.mode ~= 'nt') then
  return { refused = mode.mode }
end

local function mark()
  vim.cmd.normal({ args = { "m'" }, bang = true })
end

local buf = vim.fn.bufadd(path)
local split = false
if vim.api.nvim_get_current_buf() == buf then
  mark()
else
  local shown
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(win) == buf then
      shown = win
      break
    end
  end
  if shown then
    vim.api.nvim_set_current_win(shown)
    mark()
  else
    mark()
    local opened, why = pcall(vim.api.nvim_win_set_buf, 0, buf)
    if not opened and vim.api.nvim_get_current_buf() ~= buf then
      -- E37, or a window that keeps its buffer ('winfixbuf'): a split, leaving this one as it is.
      vim.cmd.split()
      split = true
      opened, why = pcall(vim.api.nvim_win_set_buf, 0, buf)
      if not opened and vim.api.nvim_get_current_buf() ~= buf then
        vim.cmd.close()
        error(why, 0)
      end
    end
    vim.bo[buf].buflisted = true
  end
end

if line then
  vim.fn.setcursorcharpos(line, column or 1)
  vim.cmd.normal({ args = { 'zv' }, bang = true })
  vim.cmd.normal({ args = { 'zz' }, bang = true })
end

local at = vim.fn.getcharpos('.')
return { path = vim.api.nvim_buf_get_name(0), line = at[2], column = at[3], split = split }

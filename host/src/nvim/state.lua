-- nvim_state, for weave's Host (WVE-233): the current buffer, the cursor, the mode, and the
-- selection while Visual or Select mode is on. Lines and columns count from 1, columns in
-- characters.
--
-- The selection is read live, from `getpos('v')` and the cursor, with `getregion()` (Neovim
-- 0.10): the '< and '> marks move only once Visual mode ends, so outside it there's no
-- selection to report, whatever they say.
local mode = vim.api.nvim_get_mode().mode
local buf = vim.api.nvim_get_current_buf()
local name = vim.api.nvim_buf_get_name(buf)
local cursor = vim.fn.getcharpos('.')
local state = {
  path = name ~= '' and name or nil,
  buftype = vim.bo[buf].buftype,
  filetype = vim.bo[buf].filetype,
  modified = vim.bo[buf].modified,
  mode = mode,
  cursor = { line = cursor[2], column = cursor[3] },
}

local kinds = { v = 'char', V = 'line', ['\22'] = 'block', s = 'char', S = 'line', ['\19'] = 'block' }
local kind = kinds[mode]
if kind then
  local types = { char = 'v', line = 'V', block = '\22' }
  local text = vim.fn.getregion(vim.fn.getpos('v'), vim.fn.getpos('.'), { type = types[kind] })
  local from, to = vim.fn.getcharpos('v'), vim.fn.getcharpos('.')
  local first, last = from, to
  if from[2] > to[2] or (from[2] == to[2] and from[3] > to[3]) then
    first, last = to, from
  end
  local selection = { kind = kind, start = { line = first[2] }, ['end'] = { line = last[2] }, text = text }
  if kind == 'char' then
    selection.start.column = first[3]
    selection['end'].column = last[3]
  elseif kind == 'block' then
    selection.start.column = math.min(from[3], to[3])
    selection['end'].column = math.max(from[3], to[3])
  end
  state.selection = selection
end
return state

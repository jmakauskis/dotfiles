-- Diffview for advanced git diffs
return {
  'sindrets/diffview.nvim',
  dependencies = {
    'nvim-lua/plenary.nvim',
  },
  cmd = { 'DiffviewOpen', 'DiffviewClose', 'DiffviewToggleFiles', 'DiffviewFocusFiles', 'DiffviewFileHistory' },
  keys = {
    { '<leader>gd', '<cmd>DiffviewOpen<cr>', desc = '[G]it [D]iffview open' },
    { '<leader>gc', '<cmd>DiffviewClose<cr>', desc = '[G]it diffview [C]lose' },
    { '<leader>gh', '<cmd>DiffviewFileHistory %<cr>', desc = '[G]it file [H]istory' },
    { '<leader>gH', '<cmd>DiffviewFileHistory<cr>', desc = '[G]it branch [H]istory' },
  },
  config = function()
    require('diffview').setup {
      enhanced_diff_hl = true, -- Better syntax highlighting in diffs
      view = {
        default = {
          layout = 'diff2_horizontal', -- Side-by-side view
        },
        merge_tool = {
          layout = 'diff3_horizontal',
        },
      },
    }

    -- Register which-key group
    local wk_ok, wk = pcall(require, 'which-key')
    if wk_ok then
      wk.add({
        { '<leader>g', group = '[G]it' },
      })
    end
  end,
}

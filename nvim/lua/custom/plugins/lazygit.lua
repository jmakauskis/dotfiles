return {
  'kdheepak/lazygit.nvim',
  dependencies = {
    'nvim-lua/plenary.nvim',
  },
  cmd = { 'LazyGit', 'LazyGitConfig', 'LazyGitCurrentFile', 'LazyGitFilter', 'LazyGitFilterCurrentFile' },
  keys = {
    { '<leader>gg', '<cmd>LazyGit<cr>', desc = '[G]it [G]ui (lazygit)' },
    { '<leader>gf', '<cmd>LazyGitFilterCurrentFile<cr>', desc = '[G]it current [F]ile' },
  },
}

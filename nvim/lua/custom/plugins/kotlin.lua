-- Kotlin language support via AlexandrosAlexiou/kotlin.nvim
-- kotlin.nvim manages the full LSP lifecycle instead.
return {
  {
    'nvim-treesitter/nvim-treesitter',
    opts = function(_, opts)
      if type(opts.ensure_installed) == 'table' then
        vim.list_extend(opts.ensure_installed, { 'kotlin' })
      end
    end,
  },

  {
    'AlexandrosAlexiou/kotlin.nvim',
    event = 'VimEnter',
    config = function()
      local opts = {
        root_markers = { 'gradlew', 'settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'mvnw', '.git' },
        jvm_args = { '-Xmx4g', '-XX:+UseG1GC', '-XX:SoftRefLRUPolicyMSPerMB=50' },
        inlay_hints = {
          enabled = true,
          parameters = true,
          types_variable = true,
          function_return = true,
        },
      }
      require('kotlin').setup(opts)

      vim.schedule(function()
        if vim.bo.filetype == 'kotlin' and #vim.lsp.get_clients({ name = 'kotlin_lsp', bufnr = 0 }) == 0 then
          require('kotlin').setup_kotlin_lsp(opts)
        end
      end)
    end,
  },
}

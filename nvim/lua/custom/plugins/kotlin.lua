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
        root_markers = { 'gradlew', 'settings.gradle.kts', 'settings.gradle', 'mvnw' },
        jvm_args = { '-Xmx4g', '-XX:+UseG1GC', '-XX:SoftRefLRUPolicyMSPerMB=50' },
        inlay_hints = {
          enabled = true,
          parameters = true,
          types_variable = true,
          function_return = true,
        },
      }
      require('kotlin').setup(opts)

      -- Start the LSP immediately if nvim was opened from a Kotlin project root,
      -- without waiting for a Kotlin file to be opened first.
      -- Opens the first .kt file found in a hidden buffer to trigger LSP attach.
      local root_markers = opts.root_markers
      local cwd = vim.fn.getcwd()
      for _, marker in ipairs(root_markers) do
        if vim.fn.filereadable(cwd .. '/' .. marker) == 1 or vim.fn.isdirectory(cwd .. '/' .. marker) == 1 then
          vim.defer_fn(function()
            local kt_file = vim.fn.glob(cwd .. '/**/*.kt', false, true)[1]
            if kt_file then
              local buf = vim.fn.bufadd(kt_file)
              vim.fn.bufload(buf)
              vim.bo[buf].buflisted = false
            end
          end, 100)
          break
        end
      end
    end,
  },
}

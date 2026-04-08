-- Auto-close brackets, quotes, etc.
return {
  'windwp/nvim-autopairs',
  event = 'InsertEnter',
  opts = {
    check_ts = true, -- Enable treesitter integration
    ts_config = {
      lua = { 'string' }, -- Don't add pairs in lua string treesitter nodes
      javascript = { 'template_string' },
      kotlin = { 'string' }, -- Don't add pairs in kotlin strings
    },
    disable_filetype = { 'TelescopePrompt' }, -- Don't use in Telescope
    fast_wrap = {
      map = '<M-e>', -- Alt+e to fast wrap
      chars = { '{', '[', '(', '"', "'" },
      pattern = [=[[%'%"%>%]%)%}%,]]=],
      end_key = '$',
      keys = 'qwertyuiopzxcvbnmasdfghjkl',
      check_comma = true,
      highlight = 'Search',
      highlight_grey = 'Comment',
    },
  },
}

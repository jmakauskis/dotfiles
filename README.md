# dotfiles

My personal dotfiles managed with a bare git repo.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jmakauskis/dotfiles/main/install.sh | bash
```

## What's included

- **zsh** — `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin`, `.p10k.zsh`
- **tmux** — `.tmux.conf`
- **nvim** — `~/.config/nvim`
- **ghostty** — `~/.config/ghostty`
- **aerospace** — `~/.config/aerospace`
- **sketchybar** — `~/.config/sketchybar`
- **fish** — `~/.config/fish`
- **git** — `~/.config/git/ignore`
- **karabiner** — `~/.config/karabiner`
- **iterm2** — `~/.config/iterm2`
- **opencode** — `~/.config/opencode`

## Managing dotfiles

```bash
# Alias set in .zshrc
alias config='/usr/bin/git --git-dir=$HOME/.cfg/ --work-tree=$HOME'

config status
config add ~/.config/ghostty/config
config commit -m "update ghostty"
config push
```

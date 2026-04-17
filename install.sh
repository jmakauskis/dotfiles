#!/usr/bin/env bash
set -e

REPO="https://github.com/jmakauskis/dotfiles.git"
BARE="$HOME/.cfg"

if [ -d "$BARE" ]; then
  echo "~/.cfg already exists, skipping clone"
else
  git clone --bare "$REPO" "$BARE"
fi

config() {
  /usr/bin/git --git-dir="$BARE" --work-tree="$HOME" "$@"
}

config config status.showUntrackedFiles no

echo "Backing up pre-existing dotfiles to ~/.dotfiles-backup..."
mkdir -p "$HOME/.dotfiles-backup"

config checkout 2>&1 | grep -E "^\s+\." | awk '{print $1}' | while read -r file; do
  mkdir -p "$HOME/.dotfiles-backup/$(dirname "$file")"
  mv "$HOME/$file" "$HOME/.dotfiles-backup/$file"
done

config checkout

echo "Done! Dotfiles installed."

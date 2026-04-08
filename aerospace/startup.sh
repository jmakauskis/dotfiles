#!/bin/bash
# Run once at login to place apps into their default workspaces.
# After startup, windows can be moved freely.

sleep 3  # Give apps time to launch

move_app_to_workspace() {
  local app_id="$1"
  local workspace="$2"
  aerospace list-windows --all | grep "$app_id" | awk '{print $1}' | while read -r win_id; do
    aerospace move-node-to-workspace --window-id "$win_id" "$workspace"
  done
}

open -a "Google Chrome"
open -a "Slack"
open -a "Ghostty"
open -a "IntelliJ IDEA"

sleep 5  # Wait for windows to appear

move_app_to_workspace "com.google.Chrome" 1
move_app_to_workspace "com.tinyspeck.slackmacgap" 2
move_app_to_workspace "com.mitchellh.ghostty" 3
move_app_to_workspace "com.jetbrains.intellij" 5

aerospace workspace 1

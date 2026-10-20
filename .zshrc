# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

[ -z "$SSH_AUTH_SOCK" ] && eval "$(ssh-agent -s)"

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

ZSH_THEME="powerlevel10k/powerlevel10k"

# Load nvm only when a Node command is first used, not on shell startup.
export NVM_DIR="$HOME/.nvm"
zstyle ':omz:plugins:nvm' lazy yes
zstyle ':omz:plugins:nvm' lazy-cmd pi hunk

# Which plugins would you like to load?
plugins=(
	nvm
	git
	zsh-autosuggestions
	you-should-use
	zsh-syntax-highlighting
	kubectl
	z
)

source $ZSH/oh-my-zsh.sh

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# pnpm
export PNPM_HOME="/Users/jmakauskis/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# bun completions
[ -s "/Users/jmakauskis/.bun/_bun" ] && source "/Users/jmakauskis/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

export AWS_PROFILE="ClaudeCode"

alias claude_update='gh api "repos/flexport/claude_code/contents/claude_code_setup.ts" -H "Accept: application/vnd.github.v3.raw" | bun -'
alias claude="CLAUDE_CODE_EXTRA_BODY='{\"thinking\": {\"type\": \"adaptive\"}}' CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions"

alias mux="~/.config/cmux/mux.ts"

export ROBODOC_HOME="$HOME/robodoc"

# Snowflake CLI
export PATH=/Applications/SnowflakeCLI.app/Contents/MacOS/:$PATH

# LM Studio CLI
export PATH="$PATH:$HOME/.lmstudio/bin"

# opencode
export PATH=$HOME/.opencode/bin:$PATH

#THIS MUST BE AT THE END OF THE FILE FOR SDKMAN TO WORK!!!
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"


export GITHUB_USERNAME=jmakauskis


# Add RVM to PATH for scripting. Make sure this is the last PATH variable change.
export PATH="$PATH:$HOME/.rvm/bin"
alias mpr="/Users/jmakauskis/flexport/mpr"

alias codex_update='gh api "repos/flexport/claude_code/contents/claude_code_setup.ts" -H "Accept: application/vnd.github.v3.raw" | bun -'

# >>> fp ai claude managed (do not edit this block) >>>
export AWS_REGION="us-east-1"
export CLAUDE_CODE_USE_BEDROCK="1"
export NODE_EXTRA_CA_CERTS="$HOME/.claude/flexport_root_ca_g1.pem"
export PATH="$HOME/.local/bin:$PATH"
alias claude_update='fp ai claude update'
# <<< fp ai claude managed <<<

# >>> fp ai codex managed (do not edit this block) >>>
export PATH="$HOME/.bun/bin:$PATH"
alias codex_update='fp ai codex update'
# <<< fp ai codex managed <<<

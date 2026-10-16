#!/usr/bin/env bash
# uninstall.sh — remove an installed opencode stack, safely.
#
#   ./uninstall.sh            back up then remove the config dir
#   ./uninstall.sh --purge    also remove ~/.agents/skills
#   ./uninstall.sh --dry-run  show what would happen
set -euo pipefail

JB_HOME="${JB_HOME:-$HOME/.config/opencode}"
PURGE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --purge)   PURGE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done

BOLD=$(printf '\033[1m'); RST=$(printf '\033[0m')
run() { if [ "$DRY" = "1" ]; then printf '  would: %s\n' "$*"; else eval "$@"; fi; }

printf '\n%sopencode stack uninstall%s\n\n' "$BOLD" "$RST"
[ "$DRY" = "1" ] && printf '  (dry run — nothing will change)\n\n'

if [ -d "$JB_HOME" ]; then
  BK="$JB_HOME.uninstalled.$(date +%Y%m%d%H%M%S)"
  run "cp -R \"$JB_HOME\" \"$BK\""
  printf '  backed up to %s\n' "$BK"
  run "rm -rf \"$JB_HOME\""
  printf '  removed %s\n' "$JB_HOME"
else
  printf '  nothing at %s\n' "$JB_HOME"
fi

if [ "$PURGE" = "1" ]; then
  if [ -d "$HOME/.agents/skills" ]; then
    run "rm -rf \"$HOME/.agents/skills\""
    printf '  removed %s\n' "$HOME/.agents/skills"
  fi
else
  printf '  kept %s (use --purge to remove)\n' "$HOME/.agents/skills"
fi

printf '\n  note: the opencode CLI itself was not removed.\n'
printf '        remove it with:  npm uninstall -g opencode-ai\n\n'

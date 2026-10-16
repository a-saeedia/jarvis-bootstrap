#!/usr/bin/env bash
# doctor.sh — report on the health of an installed opencode stack.
set -uo pipefail

JB_HOME="${JB_HOME:-$HOME/.config/opencode}"
PASS=0; FAIL=0; WARN=0

GRN=''; RED=''; YEL=''; CYN=''; BOLD=''; RST=''
if [ -t 1 ]; then
  GRN=$(printf '\033[32m'); RED=$(printf '\033[31m'); YEL=$(printf '\033[33m')
  CYN=$(printf '\033[36m'); BOLD=$(printf '\033[1m'); RST=$(printf '\033[0m')
fi

ok()   { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$*"; }
warn() { WARN=$((WARN+1)); printf '  %s!%s %s\n' "$YEL" "$RST" "$*"; }
hdr()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$RST"; }
have() { command -v "$1" >/dev/null 2>&1; }

hdr "Environment"
have node && ok "node $(node -v)" || bad "node missing (need >= 20)"
if have node; then
  MAJ="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$MAJ" -ge 20 ] 2>/dev/null && ok "node major >= 20" || bad "node $MAJ is too old"
fi
have git  && ok "git $(git --version 2>/dev/null | awk '{print $3}')" || warn "git missing"
have curl && ok "curl present" || bad "curl missing"
have opencode && ok "opencode $(opencode --version 2>/dev/null || echo present)" || bad "opencode CLI not on PATH"

hdr "Layout ($JB_HOME)"
[ -d "$JB_HOME" ]             && ok "config dir exists" || bad "config dir missing — run install.sh"
[ -f "$JB_HOME/opencode.jsonc" ] && ok "opencode.jsonc present" || bad "opencode.jsonc missing"
[ -f "$JB_HOME/AGENTS.md" ]   && ok "AGENTS.md present"   || warn "AGENTS.md missing"
[ -d "$JB_HOME/vault" ]       && ok "vault present"       || warn "vault missing"
[ -d "$JB_HOME/plugin" ]      && ok "plugin dir present"  || warn "plugin dir missing"

A="$(find "$JB_HOME/agent" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
[ "$A" -ge 15 ] && ok "$A agents" || warn "$A agents (expected ~17)"
S="$(find "$JB_HOME/skill" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"
G="$(find "$HOME/.agents/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"
[ "$S" -ge 40 ] && ok "$S skills in config dir" || warn "$S skills in config dir (expected ~51)"
[ "$G" -ge 40 ] && ok "$G skills in ~/.agents/skills" || warn "$G skills in ~/.agents/skills"

hdr "Config validity"
if [ -f "$JB_HOME/opencode.jsonc" ]; then
  if node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");process.exit(/\{\{[A-Z]+\}\}/.test(s)?1:0)' "$JB_HOME/opencode.jsonc" 2>/dev/null; then
    ok "no unresolved placeholders"
  else
    bad "config still contains {{PLACEHOLDERS}} — re-run install.sh"
  fi
  REPO_ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
  if [ -f "$REPO_ROOT/scripts/validate-jsonc.mjs" ]; then
    node "$REPO_ROOT/scripts/validate-jsonc.mjs" "$JB_HOME/opencode.jsonc" >/dev/null 2>&1 \
      && ok "config parses as JSON" || bad "config does not parse"
  else
    warn "validate-jsonc.mjs not found — skipping parse check"
  fi
fi

hdr "MCP dependencies"
[ -d "$JB_HOME/node_modules" ] && ok "node_modules present" || bad "node_modules missing — re-run install.sh"
for p in "@upstash/context7-mcp" "@modelcontextprotocol/server-sequential-thinking" \
         "@modelcontextprotocol/server-memory" "@modelcontextprotocol/server-filesystem" \
         "@playwright/mcp" "mcp-server-sqlite-npx"; do
  [ -d "$JB_HOME/node_modules/$p" ] && ok "$p" || warn "$p not installed"
done
GHD="$JB_HOME/tools/github/github-mcp-server"
if [ -x "$GHD" ]; then ok "github-mcp-server binary present"
elif [ -f "$GHD" ]; then warn "github-mcp-server present but not executable (chmod +x)"
else warn "github-mcp-server binary missing (JB_MINIMAL install?)"; fi

hdr "Environment variables"
for v in OPENROUTER_API_KEY GEMINI_API_KEY GROQ_API_KEY NVIDIA_API_KEY \
         PERPLEXITY_API_KEY MAGIC_HOUR_API_KEY POLLINATIONS_API_KEY \
         LITELLM_MASTER_KEY GITHUB_MODELS_TOKEN; do
  if [ -n "$(eval "printf '%s' \"\${$v:-}\"")" ]; then ok "$v is set"
  elif grep -q "^$v=." "$JB_HOME/.env" 2>/dev/null; then ok "$v set in .env"
  else warn "$v not set"; fi
done
if [ -f "$JB_HOME/.env" ]; then
  PERM="$(ls -l "$JB_HOME/.env" | awk '{print $1}')"
  case "$PERM" in *rw-------*) ok ".env mode 600" ;; *) warn ".env is $PERM (should be 600)" ;; esac
fi

hdr "MCP servers (start test)"
if have node && [ -d "$JB_HOME/node_modules" ]; then
  test_server() {
    local name="$1" entry="$2"
    [ -f "$entry" ] || { warn "$name — entry not found"; return; }
    if printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"doctor","version":"1"}}}\n' \
      | timeout 12 node "$entry" >/dev/null 2>&1; then
      ok "$name responds to initialize"
    else
      warn "$name did not respond within 12s (normal for some servers)"
    fi
  }
  NM="$JB_HOME/node_modules"
  test_server "context7"            "$NM/@upstash/context7-mcp/dist/index.js"
  test_server "memory"              "$NM/@modelcontextprotocol/server-memory/dist/index.js"
  test_server "sequential-thinking" "$NM/@modelcontextprotocol/server-sequential-thinking/dist/index.js"
else
  warn "skipping — node_modules absent"
fi

hdr "Summary"
printf '  %s%d passed%s   %s%d warnings%s   %s%d failed%s\n' \
  "$GRN" "$PASS" "$RST" "$YEL" "$WARN" "$RST" "$RED" "$FAIL" "$RST"
[ "$FAIL" -eq 0 ] && printf '\n  %sStack looks healthy.%s\n\n' "$GRN" "$RST" \
                  || printf '\n  %sFix the failures above, then re-run install.sh.%s\n\n' "$RED" "$RST"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)

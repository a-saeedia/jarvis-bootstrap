#!/usr/bin/env bash
#
# jarvis-bootstrap — install the full opencode stack on a fresh macOS / Linux box.
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | bash
#
# Idempotent. Re-runnable. Secrets are never written by this script; it only
# scaffolds an env file and prints which keys to add.
#
# Environment overrides:
#   JB_REPO     owner/repo           (default: see JB_DEFAULT_REPO below)
#   JB_REF      branch or tag        (default: main)
#   JB_TOKEN    GitHub token         (required for a private repo)
#   JB_HOME     config dir           (default: ~/.config/opencode)
#   JB_MINIMAL  1 = skip optional deps (playwright browsers, github mcp binary)
#   JB_NO_BREW  1 = never attempt a Homebrew install
#   JB_SKIP_CLI 1 = do not install/require the opencode CLI (payload only)
#   JB_FORCE_OS linux|darwin = override uname -s (used by CI smoke tests)
#
set -euo pipefail

JB_DEFAULT_REPO="${JB_DEFAULT_REPO:-a-saeedia/jarvis-bootstrap}"
JB_REPO="${JB_REPO:-$JB_DEFAULT_REPO}"
JB_REF="${JB_REF:-main}"
JB_HOME="${JB_HOME:-$HOME/.config/opencode}"
JB_MINIMAL="${JB_MINIMAL:-0}"
JB_NO_BREW="${JB_NO_BREW:-0}"
JB_SKIP_CLI="${JB_SKIP_CLI:-0}"
JB_FORCE_OS="${JB_FORCE_OS:-}"

BOLD=''; DIM=''; RED=''; GRN=''; YEL=''; CYN=''; RST=''
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); CYN=$(printf '\033[36m'); RST=$(printf '\033[0m')
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$CYN" "$RST" "$BOLD" "$*" "$RST"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- preflight ---
step "Preflight"

OS="${JB_FORCE_OS:-$(uname -s)}"
ARCH="$(uname -m)"
case "$OS" in
  Darwin|darwin|DARWIN)           PLATFORM="darwin" ;;
  Linux|linux|LINUX|GNU/Linux)    PLATFORM="linux"  ;;
  *) die "unsupported OS: $OS (this installer targets macOS and Linux)" ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCHN="arm64" ;;
  x86_64|amd64)  ARCHN="x64"   ;;
  *) ARCHN="$ARCH" ;;
esac
PLATFORM_KEY="$PLATFORM-$ARCHN"
ok "$OS $ARCH ($PLATFORM_KEY)"

# Script dir: present when run from a checkout, empty when piped through bash.
SCRIPT_DIR=""
case "${BASH_SOURCE[0]:-}" in
  ""|bash|-|/dev/stdin|/dev/fd/*) SCRIPT_DIR="" ;;
  *) if [ -f "${BASH_SOURCE[0]}" ]; then SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi ;;
esac
if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/payload" ]; then
  MODE="local"
  ok "payload source: local checkout ($SCRIPT_DIR)"
else
  MODE="remote"
  ok "payload source: $JB_REPO@$JB_REF"
fi

if [ "$PLATFORM" = "darwin" ] && [ -z "$JB_FORCE_OS" ] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode command line tools missing — git/brew need them."
  say  "    run:  xcode-select --install    then re-run this script."
  exit 1
fi

# Homebrew: only to satisfy missing deps, and only when allowed.
ensure_brew() {
  have brew && return 0
  [ "$JB_NO_BREW" = "1" ] && { warn "Homebrew missing (JB_NO_BREW=1) — will try without it"; return 1; }
  [ "$PLATFORM" = "darwin" ] || return 1
  warn "Homebrew not found — installing (this is how node/git get in cleanly)"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew install failed; install it manually and re-run"
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$p" ] && eval "$("$p" shellenv)" && break
  done
  have brew
}

for tool in git curl; do
  if have "$tool"; then ok "$tool $(command -v "$tool")"; else
    if ensure_brew; then brew install "$tool" >/dev/null 2>&1 || die "failed to install $tool"; ok "$tool installed"; else die "$tool is required"; fi
  fi
done

# Node >= 20
NODE_OK=0
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null && NODE_OK=1
fi
if [ "$NODE_OK" != "1" ]; then
  if ensure_brew; then
    warn "installing node (>=20)"
    brew install node >/dev/null 2>&1 || die "failed to install node"
  else
    die "node >= 20 is required (install from https://nodejs.org or via brew)"
  fi
fi
NODE_BIN="$(command -v node)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node >= 20 required (found $(node -v))"
ok "node $(node -v) at $NODE_BIN"

# opencode CLI
step "opencode CLI"
if [ "$JB_SKIP_CLI" = "1" ]; then
  warn "skipped (JB_SKIP_CLI=1) — payload only"
elif have opencode; then
  ok "already installed: $(opencode --version 2>/dev/null || echo present)"
else
  say "  installing via opencode.ai installer…"
  if curl -fsSL https://opencode.ai/install | bash; then
    for d in "$HOME/.opencode/bin" "$HOME/.local/bin" "/usr/local/bin"; do
      case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$d:$PATH" ;; esac
    done
    have opencode && ok "installed: $(opencode --version 2>/dev/null || echo ok)" || warn "installed but not on PATH yet — restart your shell"
  elif have npm; then
    warn "installer path failed, falling back to npm"
    npm install -g opencode-ai >/dev/null 2>&1 && ok "installed via npm" || die "could not install opencode"
  else
    die "could not install opencode CLI"
  fi
fi

# ---------------------------------------------------------------- payload ----
step "Fetching payload"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
SRC="$STAGE/src"

if [ "$MODE" = "local" ]; then
  mkdir -p "$SRC"
  cp -R "$SCRIPT_DIR/payload/." "$SRC/"
  cp "$SCRIPT_DIR/manifest.json" "$SRC/manifest.json" 2>/dev/null || true
  ok "copied local payload"
else
  AUTH_HDR=""
  [ -n "${JB_TOKEN:-}" ] && AUTH_HDR="Authorization: Bearer $JB_TOKEN"
  URL="https://codeload.github.com/$JB_REPO/tar.gz/refs/heads/$JB_REF"
  say "  downloading $URL"
  if [ -n "$AUTH_HDR" ]; then
    curl -fsSL -H "$AUTH_HDR" "$URL" -o "$STAGE/src.tgz" || die "download failed (check JB_TOKEN / JB_REPO)"
  else
    curl -fsSL "$URL" -o "$STAGE/src.tgz" || die "download failed (private repo? set JB_TOKEN, or use JB_REPO with a public repo)"
  fi
  mkdir -p "$SRC"
  tar -xzf "$STAGE/src.tgz" -C "$SRC" --strip-components=1
  [ -d "$SRC/payload" ] || die "payload missing from archive"
  ok "downloaded and extracted"
fi

# ---------------------------------------------------------------- install ----
step "Installing into $JB_HOME"

if [ -d "$JB_HOME" ]; then
  BK="$JB_HOME.bak.$(date +%Y%m%d%H%M%S)"
  cp -R "$JB_HOME" "$BK" 2>/dev/null || true
  ok "existing config backed up to $(basename "$BK")"
fi
mkdir -p "$JB_HOME"

# code assets
mkdir -p "$JB_HOME/agent" "$JB_HOME/skill" "$JB_HOME/plugin" "$JB_HOME/tools" "$JB_HOME/config"
cp -R "$SRC/agents/."   "$JB_HOME/agent/"   2>/dev/null || true
cp -R "$SRC/plugin/."   "$JB_HOME/plugin/"  2>/dev/null || true
cp -R "$SRC/soul/."     "$JB_HOME/soul/"    2>/dev/null || true
rm -f "$JB_HOME/plugin"/*.bak 2>/dev/null || true
[ -f "$SRC/AGENTS.md" ] && cp "$SRC/AGENTS.md" "$JB_HOME/AGENTS.md"
[ -f "$SRC/config/opencode.jsonc.tmpl" ] && cp "$SRC/config/opencode.jsonc.tmpl" "$JB_HOME/config/opencode.jsonc.tmpl"
[ -f "$SRC/manifest.json" ] && cp "$SRC/manifest.json" "$JB_HOME/manifest.json"
ok "agents   $(find "$JB_HOME/agent" -name '*.md' 2>/dev/null | wc -l | tr -d ' ') files"
ok "plugin   $(find "$JB_HOME/plugin" -type f 2>/dev/null | wc -l | tr -d ' ') files"
ok "soul     $(find "$JB_HOME/soul" -name '*.mjs' 2>/dev/null | wc -l | tr -d ' ') modules"

# skills -> config dir + global agents dir
mkdir -p "$JB_HOME/skill" "$HOME/.agents/skills"
if [ -d "$SRC/skills" ]; then
  cp -R "$SRC/skills/." "$JB_HOME/skill/" 2>/dev/null || true
  cp -R "$SRC/skills/." "$HOME/.agents/skills/" 2>/dev/null || true
  ok "skills   $(find "$HOME/.agents/skills" -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ') skills"
fi

# vault skeleton
mkdir -p "$JB_HOME/vault/notes" "$JB_HOME/vault/projects" "$JB_HOME/vault/inbox"
if [ ! -f "$JB_HOME/vault/README.md" ]; then
  cat > "$JB_HOME/vault/README.md" <<'VAULT'
# Memory vault

Obsidian-compatible. Agents read/write here for persistent context.

- `notes/`     — dated session notes, gotchas, snippets
- `projects/`  — per-project state and decisions
- `inbox/`     — unfiled captures

Naming: `YYYY-MM-DD-topic.md`
VAULT
fi
: > "$JB_HOME/vault/agent-memory.db" 2>/dev/null || true
ok "vault    $JB_HOME/vault"

# ---------------------------------------------------------------- deps -------
step "MCP dependencies"
MANIFEST="$JB_HOME/manifest.json"
PKGS=""
if [ -f "$MANIFEST" ]; then
  PKGS="$(node -e '
    const m = require(process.argv[1]);
    console.log(Object.entries(m.mcp.packages).map(([k,v]) => k+"@"+v).join("\n"));
  ' "$MANIFEST" 2>/dev/null || true)"
fi
if [ -z "$PKGS" ]; then
  PKGS="@upstash/context7-mcp@latest
@modelcontextprotocol/server-sequential-thinking@latest
@modelcontextprotocol/server-memory@latest
@modelcontextprotocol/server-filesystem@latest
@playwright/mcp@latest
mcp-server-sqlite-npx@latest
@pollinations/mcp@latest"
  warn "manifest unreadable — using built-in package list"
fi

cd "$JB_HOME"
[ -f package.json ] || printf '{\n  "name": "opencode-mcp-deps",\n  "private": true\n}\n' > package.json

FAILED=""
while IFS= read -r pkg; do
  [ -z "$pkg" ] && continue
  printf '  %s…%s ' "$DIM" "$RST"
  if npm install --no-audit --no-fund --loglevel=error "$pkg" >/dev/null 2>&1; then
    printf '%s✓%s %s\n' "$GRN" "$RST" "$pkg"
  else
    printf '%s!%s %s\n' "$YEL" "$RST" "$pkg"
    FAILED="$FAILED\n    - $pkg"
  fi
done <<EOF
$PKGS
EOF
[ -n "$FAILED" ] && warn "some packages failed (non-fatal; re-run to retry):$FAILED" || true

# github-mcp-server binary
if [ "$JB_MINIMAL" != "1" ] && [ -f "$MANIFEST" ]; then
  step "github MCP server"
  DEST_REL="$(node -e 'const m=require(process.argv[1]);console.log(m.mcp.binaries.github.dest)' "$MANIFEST" 2>/dev/null || echo tools/github/github-mcp-server)"
  DEST="$JB_HOME/$DEST_REL"
  if [ -x "$DEST" ]; then
    ok "already present"
  else
    PATTERN="$(node -e 'const m=require(process.argv[1]);console.log(m.mcp.binaries.github.assetPatterns[process.argv[2]]||"")' "$MANIFEST" "$PLATFORM_KEY" 2>/dev/null || echo '')"
    if [ -z "$PATTERN" ]; then
      warn "no github-mcp-server asset for $PLATFORM_KEY — skipping"
    else
      API="https://api.github.com/repos/github/github-mcp-server/releases/latest"
      ASSET_URL="$(curl -fsSL "$API" 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
          try{
            const j=JSON.parse(d);
            const pat=process.argv[1];
            const a=(j.assets||[]).find(a=>a.name.includes(pat));
            if(a)console.log(a.browser_download_url);
          }catch(e){}
        });' "$PATTERN" || true)"
      if [ -z "$ASSET_URL" ]; then
        warn "could not resolve release asset — skipping (install later from github/github-mcp-server)"
      else
        mkdir -p "$(dirname "$DEST")"
        curl -fsSL "$ASSET_URL" -o "$STAGE/ghmcp.tgz" || die "download failed"
        tar -xzf "$STAGE/ghmcp.tgz" -C "$STAGE"
        FOUND="$(find "$STAGE" -type f -name 'github-mcp-server*' ! -name '*.tar.gz' | head -n 1)"
        [ -n "$FOUND" ] || die "binary not found in archive"
        cp "$FOUND" "$DEST"; chmod +x "$DEST"
        ok "installed $(basename "$DEST")"
      fi
    fi
  fi
fi

# playwright browsers (opt-in heavy dep)
if [ "$JB_MINIMAL" != "1" ] && have npx; then
  printf '  playwright chromium: '
  if npx --yes playwright install chromium >/dev/null 2>&1; then printf '%s✓%s\n' "$GRN" "$RST"; else printf '%s!%s (skipped; run: npx playwright install chromium)\n' "$YEL" "$RST"; fi
fi

# ---------------------------------------------------------------- config -----
step "Rendering config"
if [ -f "$JB_HOME/config/opencode.jsonc.tmpl" ]; then
  if [ -f "$SRC/scripts/render-config.mjs" ]; then
    RENDER="$SRC/scripts/render-config.mjs"
  elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/render-config.mjs" ]; then
    RENDER="$SCRIPT_DIR/scripts/render-config.mjs"
  else
    RENDER="$HOME/.config/opencode/.bootstrap-render-config.mjs"
    cat > "$RENDER" <<'REND'
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const [tpl,out,cfg,home,node,user]=process.argv.slice(2);
const n=node||process.execPath, h=home||os.homedir(), c=cfg||path.join(h,'.config','opencode'), u=user||os.userInfo().username;
let s=fs.readFileSync(tpl,'utf8');
s=s.split('{{NODE}}').join(n.split(path.sep).join('/'))
   .split('{{CONFIG}}').join(c.split(path.sep).join('/'))
   .split('{{HOME}}').join(h.split(path.sep).join('/'))
   .split('{{USERNAME}}').join(u);
fs.writeFileSync(out,s,'utf8');
REND
  fi
  if node "$RENDER" "$JB_HOME/config/opencode.jsonc.tmpl" "$JB_HOME/opencode.jsonc" "$JB_HOME" "$HOME" "$NODE_BIN" >/dev/null; then
    ok "opencode.jsonc rendered ($(wc -c < "$JB_HOME/opencode.jsonc" | tr -d ' ') bytes)"
  else
    warn "render failed — falling back to copying the template verbatim"
    cp "$JB_HOME/config/opencode.jsonc.tmpl" "$JB_HOME/opencode.jsonc"
  fi
else
  warn "template missing — no config written"
fi

# env scaffolding (never overwrites, never contains values)
ENVF="$JB_HOME/.env"
if [ ! -f "$ENVF" ]; then
  {
    echo "# opencode stack — fill in what you have. Never commit this file."
    echo "# Load with:  set -a; . \"$ENVF\"; set +a     (or add to ~/.zshrc)"
    for k in OPENROUTER_API_KEY GEMINI_API_KEY GROQ_API_KEY NVIDIA_API_KEY \
             PERPLEXITY_API_KEY MAGIC_HOUR_API_KEY POLLINATIONS_API_KEY \
             LITELLM_MASTER_KEY GITHUB_MODELS_TOKEN; do
      echo "$k="
    done
  } > "$ENVF"
  chmod 600 "$ENVF"
  ok "wrote $ENVF (chmod 600) — add your keys"
else
  ok "kept existing $ENVF"
fi

# shell wiring for the env file
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  if ! grep -q 'opencode/.env' "$rc" 2>/dev/null; then
    printf '\n# jarvis-bootstrap: load opencode stack secrets\n[ -f "%s" ] && { set -a; . "%s"; set +a; }\n' "$ENVF" "$ENVF" >> "$rc"
    ok "wired $ENVF into $(basename "$rc")"
  fi
done

# ---------------------------------------------------------------- verify -----
step "Verifying"
if [ "$JB_SKIP_CLI" = "1" ]; then
  :
elif have opencode; then
  if opencode --version >/dev/null 2>&1; then ok "opencode runs"; else warn "opencode present but not runnable"; fi
else
  warn "opencode not on PATH yet — open a new shell"
fi
[ -f "$JB_HOME/opencode.jsonc" ] && ok "config present" || warn "config missing"
CNT="$(find "$JB_HOME/agent" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
ok "$CNT agents loaded"
node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");const left=(s.match(/\{\{[A-Z]+\}\}/g)||[]).length;if(left){console.error("unresolved placeholders: "+left);process.exit(1)}' "$JB_HOME/opencode.jsonc" 2>/dev/null \
  && ok "config fully rendered (0 placeholders)" || warn "config still has placeholders"

cat <<EOF

${BOLD}Done.${RST} Config: ${CYN}$JB_HOME${RST}

Next:
  1. add API keys:      ${BOLD}nano $JB_HOME/.env${RST}
  2. authenticate:      ${BOLD}opencode auth login${RST}
  3. run it:            ${BOLD}opencode${RST}    (or: opencode web --port 4096)

Re-run any time — it is idempotent. Your old config is backed up next to
$JB_HOME with a timestamp suffix.
EOF

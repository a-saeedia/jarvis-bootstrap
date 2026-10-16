# jarvis-bootstrap

One command turns a bare macOS/Linux box into a fully-loaded opencode
workstation: every MCP server, agent, skill, plugin, and the persistent memory
vault — installed, wired, and verified.

Built because a fresh MacBook has no idea who you are.

```bash
curl -fsSL https://raw.githubusercontent.com/a-saeedia/jarvis-bootstrap/main/install.sh | bash
```

That's it. Open a new shell and run `opencode`.

---

## What you get

| Layer | Contents |
| --- | --- |
| **Agents** | 17 specialist agents (`architect`, `backend`, `frontend`, `devops`, `security`, `reviewer`, `explore`, `power`, `alchemist`, council pipeline, …) |
| **Skills** | 51 skills (Cloudflare stack, TDD, diagnosing-bugs, research, wayfinder, wizard, writing-*, …) installed to **both** `~/.config/opencode/skill` and `~/.agents/skills` |
| **MCP servers** | 25 configured, 15 enabled out of the box: filesystem, memory, sqlite, sequential-thinking, context7, github, smart-pill, soul, cloudflare (×5), higgsfield, openshorts |
| **Plugins** | `jarvis.ts` — the cockpit plugin |
| **Memory** | Obsidian-compatible vault at `~/.config/opencode/vault` with `notes/`, `projects/`, `inbox/` |
| **Config** | Portable `opencode.jsonc` rendered for *your* machine paths at install time |

No secrets ship in this repo. Every credential is an `{env:VAR}` reference
resolved from your environment.

---

## Install

### macOS / Linux (the one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/a-saeedia/jarvis-bootstrap/main/install.sh | bash
```

### From a checkout (dev / offline)

```bash
git clone https://github.com/a-saeedia/jarvis-bootstrap.git
cd jarvis-bootstrap
./install.sh                 # uses the local payload, no network fetch
```

### Custom target

```bash
JB_HOME=~/.work/opencode ./install.sh
```

### After install

```bash
nano ~/.config/opencode/.env     # add the API keys you have
opencode auth login              # provider OAuth (cloudflare, openshorts, …)
opencode                         # go
opencode web --port 4096         # or the web cockpit
```

---

## What the installer actually does

1. **Preflight** — detects OS/arch, requires Node ≥ 20, installs Homebrew + git/curl only if missing, checks Xcode CLT on macOS.
2. **opencode CLI** — installs via the official `opencode.ai/install` script, falling back to `npm i -g opencode-ai`.
3. **Payload** — downloads the release tarball (or uses the local checkout). No `git clone` needed for the one-liner.
4. **Backs up** any existing `~/.config/opencode` to a timestamped `.bak` directory before touching it.
5. **Installs** agents, skills, plugin, soul modules, `AGENTS.md`.
6. **`npm install`s** the 7 MCP packages into `~/.config/opencode`.
7. **Downloads** the platform-correct `github-mcp-server` binary from its GitHub releases.
8. **Renders** `opencode.jsonc` from a portable template (`{{NODE}}`, `{{CONFIG}}`, `{{HOME}}`, `{{USERNAME}}`).
9. **Scaffolds** `.env` (mode 600, values empty) and wires it into `~/.zshrc` / `~/.bashrc`.
10. **Verifies** the result and prints what to do next.

It is **idempotent** — run it as many times as you like.

---

## Environment variables

The config references these. All are optional; the stack degrades gracefully
and the free/local lanes keep working without any of them.

| Variable | Enables |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter free models |
| `GEMINI_API_KEY` | Google AI Studio (free tier) + the `power` agent |
| `GROQ_API_KEY` | Groq free tier (fast lane) |
| `NVIDIA_API_KEY` | NVIDIA NIM free models |
| `PERPLEXITY_API_KEY` | Sonar search + reasoning |
| `MAGIC_HOUR_API_KEY` | Higgsfield image/video MCP |
| `POLLINATIONS_API_KEY` | Pollinations image generation (disabled by default) |
| `LITELLM_MASTER_KEY` | Local LiteLLM router (`god-router`, `flash`, `coder`, …) |
| `GITHUB_MODELS_TOKEN` | GitHub MCP server + GitHub Models provider |

Set them in `~/.config/opencode/.env`. The installer adds a loader to your
shell rc file, so a new shell picks them up automatically.

---

## Installer flags

| Variable | Default | Effect |
| --- | --- | --- |
| `JB_REPO` | `a-saeedia/jarvis-bootstrap` | Source repo (private repos need `JB_TOKEN`) |
| `JB_REF` | `main` | Branch or tag to install |
| `JB_TOKEN` | — | GitHub token for a private repo |
| `JB_HOME` | `~/.config/opencode` | Install target |
| `JB_MINIMAL` | `0` | `1` skips Playwright browsers + the github MCP binary |
| `JB_NO_BREW` | `0` | `1` never attempts a Homebrew install |
| `JB_SKIP_CLI` | `0` | `1` installs the payload only, no opencode CLI |
| `JB_FORCE_OS` | — | Override `uname -s` (used by the smoke test) |

---

## Doctor

```bash
./scripts/doctor.sh
```

Checks node, git, the opencode CLI, config validity, agent/skill counts, MCP
package presence, the github MCP binary, which env vars are set, and whether
each enabled MCP server can actually start.

---

## Uninstall

```bash
./uninstall.sh              # removes the config dir (backs it up first)
./uninstall.sh --purge      # also removes ~/.agents/skills
```

---

## Layout

```
.
├── install.sh                     # macOS/Linux installer (curl target)
├── install.ps1                    # Windows installer
├── uninstall.sh
├── manifest.json                  # MCP packages, binary asset map, env list
├── payload/
│   ├── AGENTS.md
│   ├── agents/*.md                # 17 agent definitions
│   ├── skills/**                  # 51 skills
│   ├── plugin/jarvis.ts
│   ├── soul/*.mjs                 # soul MCP server (code only, no personal DB)
│   └── config/opencode.jsonc.tmpl # portable config template
└── scripts/
    ├── render-config.mjs          # template -> machine-specific config
    ├── validate-jsonc.mjs         # asserts the config parses
    ├── build-template.mjs         # regenerate the template from a live config
    └── doctor.sh
```

---

## Portability notes

* The config template never hardcodes a home directory: `{{HOME}}`,
  `{{CONFIG}}`, and `{{NODE}}` are resolved at install time.
* Windows-only MCP entries (local project servers under `~/Desktop/...`) stay
  in the config but **disabled**, so the file is identical across platforms.
* `soul.db` and other personal runtime data are deliberately **not** in this
  repo. The soul MCP server code ships; its database is created empty on
  install so no personal data rides along.

---

## Regenerating the template from a live machine

```bash
node scripts/build-template.mjs \
  --from ~/.config/opencode/opencode.jsonc \
  --out payload/config/opencode.jsonc.tmpl
```

Rewrites machine-specific paths into placeholders and strips the BOM, so the
template stays portable.

---

## Security

* No credentials in this repo — verified by pattern scan before every commit.
* `~/.config/opencode/.env` is created with mode `600` and is gitignored.
* The rendered config keeps `bash` deny rules for destructive commands and
  denies `external_directory` access to `/System`, `/usr`, `/etc` (macOS/Linux)
  and `C:/Windows` (Windows).

---

## License

MIT — see [LICENSE](LICENSE).

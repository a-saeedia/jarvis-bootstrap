# install.ps1 - install the opencode stack on Windows.
#
#   irm https://raw.githubusercontent.com/a-saeedia/jarvis-bootstrap/main/install.ps1 | iex
#
# Idempotent. Never writes secrets (only scaffolds an env file).
# Mirrors install.sh: same manifest, same template, same layout.
[CmdletBinding()]
param(
  [string]$Repo     = "a-saeedia/jarvis-bootstrap",
  [string]$Ref      = "main",
  [string]$Token    = $env:JB_TOKEN,
  [string]$JBHome     = "$env:USERPROFILE\.config\opencode",
  [switch]$Minimal,
  [switch]$SkipCli
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan -NoNewline; Write-Host "" }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n[x] $m" -ForegroundColor Red; exit 1 }
function Have($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------- preflight ---
Step "Preflight"
Ok "platform Windows"
if (-not (Have node)) { Die "node >= 20 is required - install from https://nodejs.org" }
$major = [int]((& node -p 'process.versions.node.split(".")[0]'))
if ($major -lt 20) { Die "node $major is too old (need >= 20)" }
$nodeBin = (Get-Command node).Source
Ok "node $(& node -v) at $nodeBin"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
$localPayload = $scriptDir -and (Test-Path (Join-Path $scriptDir 'payload'))

# ---------------------------------------------------------------- cli --------
Step "opencode CLI"
if ($SkipCli) {
  Warn "skipped (-SkipCli)"
} elseif (Have opencode) {
  Ok "already installed"
} elseif (Have npm) {
  & npm install -g opencode-ai | Out-Null
  Ok "installed via npm"
} else {
  Warn "npm missing - install opencode manually: https://opencode.ai"
}

# ---------------------------------------------------------------- payload ----
Step "Fetching payload"
$stage = Join-Path $env:TEMP ("jb-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$src = Join-Path $stage 'src'

try {
  if ($localPayload) {
    New-Item -ItemType Directory -Force -Path $src | Out-Null
    Copy-Item (Join-Path $scriptDir 'payload\*') $src -Recurse -Force
    Ok "using local checkout"
  } else {
    $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Ref"
    $zip = Join-Path $stage 'src.zip'
    $headers = @{}
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    Invoke-WebRequest -Uri $url -OutFile $zip -Headers $headers
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    $root = (Get-ChildItem $stage -Directory | Where-Object { $_.Name -like 'jarvis-bootstrap-*' } | Select-Object -First 1).FullName
    if (-not $root) { Die "could not locate extracted root" }
    $src = Join-Path $root 'payload'
    $scriptDir = $root
    Ok "downloaded and extracted"
  }

  # ------------------------------------------------------------ install -----
  Step "Installing into $JBHome"
  if (Test-Path $JBHome) {
    $bk = "$JBHome.bak." + (Get-Date -Format 'yyyyMMddHHmmss')
    Copy-Item $JBHome $bk -Recurse -Force
    Ok "backed up existing config to $(Split-Path $bk -Leaf)"
  }
  foreach ($d in 'agent','skill','plugin','tools','config','soul') {
    New-Item -ItemType Directory -Force -Path (Join-Path $JBHome $d) | Out-Null
  }
  if (Test-Path (Join-Path $src 'agents')) { Copy-Item (Join-Path $src 'agents\*') (Join-Path $JBHome 'agent') -Recurse -Force }
  if (Test-Path (Join-Path $src 'plugin')) { Copy-Item (Join-Path $src 'plugin\*') (Join-Path $JBHome 'plugin') -Recurse -Force }
  if (Test-Path (Join-Path $src 'soul'))   { Copy-Item (Join-Path $src 'soul\*')   (Join-Path $JBHome 'soul')   -Recurse -Force }
  if (Test-Path (Join-Path $src 'skills')) { Copy-Item (Join-Path $src 'skills\*') (Join-Path $JBHome 'skill')  -Recurse -Force }
  $agentsMd = Join-Path $src 'AGENTS.md'
  if (Test-Path $agentsMd) { Copy-Item $agentsMd (Join-Path $JBHome 'AGENTS.md') -Force }
  $tmplSrc = Join-Path $src 'config\opencode.jsonc.tmpl'
  if (Test-Path $tmplSrc) { Copy-Item $tmplSrc (Join-Path $JBHome 'config\opencode.jsonc.tmpl') -Force }
  $manSrc = Join-Path $src 'manifest.json'
  if (Test-Path $manSrc) { Copy-Item $manSrc (Join-Path $JBHome 'manifest.json') -Force }

  $skillGlobal = Join-Path $env:USERPROFILE '.agents\skills'
  New-Item -ItemType Directory -Force -Path $skillGlobal | Out-Null
  if (Test-Path (Join-Path $src 'skills')) { Copy-Item (Join-Path $src 'skills\*') $skillGlobal -Recurse -Force }

  Ok ("agents   " + (Get-ChildItem (Join-Path $JBHome 'agent') -Filter *.md -ErrorAction SilentlyContinue).Count)
  Ok ("skills   " + (Get-ChildItem $skillGlobal -Recurse -Filter SKILL.md -ErrorAction SilentlyContinue).Count)

  # vault
  foreach ($v in 'notes','projects','inbox') {
    New-Item -ItemType Directory -Force -Path (Join-Path $JBHome "vault\$v") | Out-Null
  }
  Ok "vault    $(Join-Path $JBHome 'vault')"

  # ------------------------------------------------------------ deps --------
  Step "MCP dependencies"
  Push-Location $JBHome
  try {
    if (-not (Test-Path 'package.json')) {
      [System.IO.File]::WriteAllText((Join-Path $PWD 'package.json'), '{"name":"opencode-mcp-deps","private":true}\n')
    }
    $pkgs = @(
      '@upstash/context7-mcp@latest',
      '@modelcontextprotocol/server-sequential-thinking@latest',
      '@modelcontextprotocol/server-memory@latest',
      '@modelcontextprotocol/server-filesystem@latest',
      '@playwright/mcp@latest',
      'mcp-server-sqlite-npx@latest',
      '@pollinations/mcp@latest'
    )
    if (Test-Path 'manifest.json') {
      try {
        $m = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
        $fromManifest = @($m.mcp.packages.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" })
        if ($fromManifest.Count) { $pkgs = $fromManifest }
      } catch { Warn "manifest unreadable - using built-in package list" }
    }
    foreach ($p in $pkgs) {
      & npm install --no-audit --no-fund --loglevel=error $p 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok $p } else { Warn "$p failed (non-fatal)" }
    }
  } finally { Pop-Location }

  # github mcp binary
  if (-not $Minimal) {
    Step "github MCP server"
    $destRel = 'tools\github\github-mcp-server.exe'
    if (Test-Path (Join-Path $JBHome 'manifest.json')) {
      try {
        $m = Get-Content (Join-Path $JBHome 'manifest.json') -Raw | ConvertFrom-Json
        $destRel = $m.mcp.binaries.github.dest -replace '/', '\'
        if ($destRel -notmatch '\.exe$') { $destRel += '.exe' }
      } catch { }
    }
    $dest = Join-Path $JBHome $destRel
    if (Test-Path $dest) {
      Ok "already present"
    } else {
      try {
        $rel = Invoke-RestMethod 'https://api.github.com/repos/github/github-mcp-server/releases/latest'
        $asset = $rel.assets | Where-Object { $_.name -match 'Windows_x86_64' } | Select-Object -First 1
        if ($asset) {
          New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
          $tmp = Join-Path $stage 'gh.zip'
          Invoke-WebRequest $asset.browser_download_url -OutFile $tmp
          Expand-Archive $tmp -DestinationPath (Join-Path $stage 'gh') -Force
          $exe = Get-ChildItem (Join-Path $stage 'gh') -Recurse -Filter 'github-mcp-server*' | Select-Object -First 1
          Copy-Item $exe.FullName $dest -Force
          Ok "installed $(Split-Path $dest -Leaf)"
        } else { Warn "no Windows asset in latest release - skipping" }
      } catch { Warn "could not fetch github-mcp-server - skipping" }
    }
  }

  # ------------------------------------------------------------ config ------
  Step "Rendering config"
  $tmpl = Join-Path $JBHome 'config\opencode.jsonc.tmpl'
  if (Test-Path $tmpl) {
    $t = Get-Content $tmpl -Raw
    $t = $t.Replace('{{NODE}}', $nodeBin.Replace('\','/'))
    $t = $t.Replace('{{CONFIG}}', $JBHome.Replace('\','/'))
    $t = $t.Replace('{{HOME}}', $env:USERPROFILE.Replace('\','/'))
    $t = $t.Replace('{{USERNAME}}', $env:USERNAME)
    [System.IO.File]::WriteAllText((Join-Path $JBHome 'opencode.jsonc'), $t, (New-Object System.Text.UTF8Encoding($false)))
    Ok "opencode.jsonc rendered"
  } else { Warn "template missing - no config written" }

  # env scaffold
  $envf = Join-Path $JBHome '.env'
  if (-not (Test-Path $envf)) {
    $keys = 'OPENROUTER_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','NVIDIA_API_KEY',
            'PERPLEXITY_API_KEY','MAGIC_HOUR_API_KEY','POLLINATIONS_API_KEY',
            'LITELLM_MASTER_KEY','GITHUB_MODELS_TOKEN'
    $lines = @('# opencode stack - fill in what you have. Never commit this file.')
    $lines += $keys | ForEach-Object { "$_=" }
    [System.IO.File]::WriteAllText($envf, (($lines -join "\n") + "\n"))
    Ok "wrote $envf - add your keys"
  } else { Ok "kept existing .env" }

  # ------------------------------------------------------------ verify ------
  Step "Verifying"
  $cfg = Join-Path $JBHome 'opencode.jsonc'
  if (Test-Path $cfg) { Ok "config present ($((Get-Item $cfg).Length) bytes)" } else { Warn "config missing" }
  Ok ("agents   " + (Get-ChildItem (Join-Path $JBHome 'agent') -Filter *.md -ErrorAction SilentlyContinue).Count)

  Write-Host "`nDone. Config: $JBHome" -ForegroundColor Green
  Write-Host @"

Next:
  1. add API keys:  notepad $envf
  2. authenticate:  opencode auth login
  3. run it:        opencode

"@
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

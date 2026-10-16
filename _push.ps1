$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Program Files\Git\cmd;C:\Program Files\Git\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git not found on PATH' }
Write-Host "git: $(& git --version)"
$repo  = 'D:\projects\outsider'
$login = 'a-saeedia'
$uid   = 149491112
$email = "$uid`+$login@users.noreply.github.com"
$full  = "$login/jarvis-bootstrap"

# token from the .env we just wrote (never retype it here)
$envf = 'C:\Users\user\.config\opencode\.env'
$tok = (Get-Content $envf | Where-Object { $_ -match '^GITHUB_TOKEN=' }) -replace '^GITHUB_TOKEN=', ''
if (-not $tok) { throw 'GITHUB_TOKEN missing from .env' }

$h = @{ Authorization = "Bearer $tok"; 'User-Agent' = 'jarvis'; 'Accept' = 'application/vnd.github+json' }

Write-Host '=== create repo ==='
$body = @{ name = 'jarvis-bootstrap'; description = 'One-command bootstrap for an opencode workstation: agents, skills, MCP servers, memory vault.'; private = $true; auto_init = $false; has_issues = $false; has_projects = $false; has_wiki = $false } | ConvertTo-Json
try {
  $r = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $h -Body $body -ContentType 'application/json'
  Write-Host "created $($r.full_name)  visibility=$($r.visibility)  clone=$($r.clone_url)"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 422) { Write-Host "already exists - reusing" } else { throw }
}

Write-Host "`n=== git init ==="
Push-Location $repo
git init -b main 2>&1 | Out-Null
git config user.name  'Arman Saeedi'
git config user.email $email
git config core.autocrlf false
Write-Host ("identity: {0} / {1}" -f (git config user.name), (git config user.email))

Write-Host "`n=== stage ==="
git add -A
git update-index --chmod=+x install.sh
git update-index --chmod=+x uninstall.sh
git update-index --chmod=+x scripts/doctor.sh
git update-index --chmod=+x scripts/scan-secrets.mjs
Write-Host ("{0} staged files" -f (git diff --cached --name-only | Measure-Object -Line).Lines)

# hard gate: refuse to commit if a credential slipped into a tracked file
$bad = git diff --cached --diff-filter=ACM -U0 | Select-String -Pattern 'ghp_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,}'
if ($bad) { Write-Host 'REFUSING TO COMMIT - credential in staged content'; Pop-Location; exit 1 }
Write-Host 'pre-commit secret gate: clean'

Write-Host "`n=== commit ==="
$msg = "jarvis-bootstrap: one-command opencode workstation bootstrap`n`n" +
       "- install.sh / install.ps1: idempotent, platform-aware, backs up existing config`n" +
       "- payload: 17 agents, 51 skills, jarvis.ts plugin, soul MCP modules`n" +
       "- manifest.json: MCP packages + github-mcp-server binary map + env list`n" +
       "- scripts: config renderer/validator, secret scanner, doctor"
git commit -q -m $msg
Write-Host (git log --oneline -1)

Write-Host "`n=== push ==="
$ap = Join-Path $env:TEMP 'jb-askpass.cmd'
[System.IO.File]::WriteAllText($ap, ('@echo ' + $tok + "`n"))
$env:GIT_ASKPASS   = $ap
$env:GIT_TERMINAL_PROMPT = '0'
git remote remove origin 2>$null
git remote add origin "https://github.com/$full.git"
git push -u origin main 2>&1
Write-Host "push exit: $LASTEXITCODE"

Remove-Item $ap -Force -ErrorAction SilentlyContinue
Pop-Location
Write-Host "`nremote URL after push:"
git -C $repo remote -v

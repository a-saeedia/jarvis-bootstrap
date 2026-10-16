$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Program Files\Git\cmd;C:\Program Files\Git\bin;$env:PATH"
Set-Location 'D:\projects\outsider'
Write-Host '=== matching lines in staged diff ==='
git diff --cached --diff-filter=ACM -U0 |
  Select-String -Pattern 'ghp_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,}|gho_|ghs_|Bearer\s+[A-Za-z0-9._-]{40,}' |
  ForEach-Object { $_.Line }

Write-Host "`n=== file-by-file count ==="
git diff --cached --name-only | ForEach-Object {
  $f = $_
  $hits = git diff --cached -U0 -- $f |
    Select-String -Pattern 'ghp_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,}|gho_|ghs_'
  if ($hits) { "{0}  ({1} hits)" -f $f, $hits.Count }
}

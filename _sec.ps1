$envf = 'C:\Users\user\.config\opencode\.env'
& C:\Windows\System32\icacls.exe $envf /inheritance:r | Out-Null
& C:\Windows\System32\icacls.exe $envf /grant:r "${env:USERNAME}:(R,W)" | Out-Null
Write-Host "acl for .env:"
& C:\Windows\System32\icacls.exe $envf

Write-Host "`n--- .env shape (values masked) ---"
Get-Content $envf | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') {
    $n = $Matches[1]; $v = $Matches[2]
    if ($v) { "$n = <set, $($v.Length) chars>" } else { "$n = (empty)" }
  } else { $_ }
}

Write-Host "`n--- secret scan over repo ---"
& 'C:\Users\User\tools\node\node.exe' 'D:\projects\outsider\scripts\scan-secrets.mjs' 'D:\projects\outsider'
Write-Host "scan exit: $LASTEXITCODE"

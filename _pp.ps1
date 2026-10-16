$t = $null; $e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('D:\projects\outsider\_push.ps1', [ref]$t, [ref]$e)
if ($e) { $e | ForEach-Object { $_.Message + '  @line ' + $_.Extent.StartLineNumber } } else { 'SYNTAX OK' }

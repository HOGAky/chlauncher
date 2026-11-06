Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.DisplayName -match 'chlauncher' } |
  ForEach-Object { Write-Output "Removing $($_.PSChildName)"; Remove-Item $_.PSPath -Recurse -Force }

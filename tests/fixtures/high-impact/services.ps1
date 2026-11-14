# Stop-Service -Name Spooler   (commented out: not flagged)
Get-Service | Where-Object Status -eq Running
Stop-Service -Name Spooler -Force
Set-Service -Name RemoteRegistry -StartupType Disabled
Set-Service -Name W32Time -StartupType Automatic
Stop-Service `
  -Name Fax
Write-Output 'Services done'

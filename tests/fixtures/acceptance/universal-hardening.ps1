# Universal Windows hardening baseline
Write-Host 'Starting baseline hardening'
Disable-LocalUser -Name 'Guest'
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 1
Stop-Service -Name 'Spooler' -Force
Set-Service -Name 'Spooler' -StartupType Disabled
Write-Host 'Baseline hardening complete'

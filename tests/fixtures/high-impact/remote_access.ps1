Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 1
Write-Host 'Checking remote access'
Disable-PSRemoting -Force
winrm quickconfig -quiet
(Get-Content C:\ProgramData\ssh\sshd_config) -replace '#?PermitRootLogin.*', 'PermitRootLogin no' | Set-Content C:\ProgramData\ssh\sshd_config

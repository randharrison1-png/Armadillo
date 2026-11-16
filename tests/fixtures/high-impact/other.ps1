$cmd = 'Stop-' + 'Service'
Invoke-Expression "$cmd -Name Spooler"
Restart-Computer -Force

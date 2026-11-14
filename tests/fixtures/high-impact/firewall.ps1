New-NetFirewallRule -DisplayName 'Block SMB' -Direction Inbound -LocalPort 445 -Protocol TCP -Action Block
Get-NetFirewallRule | Out-Null
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
# netsh advfirewall reset
netsh advfirewall set allprofiles state on

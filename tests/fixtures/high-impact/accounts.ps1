# Accounts. Comment lines never flag: Disable-LocalUser -Name Guest
$ErrorActionPreference = 'Stop'
Get-LocalUser | Format-Table Name, Enabled
Disable-LocalUser -Name Guest
remove-localuser -Name hacker
net user Administrator /active:no
Add-LocalGroupMember -Group Administrators -Member bob
Write-Output 'Accounts done'

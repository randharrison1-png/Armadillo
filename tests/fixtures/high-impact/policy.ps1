<#
  Policy section. Block comment text is scanned like code.
#> Stop-Service -Name WinRM -Force
# net accounts /lockoutthreshold:5   (comment: not flagged)
net accounts
net accounts /lockoutthreshold:5 /maxpwage:30
secedit /configure /db C:\Windows\security\local.sdb /cfg .\baseline.inf
secedit /export /cfg .\current.inf
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' -Name fDisableCdm -Value 1
$params = @{ Name = 'Spooler'; StartupType = 'Disabled' }
Set-Service @params
<# inline note #> Restart-Computer -Force

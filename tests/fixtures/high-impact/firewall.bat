@echo off
netsh advfirewall set allprofiles state on
NETSH AdvFirewall firewall add rule name="Block SMB" dir=in action=block protocol=TCP localport=445
echo firewall configured

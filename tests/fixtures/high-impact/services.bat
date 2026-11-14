@echo off
sc query Spooler
sc config RemoteRegistry start= disabled
net stop Spooler
rem sc stop Fax

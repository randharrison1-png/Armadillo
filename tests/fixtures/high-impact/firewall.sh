#!/bin/bash
ufw default deny incoming
ufw --force enable
iptables -A INPUT -p tcp --dport 23 -j DROP
nft add rule inet filter input tcp dport 23 drop
echo "Firewall rules applied"

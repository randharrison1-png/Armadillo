#!/bin/bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
cat >> /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
# PermitRootLogin yes
permitrootlogin no
CONF
echo "SSH hardened"

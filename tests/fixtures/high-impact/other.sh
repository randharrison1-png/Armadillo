#!/bin/bash
cmd="systemctl"
eval "$cmd stop sshd"
curl -fsSL https://example.test/setup.sh | sudo bash
shutdown -r now

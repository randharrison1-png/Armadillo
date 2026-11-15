#!/bin/bash
# Decoy-Linux-Baseline-9f3a: a Linux script that this acceptance run never selects.
set -eu
passwd -l guest
systemctl disable --now cups-browsed
echo "decoy-linux-baseline-9f3a done"

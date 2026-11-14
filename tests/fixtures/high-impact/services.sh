#!/bin/bash
systemctl status cups
systemctl stop cups
systemctl disable --now avahi-daemon
systemctl mask bluetooth.service
systemctl enable apparmor
systemctl \
  stop nginx

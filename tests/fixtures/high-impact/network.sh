#!/bin/bash
pgrep -l sshd
pkill -HUP sshd
killall sshd
kill $(pidof sshd)
ifconfig eth0 down
ip link set dev eth0 down
ip link show

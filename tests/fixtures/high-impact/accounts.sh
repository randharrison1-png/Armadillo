#!/bin/bash
# userdel -r hacker   (commented out: not flagged)
getent passwd | cut -d: -f1
userdel -r hacker
usermod -L guest
passwd -l games
USERDEL bob

#!/usr/bin/env bash
#
# harden-linux.sh
#
# Universal CyberPatriot hardening script for Debian-family Linux images
# (Debian, Ubuntu, Linux Mint). Nothing about the scenario is built in.
#
# The script first reads the README of the image it runs on (the README
# shortcut on the desktop) and takes from it the authorized administrators and
# users (and which README passwords are weak), the critical services, the
# software it names, the default browser and the display manager. It shows
# what it understood and lets you correct it, then saves it in
# leads-config.txt next to the script (the same file leads.sh uses). If the
# README cannot be read it asks you to type those facts.
#
# Each check then reads the current state first, logs OK if it is already
# compliant, and fixes it if it is not. Everything is logged to
# /var/log/hardening. Originals of every file it edits are copied to
# /var/backups/hardening-<timestamp>. Items a script cannot safely decide are
# listed at the end as MANUAL / REVIEW.
#
# How the README steers it:
#   - accounts not on the README lists are removed and sudo is matched to the
#     admin list; if the lists are unknown, no account is touched
#   - critical services (SSH, Apache/Nginx, Samba, FTP, databases, ...) are
#     kept running, hardened and allowed through the firewall; other server
#     software is disabled. If the critical list is unknown, nothing that might
#     be critical is disabled
#   - packages the README names are never purged as prohibited
#
# What it will NOT touch:
#   - the CCS Client service/process and /opt/CyberPatriot
#   - the password of the account that ran sudo / the auto-login account
#   - time zone, date, time
#
# Usage:
#   sudo bash harden-linux.sh --audit     # look first, change nothing
#   sudo bash harden-linux.sh             # then fix
#
# Options:
#   --audit                 report what would change; make no changes
#   --password-scope SCOPE  all   (default) new password for every authorized
#                                 account except yours and the auto-login one
#                           users new password for standard users plus admins
#                                 whose README password is weak
#                           none  do not change any passwords
#   --delete-prohibited     delete prohibited files instead of quarantining
#   --skip-upgrade          do not run apt upgrade
#   --skip-file-scan        skip the prohibited media / file scan
#   --readme SOURCE         read this README (web address or saved file)
#   --config FILE           use this settings file instead of leads-config.txt
#   --yes                   do not ask about the README facts
#   --force                 skip the Forensics Questions confirmation
#   -h, --help              show this help

set -u
set -o pipefail
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# =============================================================================
#  CONFIGURATION  -  nothing here depends on the scenario.
# =============================================================================

# The scenario facts (users, critical services, software, browser, display
# manager) are read from the README at run time: see readme_facts below.
AUTH_ADMINS=(); AUTH_USERS=(); KNOWN_WEAK_ACCOUNTS=()

# Password policy
MIN_PASS_LEN=14
PASS_MAX_DAYS=90
PASS_MIN_DAYS=1
PASS_WARN_AGE=7
PASS_REMEMBER=5
LOCKOUT_DENY=5
LOCKOUT_SECONDS=1800

# With this set to 1 (and the README user lists known), sshd refuses everyone
# who is NOT on the authorized lists.
SSH_RESTRICT_TO_AUTHORIZED=1

# Services with no business purpose unless the README lists them as critical.
# Critical ones are dropped from this list at run time.
SERVICES_TO_DISABLE=(apache2 nginx lighttpd vsftpd proftpd pure-ftpd smbd nmbd samba-ad-dc
    nfs-server nfs-kernel-server rpcbind named bind9 inetd xinetd openbsd-inetd telnet snmpd
    mariadb mysql postgresql dovecot squid tftpd-hpa atftpd rsync nis ypbind minidlna
    transmission-daemon x11vnc xrdp xrdp-sesman avahi-daemon inspircd ngircd znc tor pptpd
    cockpit webmin salt-minion puppet nagios-nrpe-server zabbix-agent)
# Often needed: only disabled when the README lists its critical services and these are not among them
GUARDED_UNITS=(apache2 nginx lighttpd vsftpd proftpd pure-ftpd smbd nmbd samba-ad-dc nfs-server nfs-kernel-server
    rpcbind named bind9 mariadb mysql postgresql dovecot squid rsync xrdp xrdp-sesman cockpit webmin)
declare -A RISKY_UNITS=()

# Installed packages matching this are purged: hacking tools, remote-access
# and legacy servers, P2P clients, games - unless the README names them as
# business software or they belong to a critical service.
PROHIBITED_PKG_REGEX='^(john|john-data|hydra|hydra-gtk|nmap|nmap-common|zenmap|ncat|ndiff|netcat|netcat-traditional|netcat-openbsd|nikto|sqlmap|aircrack-ng|wireshark.*|tshark|ophcrack.*|hashcat.*|medusa|ettercap.*|kismet.*|dsniff|fcrackzip|pdfcrack|rarcrack|sucrack|crack|crack-common|cewl|crunch|wifite|reaver|bully|pixiewps|hping3|masscan|yersinia|weevely|metasploit-framework|armitage|wapiti|skipfish|dirb|gobuster|wfuzz|nbtscan|enum4linux|smbmap|responder|bettercap.*|driftnet|logkeys|telnetd|inetutils-telnetd|rsh-server|rsh-redone-server|rsh-client|tftpd.*|atftpd|x11vnc|tightvncserver|tigervnc-standalone-server|xrdp|vino|transmission.*|deluge.*|qbittorrent.*|ktorrent.*|amule.*|rtorrent|freeciv.*|wesnoth.*|minetest.*|supertux.*|0ad.*|nethack.*|aisleriot|gnome-games|gnome-mines|gnome-sudoku|gnome-mahjongg|quadrapassel|kmines|ksudoku|steam.*|lutris|dosbox|openarena.*|xonotic.*|frozen-bubble|pingus|tor|torbrowser-launcher|proxychains.*)$'

# Non-work media (auto-removed from the scan roots below)
MEDIA_EXT_REGEX='^(mp3|mp4|m4a|m4v|wav|wma|wmv|avi|mkv|mov|flac|ogg|oga|opus|aac|mpg|mpeg|flv|webm)$'
# Only listed for you to review, never auto-removed
REVIEW_EXT_REGEX='^(jpg|jpeg|png|gif|bmp|zip|rar|7z|tar|gz|tgz|deb|exe|sh|py|pl|rb|elf|bin|pcap|pcapng)$'
SCAN_ROOTS=(/home /root /srv /var/www /tmp /var/tmp /media /mnt)
# Media found here is only reported (it may belong to installed software)
REVIEW_ROOTS=(/opt /usr/local /var /etc)

# Programs that must never be set-uid root
SUID_NEVER='^(bash|dash|sh|zsh|ksh|python[0-9.]*|perl[0-9.]*|ruby[0-9.]*|find|vim.*|vi|nano|less|more|awk|gawk|mawk|cp|mv|env|nmap|tar|sed|cat|tee|dd)$'

SYSCTL_SETTINGS=(
    "net.ipv4.tcp_syncookies=1"
    "net.ipv4.ip_forward=0"
    "net.ipv4.conf.all.accept_redirects=0"
    "net.ipv4.conf.default.accept_redirects=0"
    "net.ipv4.conf.all.secure_redirects=0"
    "net.ipv4.conf.default.secure_redirects=0"
    "net.ipv4.conf.all.send_redirects=0"
    "net.ipv4.conf.default.send_redirects=0"
    "net.ipv4.conf.all.accept_source_route=0"
    "net.ipv4.conf.default.accept_source_route=0"
    "net.ipv4.conf.all.rp_filter=1"
    "net.ipv4.conf.default.rp_filter=1"
    "net.ipv4.conf.all.log_martians=1"
    "net.ipv4.conf.default.log_martians=1"
    "net.ipv4.icmp_echo_ignore_broadcasts=1"
    "net.ipv4.icmp_ignore_bogus_error_responses=1"
    "net.ipv4.tcp_rfc1337=1"
    "net.ipv6.conf.all.accept_redirects=0"
    "net.ipv6.conf.default.accept_redirects=0"
    "net.ipv6.conf.all.accept_source_route=0"
    "net.ipv6.conf.default.accept_source_route=0"
    "kernel.randomize_va_space=2"
    "kernel.dmesg_restrict=1"
    "kernel.kptr_restrict=2"
    "kernel.sysrq=0"
    "kernel.yama.ptrace_scope=1"
    "fs.suid_dumpable=0"
    "fs.protected_hardlinks=1"
    "fs.protected_symlinks=1"
)

SSHD_SETTINGS=(
    "PermitRootLogin no"
    "PermitEmptyPasswords no"
    "PasswordAuthentication yes"
    "PubkeyAuthentication yes"
    "HostbasedAuthentication no"
    "IgnoreRhosts yes"
    "PermitUserEnvironment no"
    "UsePAM yes"
    "StrictModes yes"
    "X11Forwarding no"
    "AllowTcpForwarding no"
    "AllowAgentForwarding no"
    "MaxAuthTries 4"
    "LoginGraceTime 60"
    "ClientAliveInterval 300"
    "ClientAliveCountMax 3"
    "LogLevel VERBOSE"
)
# Directives that could lock authorized users out; always commented out.
SSHD_ALSO_DISABLE=(AllowUsers DenyUsers AllowGroups DenyGroups)
SSHD_BEGIN="# --- BEGIN hardening script settings (first value wins; keep at top) ---"
SSHD_END="# --- END hardening script settings ---"

# Used by the README reader to spot packages the README names
TOOL_PKG_REGEX=$PROHIBITED_PKG_REGEX
REMOTE_PKG_REGEX='^(apache2|nginx|lighttpd|vsftpd|proftpd.*|pure-ftpd.*|samba|nfs-kernel-server|bind9|snmpd|mariadb-server.*|mysql-server.*|postgresql|dovecot-.*|squid|openssh-server)$'
SERVER_PKG_REGEX='^$'
GAME_PKG_REGEX='^$'

LOG_DIR=/var/log/hardening
QUARANTINE_DIR=/var/hardening-quarantine

# =============================================================================
#  PLUMBING
# =============================================================================

AUDIT=0
FORCE=0
PASSWORD_SCOPE=all
DELETE_PROHIBITED=0
SKIP_UPGRADE=0
SKIP_FILE_SCAN=0

ASSUME_YES=0
README_SRC=""
CONFIG=""
CONFIG_GIVEN=0
HOST=$(hostname 2>/dev/null || echo host)
RUN_USER=${SUDO_USER:-root}
. /etc/os-release 2>/dev/null
OS_ID=${ID:-unknown}; OS_LIKE=${ID_LIKE:-}; OS_CODENAME=${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}; OS_NAME=${PRETTY_NAME:-Linux}

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="$LOG_DIR/harden-$STAMP.log"
BACKUP_DIR="/var/backups/hardening-$STAMP"

N_OK=0; N_FIXED=0; N_WOULD=0; N_FAIL=0
MANUAL=()
REVIEW=()
NEW_PASS=""
APT_READY=0
PROTECTED=()
PASSWORD_TARGETS=()

log() {
    local level=$1; shift
    local msg=$* color=""
    case $level in
        OK)    color=$'\e[90m'; N_OK=$((N_OK + 1)) ;;
        FIXED) color=$'\e[32m'; N_FIXED=$((N_FIXED + 1)) ;;
        WOULD) color=$'\e[36m'; N_WOULD=$((N_WOULD + 1)) ;;
        FAIL)  color=$'\e[31m'; N_FAIL=$((N_FAIL + 1)) ;;
        WARN)  color=$'\e[33m' ;;
        HEAD)  color=$'\e[35m' ;;
    esac
    if [[ -t 1 ]]; then
        printf '%s[%-5s] %s\e[0m\n' "$color" "$level" "$msg"
    else
        printf '[%-5s] %s\n' "$level" "$msg"
    fi
    printf '[%-5s] %s\n' "$level" "$msg" >>"$LOG"
}

section() { echo; echo >>"$LOG"; log HEAD "===== $* ====="; }
manual()  { MANUAL+=("$*"); log WARN "MANUAL: $*"; }
review()  { REVIEW+=("$*"); }

# change "description" command [args...]   -> runs the command unless --audit
change() {
    local what=$1; shift
    if (( AUDIT )); then log WOULD "$what"; return 0; fi
    if "$@" >>"$LOG" 2>&1; then
        log FIXED "$what"
        return 0
    else
        log FAIL "$what (exit $?; details in $LOG)"
        return 1
    fi
}

in_list() {
    local needle=$1 item; shift
    for item in "$@"; do [[ $item == "$needle" ]] && return 0; done
    return 1
}

is_ccs()       { [[ $1 =~ [Cc][Cc][Ss][Cc]lient|[Cc]yber[Pp]atriot ]]; }
is_admin()     { in_list "$1" "${AUTH_ADMINS[@]}"; }
is_authorized(){ in_list "$1" "${AUTH_ADMINS[@]}" "${AUTH_USERS[@]}"; }
is_protected() { (( ${#PROTECTED[@]} )) && in_list "$1" "${PROTECTED[@]}"; }
user_exists()  { getent passwd "$1" >/dev/null 2>&1; }
pkg_installed(){ dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
pkg_owns()     { dpkg -S "$1" >/dev/null 2>&1 || dpkg -S "${1#/usr}" >/dev/null 2>&1; }
have()         { command -v "$1" >/dev/null 2>&1; }
list_pkgs()    { dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1 ~ /^ii/ {print $2}'; }

backup() {
    local f
    (( AUDIT )) && return 0
    for f in "$@"; do
        [[ -e $f ]] || continue
        mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
        mkdir -p "$BACKUP_DIR$(dirname "$f")"
        [[ -e $BACKUP_DIR$f ]] || cp -a "$f" "$BACKUP_DIR$f"
    done
}

# --- "key = value" files (pwquality.conf, faillock.conf, sysctl.conf) --------
get_kv() {  # file key
    awk -F= -v k="$2" '
        /^[[:space:]]*#/ { next }
        { n=$1; gsub(/[[:space:]]/, "", n)
          if (n == k) { v=$0; sub(/^[^=]*=/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); out=v } }
        END { print out }' "$1" 2>/dev/null
}
_set_kv() {  # file key value
    local key_re=${2//./\\.}
    touch "$1"
    sed -i -E "/^[[:space:]]*${key_re}[[:space:]]*=/d" "$1"
    printf '%s = %s\n' "$2" "$3" >>"$1"
}
set_kv() {  # file key value
    local cur; cur=$(get_kv "$1" "$2")
    if [[ $cur == "$3" ]]; then log OK "$1: $2 = $3"; return 0; fi
    backup "$1"
    change "$1: set $2 = $3 (was ${cur:-not set})" _set_kv "$1" "$2" "$3"
}

# --- "KEY value" files (login.defs) -----------------------------------------
get_def() { awk -v k="$2" '$1 == k { v=$2 } END { print v }' "$1" 2>/dev/null; }
_set_def() {
    sed -i -E "/^[[:space:]]*$2[[:space:]]/d" "$1"
    printf '%s\t%s\n' "$2" "$3" >>"$1"
}
set_def() {  # file KEY value
    local cur; cur=$(get_def "$1" "$2")
    if [[ $cur == "$3" ]]; then log OK "$1: $2 $3"; return 0; fi
    backup "$1"
    change "$1: set $2 $3 (was ${cur:-not set})" _set_def "$1" "$2" "$3"
}

# --- ini files (lightdm.conf) -----------------------------------------------
get_ini() {  # file section key
    awk -v sec="[$2]" -v k="$3" '
        /^[[:space:]]*\[/ { t=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t); insec=(t == sec); next }
        insec && !/^[[:space:]]*#/ {
            n=$0; sub(/=.*/, "", n); gsub(/[[:space:]]/, "", n)
            if (n == k) { v=$0; sub(/^[^=]*=/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); out=v } }
        END { print out }' "$1" 2>/dev/null
}
_set_ini() {  # file section key value
    local tmp; tmp=$(mktemp)
    touch "$1"
    awk -v sec="[$2]" -v k="$3" -v v="$4" '
        /^[[:space:]]*\[/ {
            t=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t); insec=(t == sec)
            print
            if (insec) { print k "=" v; seen=1 }
            next
        }
        insec && !/^[[:space:]]*#/ {
            n=$0; sub(/=.*/, "", n); gsub(/[[:space:]]/, "", n)
            if (n == k) next
        }
        { print }
        END { if (!seen) { print ""; print sec; print k "=" v } }' "$1" >"$tmp" \
        && cat "$tmp" >"$1"
    local rc=$?
    rm -f "$tmp"
    return $rc
}
set_ini() {  # file section key value
    local cur; cur=$(get_ini "$1" "$2" "$3")
    if [[ $cur == "$4" ]]; then log OK "$1 [$2]: $3=$4"; return 0; fi
    backup "$1"
    change "$1 [$2]: set $3=$4 (was ${cur:-not set})" _set_ini "$1" "$2" "$3" "$4"
}

apt_ready() {
    (( APT_READY == 1 )) && return 0
    (( APT_READY == 2 )) && return 1
    if apt-get update >>"$LOG" 2>&1; then APT_READY=1; return 0; fi
    APT_READY=2
    manual "apt-get update failed (no network, or a broken source). Fix /etc/apt/sources.list, then re-run this script."
    return 1
}
apt_do() { apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
_apt_install() { apt_ready && apt_do install "$@"; }
ensure_pkg() {  # package [why]
    if pkg_installed "$1"; then log OK "Package $1 is installed"; return 0; fi
    change "Install package $1${2:+ ($2)}" _apt_install "$1"
}

disable_unit() {  # unit name without suffix
    local base=$1 suffix unit en act
    for suffix in service socket; do
        unit="$base.$suffix"
        is_ccs "$unit" && continue
        systemctl cat "$unit" >/dev/null 2>&1 || continue
        en=$(systemctl is-enabled "$unit" 2>/dev/null)
        act=$(systemctl is-active "$unit" 2>/dev/null)
        if [[ $act == active || $en == enabled || $en == enabled-runtime ]]; then
            change "Stop and disable $unit" systemctl disable --now "$unit"
        else
            log OK "$unit is not running or enabled"
        fi
    done
}

enable_unit() {  # unit
    local unit=$1
    systemctl cat "$unit" >/dev/null 2>&1 || { log WARN "$unit is not installed"; return 1; }
    if [[ $(systemctl is-active "$unit" 2>/dev/null) == active && $(systemctl is-enabled "$unit" 2>/dev/null) == enabled ]]; then
        log OK "$unit is enabled and running"
    else
        change "Enable and start $unit" systemctl enable --now "$unit"
    fi
}

password_is_strong() {
    local p=$1
    (( ${#p} >= MIN_PASS_LEN )) && [[ $p =~ [a-z] && $p =~ [A-Z] && $p =~ [0-9] && $p =~ [^a-zA-Z0-9] ]]
}

shadow_field() { awk -F: -v u="$1" -v f="$2" '$1 == u { print $f }' /etc/shadow; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }

readme_facts() {
# =============================================================================
#  SCENARIO FACTS  -  read from the README on this machine, never hard-coded.
#  They are saved in leads-config.txt next to the script so you can correct them.
# =============================================================================
SCRIPT_DIR=$(dirname "$(readlink -f "$0")")
[[ -z $CONFIG ]] && CONFIG="$SCRIPT_DIR/leads-config.txt"
F_ADMINS=(); F_USERS=(); F_CRITICAL=(); F_SOFTWARE=()
F_BROWSER=""; F_DM=""; F_SOURCE=""; FACTS_FROM=""
NEGATIVE='prohibit|not allowed|not permitted|unauthori[sz]ed|must not|should not be installed|forbidden|banned|hacking tool|remove'

# README name -> regular expression for the package name
KNOWN_SOFTWARE=(
    "Firefox:firefox" "Chromium:chromium" "Google Chrome:google-chrome" "Chrome:google-chrome" "Brave:brave" "Opera:opera"
    "Thunderbird:thunderbird" "Evolution:evolution" "LibreOffice:libreoffice" "GIMP:gimp" "Inkscape:inkscape" "Krita:krita"
    "Blender:blender" "VLC:vlc" "Audacity:audacity" "Kdenlive:kdenlive" "FileZilla:filezilla" "Remmina:remmina"
    "KeePassXC:keepassxc" "Geany:geany" "Emacs:emacs" "Stellarium:stellarium" "OpenRocket:openrocket" "Pidgin:pidgin"
    "HexChat:hexchat" "Wireshark:wireshark|tshark" "Nmap:nmap|zenmap" "Apache:apache2|httpd" "Nginx:nginx" "Samba:samba|smb"
    "MySQL:mysql" "MariaDB:mariadb" "PostgreSQL:postgresql" "OpenSSH:openssh" "vsftpd:vsftpd" "ProFTPD:proftpd"
    "Pure-FTPd:pure-ftpd" "BIND:bind9|bind" "Postfix:postfix" "Dovecot:dovecot" "PHP:php" "WordPress:wordpress"
    "Docker:docker" "Squid:squid" "CUPS:cups" "OpenVPN:openvpn" "Transmission:transmission" "Deluge:deluge"
    "TigerVNC:tigervnc" "TightVNC:tightvnc" "X2Go:x2go" "Minetest:minetest" "Steam:steam" "Tor:tor" "Git:git"
)

split_list() {   # "a, b; c"  ->  one item per line
    tr ',;' '\n\n' <<<"$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -vixE '|none|n/a|-'
}
join_list() { local IFS=,; local s="$*"; printf '%s' "${s//,/, }"; }
# True when the text names the word and the sentence around it does not prohibit it.
mentioned() {
    local text=$1 word=$2 esc sentence
    esc=$(sed -E 's/[][\.*^$+?(){}|/]/\\&/g' <<<"$word")
    sentence=$(grep -oiE "[^.!?]*(^|[^[:alnum:]])${esc}([^[:alnum:]]|\$)[^.!?]*" <<<"$text" | head -n1)
    [[ -n $sentence ]] || return 1
    grep -qiE "$NEGATIVE" <<<"$sentence" && return 1
    return 0
}
html_to_text() {
    if have perl; then
        perl -0pe 's/<(script|style|head|nav|footer)\b.*?<\/\1>/ /gis; s/<br\s*\/?>|<\/(p|div|li|h\d|tr)>|<\/?(pre|ul|ol)[^>]*>|<li[^>]*>/\n/gi; s/<[^>]+>/ /g; s/&nbsp;|&#160;/ /g; s/&amp;/&/g; s/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g; s/&#39;|&rsquo;|&lsquo;|&#8217;/\x27/g; s/\r//g; s/[ \t]+/ /g'
    else
        tr '\r' ' ' | sed -E 's/<[Bb][Rr][^>]*>|<\/([Pp]|div|li|h[0-9]|tr|pre|ul|ol)>|<(li|pre|ul|ol)[^>]*>/\n/g; s/<[^>]+>/ /g; s/&nbsp;/ /g; s/&amp;/\&/g; s/[ \t]+/ /g'
    fi
}
find_readme() {   # prints a web address or a file path
    local f hit
    while IFS= read -r f; do
        case "${f,,}" in
            *.desktop|*.url|*.webloc)
                hit=$(grep -aoE "https?://[^\"' <>]+" "$f" 2>/dev/null | head -n1)
                [[ -z $hit ]] && hit=$(grep -aoE "/[^\"' ]+\.(html?|txt)" "$f" 2>/dev/null | head -n1)
                if [[ -n $hit ]]; then printf '%s' "$hit"; return 0; fi ;;
            *.html|*.htm|*.txt|*.md)
                printf '%s' "$f"; return 0 ;;
        esac
    done < <(find /home/*/Desktop /root/Desktop /opt/CyberPatriot /home/* -maxdepth 1 -type f -iname '*readme*' 2>/dev/null)
    return 1
}
get_readme_text() {
    local src=$1 raw=""
    if [[ $src =~ ^https?:// ]]; then
        if have curl; then raw=$(curl -fsSL --max-time 30 "$src" 2>/dev/null)
        elif have wget; then raw=$(wget -q -T 30 -O - "$src" 2>/dev/null); fi
    elif [[ -f $src ]]; then
        raw=$(cat "$src")
    fi
    [[ -z $raw ]] && return 1
    if grep -qiE '<(html|body|div|p|br|pre|li)[ >/]' <<<"$raw"; then html_to_text <<<"$raw"; else tr -d '\r' <<<"$raw"; fi
}
# The layout is the same on every CyberPatriot README: "Authorized Administrators:", "Authorized Users:"
# and "Critical Services:", each followed by one item per line.
parse_readme() {
    local text=$1 line mode="" item pair name rx p
    F_ADMINS=(); F_USERS=(); F_CRITICAL=(); F_SOFTWARE=()
    while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        if [[ ${#line} -lt 60 ]]; then
            if [[ $line =~ ^Authorized\ Administrators? ]]; then mode=admins; continue; fi
            if [[ $line =~ ^Authorized\ Users? ]]; then mode=users; continue; fi
            if [[ $line =~ ^Critical\ Services? ]]; then mode=critical; continue; fi
        fi
        [[ -z $line ]] && continue
        case $mode in
            admins)
                [[ $line =~ ^[Pp]assword ]] && continue
                if [[ $line =~ ^([A-Za-z][A-Za-z0-9_.-]{0,30})([[:space:]]*\(.*\))?$ ]]; then
                    item=${BASH_REMATCH[1]}
                    [[ ${item,,} =~ ^(none|password)$ ]] || in_list "$item" "${F_ADMINS[@]}" || F_ADMINS+=("$item")
                fi ;;
            users)
                if [[ $line =~ ^([A-Za-z][A-Za-z0-9_.-]{0,30})([[:space:]]*\(.*\))?$ ]]; then
                    item=${BASH_REMATCH[1]}
                    [[ ${item,,} =~ ^(none|password)$ ]] || in_list "$item" "${F_ADMINS[@]}" "${F_USERS[@]}" || F_USERS+=("$item")
                elif [[ ${#F_USERS[@]} -gt 0 ]]; then
                    mode=""
                fi ;;
            critical)
                if [[ ${#line} -gt 70 || ${#F_CRITICAL[@]} -ge 12 || $line =~ ^(Before|Please|Authorized|Competition|It\ is|You\ |The\ ) ]]; then mode=""; continue; fi
                item=$(sed -E 's/^[^[:alnum:](]+//' <<<"$line")
                [[ -n $item ]] && F_CRITICAL+=("$item") ;;
        esac
    done <<<"$text"

    # software the README names: known programs, and installed packages from the watch lists
    for pair in "${KNOWN_SOFTWARE[@]}"; do
        name=${pair%%:*}
        mentioned "$text" "$name" && ! in_list "$name" "${F_SOFTWARE[@]}" && F_SOFTWARE+=("$name")
    done
    while IFS= read -r p; do
        [[ -z $p ]] && continue
        [[ $p =~ $TOOL_PKG_REGEX || $p =~ $REMOTE_PKG_REGEX || $p =~ $SERVER_PKG_REGEX || $p =~ $GAME_PKG_REGEX ]] || continue
        mentioned "$text" "$p" && ! in_list "$p" "${F_SOFTWARE[@]}" && F_SOFTWARE+=("$p")
    done < <(list_pkgs)

    F_BROWSER=$(grep -oiE 'default( web)? browser[^.]{0,160}' <<<"$text" | grep -oiE 'google chrome|chromium|chrome|firefox|brave|opera' | head -n1)
    [[ -z $F_BROWSER ]] && F_BROWSER=$(grep -oiE '(google chrome|chromium|chrome|firefox|brave|opera)[^.]{0,80}default( web)? browser' <<<"$text" | grep -oiE '^(google chrome|chromium|chrome|firefox|brave|opera)' | head -n1)
    F_DM=$(grep -oiE '[^.]*display manager[^.]*' <<<"$text" | grep -oiE 'lightdm|gdm3?|sddm|xdm|lxdm' | head -n1)
    F_DM=${F_DM,,}
    return 0
}
load_config() {   # prints the computer name the file was written on
    local key val computer=""
    while IFS='=' read -r key val; do
        [[ $key =~ ^[[:space:]]*# || -z $key ]] && continue
        key=$(tr -d '[:space:]' <<<"$key"); key=${key,,}
        val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
        case $key in
            computer)          computer=$val ;;
            source)            F_SOURCE=$val ;;
            admins)            mapfile -t F_ADMINS < <(split_list "$val") ;;
            users)             mapfile -t F_USERS < <(split_list "$val") ;;
            critical_services) mapfile -t F_CRITICAL < <(split_list "$val") ;;
            software)          mapfile -t F_SOFTWARE < <(split_list "$val") ;;
            default_browser)   F_BROWSER=$val ;;
            display_manager)   F_DM=${val,,} ;;
        esac
    done <"$CONFIG"
    SAVED_ON=$computer
}
save_config() {
    {
        echo "# leads-config.txt  -  what the README of THIS image says. Leads.ps1 and leads.sh read it."
        echo "# Correct anything that is wrong, save, and run the script again. Separate names with commas."
        echo "# Leave a line empty when the README does not say. Delete this file to read the README again."
        echo "computer = $HOST"
        echo "source = $F_SOURCE"
        echo "admins = $(join_list "${F_ADMINS[@]}")"
        echo "users = $(join_list "${F_USERS[@]}")"
        echo "critical_services = $(join_list "${F_CRITICAL[@]}")"
        echo "software = $(join_list "${F_SOFTWARE[@]}")"
        echo "default_browser = $F_BROWSER"
        echo "display_manager = $F_DM"
    } >"$CONFIG" 2>/dev/null || echo "  could not save $CONFIG"
    [[ $RUN_USER != root ]] && chown "$RUN_USER": "$CONFIG" 2>/dev/null
}
show() { if [[ $# -gt 0 ]]; then join_list "$@"; else printf '(not known)'; fi; }
fact_lines() {
    echo "  Read from           : $FACTS_FROM"
    echo "  Authorized admins   : $(show "${F_ADMINS[@]}")"
    echo "  Authorized users    : $(show "${F_USERS[@]}")"
    echo "  Critical services   : $(show "${F_CRITICAL[@]}")"
    echo "  Software it names   : $(show "${F_SOFTWARE[@]}")"
    echo "  Default browser     : ${F_BROWSER:-(not known)}"
    echo "  Display manager     : ${F_DM:-(not known)}"
}
ask_list() {   # ask_list ARRAY_NAME "question"
    local answer
    read -r -p "$2: " answer </dev/tty || answer=""
    mapfile -t "$1" < <(split_list "$answer")
}

SAVED_ON=""
if [[ -z $README_SRC && -f $CONFIG ]]; then
    load_config
    if [[ $CONFIG_GIVEN -eq 1 || -z $SAVED_ON || ${SAVED_ON,,} == "${HOST,,}" ]]; then
        FACTS_FROM="saved settings in $CONFIG"
    else
        echo "Ignoring $CONFIG: it was written on another computer ($SAVED_ON)."
        F_ADMINS=(); F_USERS=(); F_CRITICAL=(); F_SOFTWARE=(); F_BROWSER=""; F_DM=""; F_SOURCE=""
    fi
fi
if [[ -z $FACTS_FROM ]]; then
    src=$README_SRC
    [[ -z $src ]] && src=$(find_readme)
    if [[ -n $src ]]; then
        echo "Reading the README: $src"
        if readme_text=$(get_readme_text "$src") && [[ -n $readme_text ]]; then
            F_SOURCE=$src
            parse_readme "$readme_text"
            if [[ $(( ${#F_ADMINS[@]} + ${#F_USERS[@]} + ${#F_CRITICAL[@]} )) -gt 0 ]]; then FACTS_FROM="the README ($src)"; fi
        else
            echo "  The README could not be read (no internet?)."
        fi
    else
        echo "No README shortcut was found on a desktop or in /opt/CyberPatriot."
    fi
fi
if [[ -z $FACTS_FROM ]]; then
    if [[ $ASSUME_YES -eq 1 || ! -r /dev/tty ]]; then
        FACTS_FROM="nothing (the README could not be read)"
    else
        echo
        echo "The README could not be read automatically. Type what it says; separate names with commas."
        echo "Press Enter to skip a line you are not sure about."
        ask_list F_ADMINS   "Authorized administrators"
        ask_list F_USERS    "Authorized users (not the administrators)"
        ask_list F_CRITICAL "Critical services (for example: SSH, Apache, Samba, FTP)"
        ask_list F_SOFTWARE "Business software the README names"
        read -r -p "Default web browser: " F_BROWSER </dev/tty || F_BROWSER=""
        read -r -p "Display manager (for example lightdm, gdm3): " F_DM </dev/tty || F_DM=""
        F_DM=${F_DM,,}
        FACTS_FROM="your answers"
    fi
fi
echo
echo "What the README says, as this script understood it:"
fact_lines
if [[ $ASSUME_YES -eq 0 && -r /dev/tty ]]; then
    read -r -p "Press Enter if that matches the README, or type E to correct it in an editor: " answer </dev/tty || answer=""
    if [[ ${answer,,} == e* ]]; then
        save_config
        "${EDITOR:-nano}" "$CONFIG" </dev/tty >/dev/tty
        load_config
        FACTS_FROM="saved settings in $CONFIG"
        fact_lines
    fi
fi
save_config

AUTH_ADMINS=("${F_ADMINS[@]}")
AUTH_USERS=("${F_USERS[@]}")
ALL_AUTH=("${AUTH_ADMINS[@]}" "${AUTH_USERS[@]}")
HAVE_USERS=0;    [[ ${#ALL_AUTH[@]} -gt 0 ]] && HAVE_USERS=1
HAVE_CRITICAL=0; [[ ${#F_CRITICAL[@]} -gt 0 ]] && HAVE_CRITICAL=1
DEFAULT_BROWSER=${F_BROWSER,,}
[[ $DEFAULT_BROWSER == *chrome* ]] && DEFAULT_BROWSER=google-chrome
DISPLAY_MANAGER=$F_DM

# Critical services as key words. A service the README lists as critical is never reported as a lead.
crit_text=$(join_list "${F_CRITICAL[@]}"); crit_text=${crit_text,,}
declare -gA CRIT=()
crit_flag() { grep -qiE "$2" <<<"$crit_text" && CRIT[$1]=1; return 0; }
crit_flag ssh    'ssh'
crit_flag web    'apache|nginx|httpd|lighttpd|web ?server|(^|[^a-z])https?([^a-z]|$)|www|web ?site'
crit_flag smb    'samba|(^|[^a-z])smb([^a-z]|$)|file ?shar|file server|cifs'
crit_flag ftp    '(^|[^a-z])s?ftpd?([^a-z]|$)|vsftpd|proftpd|pure-ftpd'
crit_flag dns    '(^|[^a-z])dns([^a-z]|$)|bind'
crit_flag mail   'mail|smtp|imap|pop3|postfix|dovecot|exim'
crit_flag db     'sql|database|mariadb|postgres'
crit_flag print  'print|cups'
crit_flag nfs    '(^|[^a-z])nfs([^a-z]|$)'
crit_flag vnc    'vnc'
crit_flag rdp    'xrdp|remote desktop|(^|[^a-z])rdp([^a-z]|$)'
crit_flag telnet 'telnet'
crit_flag snmp   'snmp'
crit_flag dhcp   'dhcp'
crit_flag proxy  'squid|proxy'
crit_flag docker 'docker|container'
# ssh alone would also match "sftp"; that is fine: sftp runs inside sshd.
declare -gA CRIT_UNITS=(
    [ssh]="ssh sshd" [web]="apache2 nginx httpd lighttpd" [smb]="smbd nmbd smb nmb samba-ad-dc" [ftp]="vsftpd proftpd pure-ftpd"
    [dns]="named bind9" [mail]="postfix dovecot exim4" [db]="mariadb mysql mysqld postgresql" [print]="cups cups-browsed"
    [nfs]="nfs-server nfs-kernel-server rpcbind" [vnc]="x11vnc vncserver tightvncserver" [rdp]="xrdp" [telnet]="telnet inetd xinetd openbsd-inetd"
    [snmp]="snmpd" [dhcp]="isc-dhcp-server dhcpd" [proxy]="squid" [docker]="docker"
)
declare -gA CRIT_PORTS=(
    [ssh]="22" [web]="80 443 8080" [smb]="139 445" [ftp]="21" [dns]="53" [mail]="25 110 143 465 587 993 995" [db]="3306 5432"
    [print]="631" [nfs]="111 2049" [vnc]="5900" [rdp]="3389" [telnet]="23" [snmp]="161" [proxy]="3128"
)
CRITICAL_UNITS=(); NEED_PORTS=()
for flag in "${!CRIT[@]}"; do
    for u in ${CRIT_UNITS[$flag]:-}; do CRITICAL_UNITS+=("$u"); unset "RISKY_UNITS[$u]"; done
    for pt in ${CRIT_PORTS[$flag]:-}; do NEED_PORTS+=("$pt"); done
done
# When the README lists its critical services and SSH is not one of them, a running SSH server is a lead too.
if [[ $HAVE_CRITICAL -eq 1 && -z ${CRIT[ssh]:-} ]]; then
    RISKY_UNITS[ssh]="70|SSH server, and the README does not list SSH as a critical service"
    RISKY_UNITS[sshd]="70|SSH server, and the README does not list SSH as a critical service"
fi

# Package names the README names as business software
NAMED_REGEX=""
for name in "${F_SOFTWARE[@]}"; do
    rx=""
    for pair in "${KNOWN_SOFTWARE[@]}"; do
        pn=${pair%%:*}
        if [[ ${pn,,} == "${name,,}" ]]; then rx=${pair#*:}; fi
    done
    if [[ -z $rx ]]; then rx=$(tr '[:upper:]' '[:lower:]' <<<"$name" | sed -E 's/[^a-z0-9+.-]+/.?/g; s/[+.]/\\&/g'); fi
    [[ ${#rx} -ge 3 ]] && NAMED_REGEX="${NAMED_REGEX:+$NAMED_REGEX|}$rx"
done
is_named() { [[ -n $NAMED_REGEX && $1 =~ ($NAMED_REGEX) ]]; }
# Packages that belong to a critical service are never leads
declare -gA CRIT_PKGS=(
    [ssh]="openssh-.*" [web]="apache2.*|nginx.*|lighttpd.*|httpd.*" [smb]="samba.*" [ftp]="vsftpd|proftpd.*|pure-ftpd.*"
    [dns]="bind9.*|bind" [mail]="postfix.*|dovecot-.*|exim4.*" [db]="mariadb-server.*|mysql-server.*|postgresql.*"
    [print]="cups.*" [nfs]="nfs-kernel-server|nfs-utils|rpcbind" [vnc]="x11vnc|tightvncserver|tigervnc-.*" [rdp]="xrdp"
    [telnet]="telnetd|inetutils-telnetd|xinetd|openbsd-inetd" [snmp]="snmpd" [proxy]="squid" [docker]="docker.*"
)
CRIT_PKG_REGEX=""
for flag in "${!CRIT[@]}"; do
    [[ -n ${CRIT_PKGS[$flag]:-} ]] && CRIT_PKG_REGEX="${CRIT_PKG_REGEX:+$CRIT_PKG_REGEX|}${CRIT_PKGS[$flag]}"
done
is_critical_pkg() { [[ -n $CRIT_PKG_REGEX && $1 =~ ^($CRIT_PKG_REGEX)$ ]]; }
SVC_WHY="the README does not list it as a critical service"
[[ $HAVE_CRITICAL -eq 0 ]] && SVC_WHY="the critical services are not known: check the README before you disable it"
is_critical_unit() { in_list "${1%.service}" "${CRITICAL_UNITS[@]}"; }
}

# Turns the README facts into the settings the sections below use
apply_facts() {
    AUTH_ADMINS=("${F_ADMINS[@]+"${F_ADMINS[@]}"}")
    AUTH_USERS=("${F_USERS[@]+"${F_USERS[@]}"}")
    # admins whose README password is weak
    local text=${readme_text:-} who="" line pw
    [[ -z $text && -n $F_SOURCE ]] && text=$(get_readme_text "$F_SOURCE" 2>/dev/null)
    KNOWN_WEAK_ACCOUNTS=()
    while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
        if [[ $line =~ ^([A-Za-z][A-Za-z0-9_.-]{0,30})([[:space:]]*\(.*\))?$ ]]; then who=${BASH_REMATCH[1]}; continue; fi
        if [[ -n $who && $line =~ ^[Pp]assword[[:space:]]*:[[:space:]]*([^[:space:]]+) ]]; then
            pw=${BASH_REMATCH[1]}
            if in_list "$who" "${AUTH_ADMINS[@]+"${AUTH_ADMINS[@]}"}" && ! password_is_strong "$pw"; then KNOWN_WEAK_ACCOUNTS+=("$who"); fi
            who=""
        fi
    done <<<"$text"
    # services: drop critical ones; keep guarded ones when the critical list is unknown
    local keep=() u
    for u in "${SERVICES_TO_DISABLE[@]}"; do
        if in_list "$u" "${CRITICAL_UNITS[@]+"${CRITICAL_UNITS[@]}"}"; then continue; fi
        if (( ! HAVE_CRITICAL )) && in_list "$u" "${GUARDED_UNITS[@]}"; then continue; fi
        keep+=("$u")
    done
    SERVICES_TO_DISABLE=("${keep[@]+"${keep[@]}"}")
}

# =============================================================================
#  0. PRE-FLIGHT
# =============================================================================

preflight() {
    section "Pre-flight"
    log INFO "Mode: $( (( AUDIT )) && echo 'AUDIT ONLY (no changes)' || echo FIX )   Log: $LOG"

    local invoker=${SUDO_USER:-}
    [[ -z $invoker ]] && invoker=$(logname 2>/dev/null || true)
    [[ -z $invoker ]] && invoker=root
    local autologin
    autologin=$(grep -rhE '^[[:space:]]*autologin-user[[:space:]]*=' /etc/lightdm 2>/dev/null |
                tail -n1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//')
    [[ -z $autologin ]] && autologin=$(grep -hE '^[[:space:]]*AutomaticLogin[[:space:]]*=' /etc/gdm3/custom.conf /etc/gdm/custom.conf 2>/dev/null |
                tail -n1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//')
    PROTECTED=("$invoker")
    [[ -n $autologin && $autologin != "$invoker" ]] && PROTECTED+=("$autologin")
    INVOKER=$invoker
    log INFO "Run by '$invoker'. Auto-login account: '${autologin:-none}'. Their passwords are never changed."

    log INFO "README facts: ${#AUTH_ADMINS[@]} admins, ${#AUTH_USERS[@]} users; critical services: $(show "${F_CRITICAL[@]+"${F_CRITICAL[@]}"}"); software: $(show "${F_SOFTWARE[@]+"${F_SOFTWARE[@]}"}")"
    (( ${#KNOWN_WEAK_ACCOUNTS[@]} )) && log INFO "Admins with a weak README password: ${KNOWN_WEAK_ACCOUNTS[*]}"
    if (( HAVE_USERS )) && ! is_admin "$invoker" && (( ! FORCE )); then
        log FAIL "'$invoker' is not an authorized administrator in the README facts. Stopping so the script cannot lock you out. Run it with sudo from your own account, correct leads-config.txt, or use --force."
        exit 1
    fi
    (( HAVE_USERS )) || manual "The README user lists are not known, so no account, group or sudo entry was changed. Fill in admins and users in leads-config.txt and run again."
    (( HAVE_CRITICAL )) || manual "The critical services are not known, so server software that might be critical (web, FTP, Samba, databases, SSH ...) was left alone. Fill in critical_services in leads-config.txt and run again."

    if (( ! AUDIT && ! FORCE )); then
        echo
        echo "STOP. Before this script changes anything:"
        echo "  1. Read the whole README."
        echo "  2. Answer every Forensics Question on the Desktop. This script removes"
        echo "     users, packages and files that those questions may ask about."
        echo "  3. Take a VM snapshot."
        echo "  4. Keep this terminal open until you have tested sudo (and SSH) at the end."
        local answer
        read -r -p "Type YES to continue: " answer
        [[ $answer == YES ]] || { log INFO "Cancelled by operator."; exit 0; }
    fi

    local u
    case $PASSWORD_SCOPE in
        all)   for u in "${AUTH_ADMINS[@]}" "${AUTH_USERS[@]}"; do is_protected "$u" || PASSWORD_TARGETS+=("$u"); done ;;
        users) for u in "${AUTH_USERS[@]}" "${KNOWN_WEAK_ACCOUNTS[@]}"; do is_protected "$u" || PASSWORD_TARGETS+=("$u"); done ;;
        none)  ;;
    esac

    if (( ! AUDIT && ${#PASSWORD_TARGETS[@]} > 0 )); then
        local p1 p2
        while true; do
            read -r -s -p "New password for ${#PASSWORD_TARGETS[@]} accounts ($MIN_PASS_LEN+ chars with upper, lower, digit and symbol): " p1; echo
            read -r -s -p "Confirm password: " p2; echo
            if [[ $p1 != "$p2" ]]; then echo "Passwords do not match."; continue; fi
            if ! password_is_strong "$p1"; then echo "That password does not meet the policy this script is about to enforce."; continue; fi
            NEW_PASS=$p1
            break
        done
        log INFO "New password accepted. Write it down somewhere safe: it is not stored in the log."
    fi

    backup /etc/passwd /etc/shadow /etc/group /etc/gshadow /etc/sudoers /etc/sudoers.d \
           /etc/login.defs /etc/pam.d /etc/security /etc/ssh/sshd_config /etc/ssh/sshd_config.d \
           /etc/lightdm /etc/gdm3 /etc/sysctl.conf /etc/sysctl.d /etc/apt/sources.list /etc/apt/sources.list.d /etc/apt/apt.conf.d
    (( AUDIT )) || log INFO "Originals of edited files are saved under $BACKUP_DIR"
}

# =============================================================================
#  1. USER ACCOUNTS
# =============================================================================

_remove_user() {
    pkill -KILL -u "$1" 2>/dev/null
    sleep 1
    userdel "$1"
}
_remove_uid0_imposter() {
    sed -i -E "/^$1:/d" /etc/passwd /etc/shadow
}
_set_password() { printf '%s:%s\n' "$1" "$NEW_PASS" | chpasswd; }

users() {
    section "User accounts"
    local name uid shell home hash
    if (( ! HAVE_USERS )); then
        log WARN "README user lists unknown: accounts are only reported"
        while IFS=: read -r name _ uid _; do
            (( uid >= 1000 && uid < 65534 )) && review "Human account: $name (UID $uid). Compare with the README."
            [[ $uid == 0 && $name != root ]] && manual "Account '$name' has UID 0 (full root). Remove it unless the README authorizes it."
        done </etc/passwd
        return
    fi

    # Accounts with UID 0 that are not root
    while IFS=: read -r name _ uid _; do
        [[ $uid == 0 && $name != root ]] || continue
        if is_authorized "$name" || is_protected "$name"; then
            manual "Account '$name' has UID 0 (full root). It is an authorized account, so give it a normal UID by hand: usermod -u <new uid> $name"
        else
            change "Remove unauthorized UID 0 account '$name'" _remove_uid0_imposter "$name"
        fi
    done </etc/passwd

    # Unauthorized human accounts
    while IFS=: read -r name _ uid _ _ home shell; do
        (( uid >= 1000 && uid < 65534 )) || continue
        is_authorized "$name" && continue
        is_ccs "$name" && continue
        if is_protected "$name"; then
            log WARN "'$name' is not authorized but is the account in use; not removed"
            continue
        fi
        change "Remove unauthorized user '$name' (home $home is left on disk)" _remove_user "$name"
    done </etc/passwd

    # System accounts must not have a usable password
    while IFS=: read -r name _ uid _ _ home shell; do
        (( uid > 0 && uid < 1000 )) || continue
        is_authorized "$name" && continue
        hash=$(shadow_field "$name" 2)
        if [[ $hash != '!'* && $hash != '*'* ]]; then
            change "Lock system account '$name' (it has a usable or empty password)" passwd -l "$name"
        fi
        if [[ $shell != */nologin && $shell != */false && $shell != /bin/sync ]]; then
            review "System account '$name' (UID $uid) has login shell $shell"
        fi
    done </etc/passwd

    # Authorized accounts
    local today=$(( $(date +%s) / 86400 )) lastchg age cur_max cur_min cur_warn skip_max
    for name in "${AUTH_ADMINS[@]}" "${AUTH_USERS[@]}"; do
        if ! user_exists "$name"; then
            manual "Authorized account '$name' does not exist. Create it if the README or a Forensics Question asks for it."
            continue
        fi
        shell=$(getent passwd "$name" | cut -d: -f7)
        if [[ $shell == */nologin || $shell == */false ]]; then
            change "Give '$name' a login shell (was $shell; authorized users must be able to log in)" usermod -s /bin/bash "$name"
        fi

        hash=$(shadow_field "$name" 2)
        if in_list "$name" "${PASSWORD_TARGETS[@]+"${PASSWORD_TARGETS[@]}"}"; then
            change "Set a new strong password for '$name'" _set_password "$name"
        elif [[ -z $hash ]]; then
            manual "'$name' has NO password and was excluded from password changes. Set one: sudo passwd $name"
        elif [[ $hash == '!'* ]]; then
            review "Authorized account '$name' is locked (password hash starts with !)"
        elif [[ $hash == '$1$'* || $hash != '$'* ]]; then
            review "Authorized account '$name' has a weakly hashed password (MD5/DES); reset it"
        fi

        # password ageing
        cur_min=$(shadow_field "$name" 4); cur_max=$(shadow_field "$name" 5); cur_warn=$(shadow_field "$name" 6)
        skip_max=0
        if is_protected "$name"; then
            lastchg=$(shadow_field "$name" 3)
            if [[ $lastchg =~ ^[0-9]+$ ]] && (( lastchg > 0 )); then
                age=$(( today - lastchg ))
                if (( age >= PASS_MAX_DAYS - 2 )); then
                    skip_max=1
                    manual "Password for '$name' is $age days old. Its maximum age was NOT set, to avoid locking that account out. After changing that password run: sudo chage -M $PASS_MAX_DAYS $name"
                fi
            fi
        fi
        if [[ $cur_min == "$PASS_MIN_DAYS" && $cur_warn == "$PASS_WARN_AGE" && ( $cur_max == "$PASS_MAX_DAYS" || $skip_max == 1 ) ]]; then
            log OK "Password ageing for '$name' is set"
        elif (( skip_max )); then
            change "Set password ageing for '$name' (min $PASS_MIN_DAYS, warn $PASS_WARN_AGE)" chage -m "$PASS_MIN_DAYS" -W "$PASS_WARN_AGE" "$name"
        else
            change "Set password ageing for '$name' (min $PASS_MIN_DAYS, max $PASS_MAX_DAYS, warn $PASS_WARN_AGE)" \
                chage -m "$PASS_MIN_DAYS" -M "$PASS_MAX_DAYS" -W "$PASS_WARN_AGE" "$name"
        fi

        # home directory
        home=$(getent passwd "$name" | cut -d: -f6)
        if [[ -d $home ]]; then
            local mode owner
            mode=$(stat -c %a "$home"); owner=$(stat -c %U "$home")
            if (( (8#$mode & 8#027) != 0 )); then
                change "Tighten permissions on $home (was $mode)" chmod g-w,o-rwx "$home"
            fi
            [[ $owner == "$name" ]] || review "Home directory $home is owned by '$owner', not '$name'"
            [[ -s $home/.ssh/authorized_keys ]] && review "SSH authorized_keys present for '$name': $home/.ssh/authorized_keys"
            [[ -e $home/.rhosts ]] && change "Remove $home/.rhosts" rm -f "$home/.rhosts"
        fi
    done

    [[ -s /root/.ssh/authorized_keys ]] && review "root has SSH authorized_keys: /root/.ssh/authorized_keys (root must not log in)"
    [[ -e /etc/hosts.equiv ]] && { backup /etc/hosts.equiv; change "Remove /etc/hosts.equiv" rm -f /etc/hosts.equiv; }

    if awk -F: '$2 == "" { found=1 } END { exit !found }' /etc/passwd; then
        manual "/etc/passwd has an account with an empty password field (no 'x'). Run 'sudo pwconv' and set a password for it."
    fi
}

# =============================================================================
#  2. GROUPS AND SUDO
# =============================================================================

group_members() { getent group "$1" | cut -d: -f4 | tr ',' '\n' | sed '/^$/d'; }

_clean_sudoers_file() {  # file
    local f=$1 tmp admins
    admins=$(printf '%s\n' "${AUTH_ADMINS[@]}" | paste -sd'|')
    tmp=$(mktemp)
    awk -v admins="$admins" '
        BEGIN { n=split(admins, a, "|"); for (i=1; i<=n; i++) ok[a[i]]=1 }
        /^[[:space:]]*(#|$)/ || /[Cc]yber[Pp]atriot|CCS/ { print; next }
        /!authenticate/ { print "# removed by hardening script: " $0; next }
        {
            gsub(/NOPASSWD:[[:space:]]*/, "")
            first=$1
            if (first !~ /^(Defaults|root|%|@|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)/ && !(first in ok)) {
                print "# removed by hardening script: " $0; next
            }
            print
        }' "$f" >"$tmp" && cat "$tmp" >"$f"
    rm -f "$tmp"
}

_fix_sudoers() {
    local f
    for f in "$@"; do _clean_sudoers_file "$f"; done
    if ! visudo -c >/dev/null 2>&1; then
        echo "visudo -c failed after edit; restoring originals"
        for f in "$@"; do cp -a "$BACKUP_DIR$f" "$f"; done
        return 1
    fi
}

groups_and_sudo() {
    section "Groups and sudo"
    local m g name admins_re
    ensure_pkg sudo
    if (( ! HAVE_USERS )); then
        review "sudo group members: $(group_members sudo | tr '\n' ' ')"
        log WARN "README admin list unknown: sudo membership and sudoers were not changed"
        return
    fi

    # sudo group = exactly the authorized administrators
    for m in $(group_members sudo); do
        if is_admin "$m"; then log OK "'$m' is an authorized administrator"; continue; fi
        if is_protected "$m"; then log WARN "'$m' is the account in use; left in sudo"; continue; fi
        change "Remove '$m' from the sudo group (not an authorized administrator)" gpasswd -d "$m" sudo
    done
    for name in "${AUTH_ADMINS[@]}"; do
        user_exists "$name" || continue
        group_members sudo | grep -qx "$name" || change "Add authorized administrator '$name' to the sudo group" gpasswd -a "$name" sudo
    done

    # other groups that grant root-equivalent access
    for g in admin wheel adm root shadow disk docker lxd; do
        getent group "$g" >/dev/null || continue
        for m in $(group_members "$g"); do
            is_protected "$m" && continue
            if ! is_admin "$m"; then
                change "Remove '$m' from privileged group '$g'" gpasswd -d "$m" "$g"
            elif [[ $g == root || $g == shadow || $g == disk ]]; then
                review "Administrator '$m' is a member of group '$g', which no person normally needs"
            fi
        done
    done

    while IFS=: read -r name _ uid gid _; do
        [[ $gid == 0 && $name != root ]] && manual "Account '$name' has primary group root (GID 0). Fix with: usermod -g <own group> $name"
    done </etc/passwd

    # sudoers
    local files=() f bad=0
    for f in /etc/sudoers /etc/sudoers.d/*; do
        [[ -f $f ]] || continue
        [[ $(basename "$f") == README || $f == *~ || $(basename "$f") == *.* ]] && continue
        files+=("$f")
    done
    admins_re=$(printf '%s\n' "${AUTH_ADMINS[@]}" | paste -sd'|')
    for f in "${files[@]}"; do
        if grep -vE '^[[:space:]]*(#|$)|[Cc]yber[Pp]atriot|CCS' "$f" | grep -qE 'NOPASSWD|!authenticate'; then
            log WARN "$f lets sudo run without a password"; bad=1
        fi
        if grep -vE '^[[:space:]]*(#|$)|[Cc]yber[Pp]atriot|CCS' "$f" |
           awk -v re="^(Defaults.*|root|%.*|@.*|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias|${admins_re})$" '$1 !~ re { found=1 } END { exit !found }'; then
            log WARN "$f grants sudo to an account that is not an authorized administrator"; bad=1
        fi
        while read -r line; do review "sudoers ($f): $line"; done < <(
            grep -vE '^[[:space:]]*(#|$)' "$f" | grep -E '^[[:space:]]*%' | grep -vE '^[[:space:]]*%sudo[[:space:]]' )
        while read -r line; do review "sudoers ($f): $line"; done < <(
            grep -vE '^[[:space:]]*(#|$)' "$f" | grep -E '!env_reset|visiblepw|timestamp_timeout|!requiretty|env_keep.*LD_' )
    done
    if (( bad )); then
        change "Clean sudoers: require a password, drop entries for non-administrators" _fix_sudoers "${files[@]}"
    else
        log OK "sudoers requires a password and only names authorized administrators"
    fi
    if ! grep -rqsE '^[[:space:]]*%sudo[[:space:]]+ALL' /etc/sudoers /etc/sudoers.d; then
        manual "/etc/sudoers has no '%sudo ALL=(ALL:ALL) ALL' line. Add it with visudo or administrators cannot use sudo."
    fi

    # README: nobody logs in as root. Lock root only when sudo is known to work.
    local root_state; root_state=$(passwd -S root 2>/dev/null | awk '{print $2}')
    if [[ $root_state == L ]]; then
        log OK "root password is locked"
    elif [[ -z ${SUDO_USER:-} ]]; then
        manual "root password is not locked, and this script was not started with sudo, so it was left alone. From your own account run: sudo passwd -l root"
    elif ! visudo -c >/dev/null 2>&1; then
        manual "sudoers does not validate (visudo -c), so the root password was NOT locked. Fix sudoers, then: sudo passwd -l root"
    else
        change "Lock the root password (administrators use sudo)" passwd -l root
    fi
}

# =============================================================================
#  3. PASSWORD POLICY AND ACCOUNT LOCKOUT
# =============================================================================

_strip_nullok() { sed -i -E '/pam_unix\.so/ s/[[:space:]]+nullok(_secure)?//g' "$@"; }
_add_remember() { sed -i -E "/^password.*pam_unix\.so/ { /remember=/! s/\$/ remember=$PASS_REMEMBER/ }" /etc/pam.d/common-password
                  touch /etc/security/opasswd; chmod 600 /etc/security/opasswd; }

_pam_update() {
    cat >/usr/share/pam-configs/faillock <<'EOF'
Name: Lock accounts after repeated failed logins (pam_faillock)
Default: yes
Priority: 0
Auth-Type: Primary
Auth:
	[default=die]	pam_faillock.so authfail
EOF
    cat >/usr/share/pam-configs/faillock_notify <<'EOF'
Name: Check and reset the failed-login counter (pam_faillock)
Default: yes
Priority: 1024
Auth-Type: Primary
Auth:
	requisite	pam_faillock.so preauth
Account-Type: Primary
Account:
	required	pam_faillock.so
EOF
    pam-auth-update --enable faillock faillock_notify
    if ! grep -q pam_faillock /etc/pam.d/common-auth || ! grep -q pam_pwquality /etc/pam.d/common-password; then
        echo "PAM files have local modifications; regenerating them with pam-auth-update --force"
        pam-auth-update --force --enable faillock faillock_notify
    fi
    # sanity: never leave a PAM stack that cannot authenticate
    if ! grep -q 'pam_unix\.so' /etc/pam.d/common-auth || ! grep -q pam_faillock /etc/pam.d/common-auth; then
        echo "common-auth looks wrong after pam-auth-update; restoring original PAM files"
        cp -a "$BACKUP_DIR/etc/pam.d/." /etc/pam.d/
        rm -f /usr/share/pam-configs/faillock /usr/share/pam-configs/faillock_notify
        return 1
    fi
}

password_policy() {
    section "Password policy and account lockout"
    set_def /etc/login.defs PASS_MAX_DAYS "$PASS_MAX_DAYS"
    set_def /etc/login.defs PASS_MIN_DAYS "$PASS_MIN_DAYS"
    set_def /etc/login.defs PASS_WARN_AGE "$PASS_WARN_AGE"
    set_def /etc/login.defs ENCRYPT_METHOD YESCRYPT
    set_def /etc/login.defs UMASK 027
    set_def /etc/login.defs LOGIN_RETRIES 5

    ensure_pkg libpam-pwquality "password complexity"
    local q=/etc/security/pwquality.conf
    if [[ -e $q ]] || (( ! AUDIT )); then
        set_kv $q minlen "$MIN_PASS_LEN"
        set_kv $q dcredit -1
        set_kv $q ucredit -1
        set_kv $q lcredit -1
        set_kv $q ocredit -1
        set_kv $q difok 3
        set_kv $q maxrepeat 3
        set_kv $q dictcheck 1
        set_kv $q usercheck 1
    else
        log WOULD "Configure $q (minimum length $MIN_PASS_LEN, all four character classes)"
    fi

    # Module set first (pam-auth-update), then the hand edits it would refuse to keep.
    local regen=0
    grep -q pam_faillock /etc/pam.d/common-auth 2>/dev/null || regen=1
    grep -q pam_pwquality /etc/pam.d/common-password 2>/dev/null || regen=1
    if (( regen )); then
        change "PAM: enable password complexity (pam_pwquality) and account lockout (pam_faillock)" _pam_update
    else
        log OK "PAM password complexity and account lockout modules are enabled"
    fi

    if grep -qE 'pam_unix\.so.*nullok' /etc/pam.d/common-auth /etc/pam.d/common-password 2>/dev/null; then
        change "PAM: stop accepting empty passwords (remove nullok)" _strip_nullok /etc/pam.d/common-auth /etc/pam.d/common-password
    else
        log OK "PAM does not accept empty passwords"
    fi

    if grep -E '^password.*pam_unix\.so' /etc/pam.d/common-password 2>/dev/null | grep -q 'remember='; then
        log OK "PAM remembers previous passwords"
    else
        change "PAM: remember the last $PASS_REMEMBER passwords" _add_remember
    fi

    local fl=/etc/security/faillock.conf
    set_kv $fl deny "$LOCKOUT_DENY"
    set_kv $fl unlock_time "$LOCKOUT_SECONDS"
    set_kv $fl fail_interval 900

    if grep -qE '^\*[[:space:]]+hard[[:space:]]+core[[:space:]]+0' /etc/security/limits.conf 2>/dev/null; then
        log OK "Core dumps are disabled"
    else
        backup /etc/security/limits.conf
        change "Disable core dumps in /etc/security/limits.conf" sh -c "printf '*\thard\tcore\t0\n' >>/etc/security/limits.conf"
    fi
}

# =============================================================================
#  4. SSH (critical service: keep it, harden it)
# =============================================================================

_sshd_comment_keys() {  # file extra-keys...  -> stdout; comments out managed directives
    local src=$1; shift
    local keys
    keys=$( { printf '%s\n' "${SSHD_SETTINGS[@]}" | awk '{print $1}'; printf '%s\n' "$@"; } | tr 'A-Z' 'a-z' | paste -sd'|')
    awk -v keys="$keys" -v b="$SSHD_BEGIN" -v e="$SSHD_END" '
        BEGIN { n=split(keys, a, "|"); for (i=1; i<=n; i++) want[a[i]]=1 }
        $0 == b { skip=1; next }
        $0 == e { skip=0; eat=1; next }
        skip { next }
        eat { eat=0; if ($0 == "") next }
        { k=tolower($1); sub(/=.*/, "", k)
          if (k in want) print "#" $0 "   # disabled by hardening script"; else print }' "$src"
}

_sshd_build() {  # src -> stdout: managed block first, then the cleaned original
    printf '%s\n' "$SSHD_BEGIN"
    printf '%s\n' "${SSHD_SETTINGS[@]}"
    if (( SSH_RESTRICT_TO_AUTHORIZED )); then
        (( HAVE_USERS )) && printf 'AllowUsers %s\n' "${AUTH_ADMINS[*]} ${AUTH_USERS[*]}"
    fi
    printf '%s\n\n' "$SSHD_END"
    _sshd_comment_keys "$1" "${SSHD_ALSO_DISABLE[@]}"
}

_apply_sshd() {
    local cfg=/etc/ssh/sshd_config tmp f
    tmp=$(mktemp)
    _sshd_build "$cfg" >"$tmp"
    for f in /etc/ssh/sshd_config.d/*.conf; do
        [[ -f $f ]] || continue
        _sshd_comment_keys "$f" "${SSHD_ALSO_DISABLE[@]}" >"$f.new" && cat "$f.new" >"$f"
        rm -f "$f.new"
    done
    if ! sshd -t -f "$tmp"; then
        echo "new sshd_config failed validation; restoring originals"
        rm -f "$tmp"
        [[ -d $BACKUP_DIR/etc/ssh/sshd_config.d ]] && cp -a "$BACKUP_DIR/etc/ssh/sshd_config.d/." /etc/ssh/sshd_config.d/
        return 1
    fi
    cat "$tmp" >"$cfg"
    rm -f "$tmp"
    chown root:root "$cfg"; chmod 600 "$cfg"
    systemctl reload ssh 2>/dev/null || systemctl restart ssh
}

ssh_service() {
    section "SSH"
    local critical=0
    [[ -n ${CRIT[ssh]:-} ]] && critical=1
    if (( critical )); then
        ensure_pkg openssh-server "critical service"
    elif ! command -v sshd >/dev/null 2>&1; then
        log OK "No SSH server is installed (the README does not list SSH as critical)"
        return
    fi
    if ! command -v sshd >/dev/null 2>&1; then
        log WARN "sshd is not installed yet; SSH settings will be applied once it is"
        return
    fi
    if (( ! critical && HAVE_CRITICAL )); then
        disable_unit ssh
        disable_unit sshd
        review "An SSH server is installed but the README does not list SSH as a critical service. It was disabled; purge it if the README does not need it: sudo apt purge openssh-server"
    fi
    (( AUDIT )) || mkdir -p /run/sshd

    local need=0 line key want have effective
    effective=$(sshd -T 2>/dev/null)
    for line in "${SSHD_SETTINGS[@]}"; do
        key=${line%% *}; want=${line#* }
        have=$(awk -v k="${key,,}" '$1 == k { print $2; exit }' <<<"$effective")
        if [[ ${have,,} == "${want,,}" ]]; then
            log OK "sshd: $key $want"
        else
            log WARN "sshd: $key is '${have:-unknown}', should be '$want'"; need=1
        fi
    done
    grep -qxF "$SSHD_BEGIN" /etc/ssh/sshd_config 2>/dev/null || need=1
    if grep -qiE '^[[:space:]]*(DenyUsers|DenyGroups|AllowGroups)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
        log WARN "sshd has Deny/Allow group or user rules that may block authorized users"; need=1
    fi
    if (( need )); then
        change "Write hardened SSH settings to /etc/ssh/sshd_config (validated with sshd -t)" _apply_sshd
    fi

    (( critical )) && enable_unit ssh.service
    local f mode
    for f in /etc/ssh/ssh_host_*_key; do
        [[ -f $f ]] || continue
        mode=$(stat -c %a "$f")
        [[ $mode == 600 ]] || change "Restrict SSH host key $f (was $mode)" chmod 600 "$f"
    done
}

# =============================================================================
#  5. FIREWALL (UFW only)
# =============================================================================

firewall() {
    section "Firewall (UFW)"
    ensure_pkg ufw "firewall"
    local other
    for other in firewalld nftables-persistent iptables-persistent; do
        pkg_installed "$other" && review "Another firewall package is installed: $other (this script manages UFW; keep only one firewall)"
    done
    disable_unit firewalld
    if ! command -v ufw >/dev/null 2>&1; then
        log WARN "ufw is not installed yet; firewall rules will be applied once it is"
        return
    fi

    local port status pt keep_re
    port=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }'); port=${port:-22}
    status=$(ufw status verbose 2>/dev/null)

    local need=()
    [[ -n ${CRIT[ssh]:-} ]] && need+=("$port/tcp")
    for flag in "${!CRIT[@]}"; do
        [[ $flag == ssh ]] && continue
        for pt in ${CRIT_PORTS[$flag]:-}; do need+=("$pt"); done
    done
    for pt in "${need[@]+"${need[@]}"}"; do
        if grep -qE "^${pt%/tcp}(/tcp)?[[:space:]]+ALLOW" <<<"$status"; then log OK "UFW allows $pt (critical service)"
        else change "UFW: allow $pt (critical service)" ufw allow "$pt"; fi
    done
    keep_re="OpenSSH"
    for pt in "${need[@]+"${need[@]}"}"; do keep_re+="|^${pt%/tcp}(/tcp)?[[:space:]]|^${pt%/tcp}(/tcp)? \\(v6\\)"; done
    if grep -q 'deny (incoming), allow (outgoing)' <<<"$status"; then
        log OK "UFW default policy is deny incoming / allow outgoing"
    else
        change "UFW: default deny incoming" ufw default deny incoming
        change "UFW: default allow outgoing" ufw default allow outgoing
    fi
    if grep -qE '^Logging: on' <<<"$status"; then log OK "UFW logging is on"; else change "UFW: turn logging on" ufw logging on; fi
    if grep -q '^Status: active' <<<"$status"; then
        log OK "UFW is active"
    else
        change "UFW: enable the firewall" ufw --force enable
    fi
    while read -r line; do
        [[ -n $line ]] && review "UFW rule: $line"
    done < <(ufw status 2>/dev/null | awk 'NR > 4' | grep -vE "$keep_re")
}

# =============================================================================
#  6. KERNEL / NETWORK PARAMETERS
# =============================================================================

_apply_sysctl() {
    local kv dropin=/etc/sysctl.d/99-zz-hardening.conf
    : >"$dropin"
    for kv in "${SYSCTL_SETTINGS[@]}"; do
        sysctl -n "${kv%%=*}" >/dev/null 2>&1 || continue
        printf '%s = %s\n' "${kv%%=*}" "${kv#*=}" >>"$dropin"
        _set_kv /etc/sysctl.conf "${kv%%=*}" "${kv#*=}"
    done
    sysctl --system >/dev/null 2>&1
    sysctl -p "$dropin"
}

kernel_params() {
    section "Kernel and network parameters"
    local kv key want have need=0 unsaved=0
    for kv in "${SYSCTL_SETTINGS[@]}"; do
        key=${kv%%=*}; want=${kv#*=}
        have=$(sysctl -n "$key" 2>/dev/null)
        if [[ -z $have ]]; then continue; fi
        if [[ $have != "$want" ]]; then
            log WARN "sysctl $key is $have, should be $want"; need=1
        elif [[ $(get_kv /etc/sysctl.conf "$key") != "$want" ]]; then
            unsaved=$((unsaved + 1)); need=1
        else
            log OK "sysctl $key = $want"
        fi
    done
    (( unsaved )) && log WARN "$unsaved sysctl settings are correct right now but not saved in /etc/sysctl.conf"
    if (( need )); then
        backup /etc/sysctl.conf
        change "Write and load hardened sysctl settings (/etc/sysctl.conf and /etc/sysctl.d/99-zz-hardening.conf)" _apply_sysctl
    fi
    if [[ $(systemctl is-enabled ctrl-alt-del.target 2>/dev/null) == masked ]]; then
        log OK "Ctrl+Alt+Del reboot is disabled"
    else
        change "Disable Ctrl+Alt+Del reboot" systemctl mask ctrl-alt-del.target
    fi
}

# =============================================================================
#  7. SERVICES
# =============================================================================

services() {
    section "Services"
    local s
    for s in "${SERVICES_TO_DISABLE[@]}"; do disable_unit "$s"; done
    if [[ -z ${CRIT[print]:-} && $(systemctl is-active cups.service 2>/dev/null) == active ]]; then
        review "CUPS (printing) is running. Left alone in case this workstation prints; disable it if not: systemctl disable --now cups cups-browsed"
    fi
    ensure_pkg auditd "system auditing"
    systemctl cat auditd.service >/dev/null 2>&1 && enable_unit auditd.service
    if systemctl cat apparmor.service >/dev/null 2>&1; then
        if [[ $(systemctl is-enabled apparmor.service 2>/dev/null) == enabled ]]; then
            log OK "AppArmor is enabled"
        else
            change "Enable AppArmor" systemctl enable --now apparmor.service
        fi
    fi

    local flag u found running first
    for flag in "${!CRIT[@]}"; do
        found=0; running=0; first=""
        for u in ${CRIT_UNITS[$flag]:-}; do
            systemctl cat "$u.service" >/dev/null 2>&1 || continue
            found=1; [[ -z $first ]] && first=$u
            [[ $(systemctl is-active "$u.service" 2>/dev/null) == active ]] && running=1
        done
        [[ $flag == ssh ]] && continue
        if (( ! found )); then
            manual "The README lists a critical service ($flag), but no matching service is installed. Install it."
        elif (( ! running )); then
            change "Start critical service $first" systemctl enable --now "$first.service"
        else
            log OK "Critical service ($flag) is running"
        fi
    done

    local unit exec_line
    for unit in /etc/systemd/system/*.service; do
        [[ -f $unit && ! -L $unit ]] || continue
        is_ccs "$unit" && continue
        pkg_owns "$unit" && continue
        exec_line=$(grep -m1 -E '^ExecStart=' "$unit")
        is_ccs "$exec_line" && continue
        review "Service not from any Debian package: $unit ($exec_line) [$(systemctl is-enabled "$(basename "$unit")" 2>/dev/null)]"
    done
}

# =============================================================================
#  8. SOFTWARE: sources, prohibited packages, updates, default browser
# =============================================================================

_add_sources() { printf '%s\n' "$@" >>/etc/apt/sources.list; }

_purge_pkg() { apt_do purge "$1"; }

_auto_updates() {
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
EOF
    local f
    for f in /etc/apt/apt.conf.d/*; do
        [[ -f $f && $f != */20auto-upgrades ]] || continue
        sed -i -E 's/^([[:space:]]*APT::Periodic::(Update-Package-Lists|Unattended-Upgrade|Download-Upgradeable-Packages)[[:space:]]+)"0"/\1"1"/' "$f"
    done
}

# README browser -> binary, desktop file and package (set by find_browser)
BROWSER_BIN=""; BROWSER_DESKTOP=""; BROWSER_PKG=""
find_browser() {
    local b=$DEFAULT_BROWSER cand d
    BROWSER_BIN=""; BROWSER_DESKTOP=""; BROWSER_PKG=""
    [[ -z $b ]] && return 1
    case $b in
        chromium)      cand="chromium chromium-browser" ;;
        firefox)       cand="firefox firefox-esr" ;;
        google-chrome) cand="google-chrome google-chrome-stable" ;;
        *)             cand="$b $b-browser" ;;
    esac
    for d in $cand; do
        [[ -z $BROWSER_PKG ]] && apt-cache show "$d" >/dev/null 2>&1 && BROWSER_PKG=$d
        if [[ -z $BROWSER_BIN ]] && command -v "$d" >/dev/null 2>&1; then BROWSER_BIN=$(command -v "$d"); fi
    done
    for d in $cand; do
        if [[ -f /usr/share/applications/$d.desktop ]]; then BROWSER_DESKTOP=$d.desktop; break; fi
        if [[ -f /var/lib/snapd/desktop/applications/${d}_$d.desktop ]]; then BROWSER_DESKTOP=${d}_$d.desktop; break; fi
    done
    [[ -z $BROWSER_PKG ]] && BROWSER_PKG=${cand%% *}
    return 0
}

_default_browser() {
    local desktop=$BROWSER_DESKTOP f key home name
    name=$(basename "$BROWSER_BIN")
    update-alternatives --set x-www-browser "$BROWSER_BIN" 2>/dev/null ||
        update-alternatives --install /usr/bin/x-www-browser x-www-browser "$BROWSER_BIN" 200
    update-alternatives --set gnome-www-browser "$BROWSER_BIN" 2>/dev/null || true
    mkdir -p /etc/xdg
    f=/etc/xdg/mimeapps.list
    touch "$f"
    for key in x-scheme-handler/http x-scheme-handler/https text/html x-scheme-handler/about x-scheme-handler/unknown; do
        _set_ini "$f" "Default Applications" "$key" "$desktop"
    done
    if [[ -d /etc/xdg/xfce4 ]]; then
        touch /etc/xdg/xfce4/helpers.rc
        sed -i -E '/^WebBrowser=/d' /etc/xdg/xfce4/helpers.rc
        echo "WebBrowser=$name" >>/etc/xdg/xfce4/helpers.rc
    fi
    while IFS=: read -r _ _ uid _ _ home _; do
        (( uid >= 1000 && uid < 65534 )) || continue
        f=$home/.config/mimeapps.list
        [[ -f $f ]] && sed -i -E "s#^(x-scheme-handler/https?|text/html)=.*#\1=$desktop#" "$f"
        f=$home/.config/xfce4/helpers.rc
        [[ -f $f ]] && sed -i -E "s/^WebBrowser=.*/WebBrowser=$name/" "$f"
    done </etc/passwd
    return 0
}

apt_sources() {
    section "Software sources"
    local active missing=() c=$OS_CODENAME
    active=$(cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null | grep -vE '^[[:space:]]*(#|$)')
    if [[ -z $c ]]; then manual "The release codename is unknown, so the package sources were not checked."; return; fi
    has_suite() { grep -qE "(^deb[[:space:]].*[[:space:]]$1([[:space:]]|$))|(^Suites:.*(^|[[:space:]])$1([[:space:]]|$))" <<<"$active"; }
    case $OS_ID in
        debian)
            has_suite "$c"          || missing+=("deb http://deb.debian.org/debian $c main")
            has_suite "$c-security" || missing+=("deb http://security.debian.org/debian-security $c-security main")
            has_suite "$c-updates"  || missing+=("deb http://deb.debian.org/debian $c-updates main") ;;
        ubuntu)
            has_suite "$c"          || missing+=("deb http://archive.ubuntu.com/ubuntu $c main restricted universe")
            has_suite "$c-security" || missing+=("deb http://security.ubuntu.com/ubuntu $c-security main restricted universe")
            has_suite "$c-updates"  || missing+=("deb http://archive.ubuntu.com/ubuntu $c-updates main restricted universe") ;;
        *)
            review "Package sources on $OS_NAME were not checked automatically. Make sure the official main, security and updates sources are enabled."
            return ;;
    esac
    if (( ${#missing[@]} )); then
        change "Add missing official $OS_NAME sources (${#missing[@]}: main / security / updates)" _add_sources "${missing[@]}"
    else
        log OK "Official main, security and updates sources are present"
    fi
    while read -r line; do
        [[ -n $line ]] && review "Non-standard APT source: $line"
    done < <(grep -E '^(deb|deb-src|URIs:)' <<<"$active" | grep -vE 'debian\.org|ubuntu\.com|linuxmint\.com|canonical\.com' )
}

software() {
    section "Prohibited packages"
    local pkg sim extra r found=0
    while read -r pkg; do
        [[ $pkg =~ $PROHIBITED_PKG_REGEX ]] || continue
        is_ccs "$pkg" && continue
        if is_named "$pkg" || is_critical_pkg "$pkg"; then log OK "'$pkg' is kept: the README names it"; continue; fi
        found=1
        sim=$(apt-get -s purge "$pkg" 2>/dev/null | awk '/^(Purg|Remv) / { print $2 }')
        extra=""
        for r in $sim; do
            [[ $r == "$pkg" ]] && continue
            if [[ $r =~ $PROHIBITED_PKG_REGEX ]] && ! is_named "$r" && ! is_critical_pkg "$r"; then continue; fi
            extra+="$r "
        done
        if [[ -n $extra ]]; then
            manual "Prohibited package '$pkg' was NOT removed automatically because that would also remove: $extra. Check, then: sudo apt purge $pkg"
        else
            change "Purge prohibited package '$pkg'" _purge_pkg "$pkg"
        fi
    done < <(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1 == "ii" { print $2 }')
    (( found )) || log OK "No known prohibited packages are installed"

    local locals=()
    mapfile -t locals < <(apt list --installed 2>/dev/null | awk -F/ '/\[.*local.*\]/ { print $1 }')
    if (( ${#locals[@]} > 25 )); then
        review "${#locals[@]} installed packages match no configured repository. The package lists are probably stale; after 'apt update' check: apt list --installed | grep local"
    else
        for pkg in "${locals[@]+"${locals[@]}"}"; do
            is_ccs "$pkg" || review "Package not from a configured repository (installed by hand?): $pkg"
        done
    fi

    section "Updates and default browser"
    if [[ -f /etc/apt/apt.conf.d/20auto-upgrades ]] &&
       ! grep -rhsE '^[[:space:]]*APT::Periodic::(Update-Package-Lists|Unattended-Upgrade)[[:space:]]+"0"' /etc/apt/apt.conf.d >/dev/null &&
       grep -qsE 'Unattended-Upgrade[[:space:]]+"1"' /etc/apt/apt.conf.d/20auto-upgrades; then
        log OK "Automatic updates are enabled"
    else
        change "Enable daily automatic updates" _auto_updates
    fi
    ensure_pkg unattended-upgrades "automatic security updates"
    if find_browser; then ensure_pkg "$BROWSER_PKG" "README default browser"; find_browser; fi

    if (( SKIP_UPGRADE )); then
        manual "Updates were skipped. Run: sudo apt update && sudo apt upgrade"
    elif (( AUDIT )); then
        local n; n=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ')
        if (( n > 0 )); then log WOULD "Upgrade $n packages to their latest versions (count is from the last 'apt update')"; else log OK "No pending package upgrades (as of the last 'apt update')"; fi
    elif apt_ready; then
        log INFO "Upgrading packages; this can take several minutes..."
        change "Upgrade all packages to their latest versions" apt_do upgrade
        if command -v snap >/dev/null 2>&1; then change "Refresh snap packages" snap refresh; fi
    fi

    if [[ -z $DEFAULT_BROWSER ]]; then
        review "The README default browser is not known; the default browser was not changed."
    elif (( AUDIT )) && [[ -z $BROWSER_BIN ]]; then
        log WOULD "Make $DEFAULT_BROWSER the default browser once it is installed"
    elif [[ -z $BROWSER_BIN || -z $BROWSER_DESKTOP ]]; then
        manual "The README default browser ($DEFAULT_BROWSER) could not be found after installing it. Install it and make it the default (Settings > Default Applications)."
    else
        local cur; cur=$(update-alternatives --query x-www-browser 2>/dev/null | awk '/^Value:/ { print $2 }')
        if [[ $cur == "$BROWSER_BIN" && $(get_ini /etc/xdg/mimeapps.list "Default Applications" x-scheme-handler/https) == "$BROWSER_DESKTOP" ]]; then
            log OK "$DEFAULT_BROWSER is the system default browser"
        else
            backup /etc/xdg/mimeapps.list
            change "Make $DEFAULT_BROWSER the default browser system-wide and in existing user settings" _default_browser
        fi
        manual "Log in to the desktop and confirm $DEFAULT_BROWSER opens for web links (Settings > Default Applications). A desktop session can override the system default."
    fi
}

# =============================================================================
#  9. DISPLAY MANAGER (the one the README names)
# =============================================================================

_set_default_dm() {  # display manager name
    local bin; bin=$(command -v "$1" || echo "/usr/sbin/$1")
    echo "$bin" >/etc/X11/default-display-manager
    ln -sf "/lib/systemd/system/$1.service" /etc/systemd/system/display-manager.service
    systemctl daemon-reload
}

_gdm_no_guest() {
    local f=$1
    _set_ini "$f" daemon TimedLoginEnable false
}

display_manager() {
    section "Display manager"
    local want=${DISPLAY_MANAGER:-} cur
    cur=$(basename "$(cat /etc/X11/default-display-manager 2>/dev/null)" 2>/dev/null)
    log INFO "Display manager in use: ${cur:-none}; README: ${want:-not known}"
    if [[ -n $want && ${cur%3} != "${want%3}" ]]; then
        if pkg_installed "$want"; then
            backup /etc/X11/default-display-manager
            change "Set $want as the default display manager (takes effect after reboot)" _set_default_dm "$want"
        else
            manual "The README says the display manager must be $want, but it is not installed. Install it: sudo apt install $want"
        fi
    fi
    if pkg_installed lightdm; then
        local conf=/etc/lightdm/lightdm.conf
        set_ini $conf "Seat:*" allow-guest false
        set_ini $conf "Seat:*" greeter-hide-users true
        set_ini $conf "Seat:*" greeter-show-manual-login true
        set_ini $conf "Seat:*" greeter-allow-guest false
        local f
        for f in /etc/lightdm/lightdm.conf.d/*.conf /usr/share/lightdm/lightdm.conf.d/*.conf; do
            [[ -f $f ]] || continue
            grep -qE '^[[:space:]]*(allow-guest|autologin-guest)[[:space:]]*=[[:space:]]*true' "$f" && review "LightDM drop-in enables guest access: $f"
        done
    fi
    local g
    for g in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
        [[ -f $g ]] || continue
        if grep -qiE '^[[:space:]]*TimedLoginEnable[[:space:]]*=[[:space:]]*true' "$g"; then
            backup "$g"
            change "GDM: turn off timed (automatic guest) login in $g" _gdm_no_guest "$g"
        else
            log OK "GDM timed login is off ($g)"
        fi
    done
}

# =============================================================================
# 10. FILE PERMISSIONS
# =============================================================================

fix_perm() {  # path mode owner:group
    [[ -e $1 ]] || return 0
    local cur; cur="$(stat -c '%a %U:%G' "$1")"
    if [[ $cur == "$2 $3" ]]; then log OK "$1 is $2 $3"; return 0; fi
    change "Set $1 to $2 $3 (was $cur)" sh -c "chown $3 '$1' && chmod $2 '$1'"
}

permissions() {
    section "File permissions"
    fix_perm /etc/passwd   644 root:root
    fix_perm /etc/passwd-  644 root:root
    fix_perm /etc/group    644 root:root
    fix_perm /etc/group-   644 root:root
    fix_perm /etc/shadow   640 root:shadow
    fix_perm /etc/shadow-  640 root:shadow
    fix_perm /etc/gshadow  640 root:shadow
    fix_perm /etc/gshadow- 640 root:shadow
    fix_perm /etc/sudoers  440 root:root
    fix_perm /etc/crontab  600 root:root
    fix_perm /etc/ssh/sshd_config 600 root:root

    local f base
    while IFS= read -r -d '' f; do
        change "Remove world-write permission from $f" chmod o-w "$f"
    done < <(find /etc -xdev -type f -perm -0002 -print0 2>/dev/null)

    while IFS= read -r -d '' f; do
        is_ccs "$f" && continue
        base=$(basename "$f")
        if [[ $base =~ $SUID_NEVER ]]; then
            change "Remove set-uid/set-gid bit from $f (a shell, interpreter or editor must never have it)" chmod ug-s "$f"
        elif ! pkg_owns "$f"; then
            review "Set-uid/set-gid file not from any Debian package: $f"
        fi
    done < <(find / -xdev \( -perm -4000 -o -perm -2000 \) -type f -print0 2>/dev/null)

    [[ -s /etc/ld.so.preload ]] && review "/etc/ld.so.preload is not empty (libraries forced into every program): $(tr '\n' ' ' </etc/ld.so.preload)"
}

# =============================================================================
# 11. PROHIBITED FILES
# =============================================================================

_quarantine() {
    mkdir -p "$QUARANTINE_DIR" && chmod 700 "$QUARANTINE_DIR" || return 1
    local flat=${1//\//__}
    mv -f -- "$1" "$QUARANTINE_DIR/$flat"
}

remove_prohibited() {  # file reason
    if (( DELETE_PROHIBITED )); then
        change "Delete $2: $1" rm -f -- "$1"
    else
        change "Quarantine $2: $1" _quarantine "$1"
    fi
}

file_scan() {
    section "Prohibited files (this scan can take a minute)"
    local roots=() r f name ext
    for r in "${SCAN_ROOTS[@]}"; do [[ -d $r ]] && roots+=("$r"); done
    (( ${#roots[@]} )) || return 0
    while IFS= read -r -d '' f; do
        is_ccs "$f" && continue
        name=${f##*/}
        ext=""; [[ $name == *.* ]] && ext=${name##*.}; ext=${ext,,}
        if [[ $ext =~ $MEDIA_EXT_REGEX ]]; then
            remove_prohibited "$f" "non-work media file"
        elif [[ ${name,,} =~ passw|credential|shadow|hash ]]; then
            review "File name suggests stored credentials: $f"
        elif [[ $ext =~ $REVIEW_EXT_REGEX ]]; then
            review "Check this file: $f"
        fi
    done < <(find "${roots[@]}" \
                \( -path /opt/CyberPatriot -o -path "$QUARANTINE_DIR" -o -name .cache -o -name .config \
                   -o -name .mozilla -o -path '*/.local/lib' -o -path '*/.local/share/icons' \
                   -o -name snap -o -name .git \) -prune \
                -o -type f -print0 2>/dev/null)

    roots=()
    for r in "${REVIEW_ROOTS[@]}"; do [[ -d $r ]] && roots+=("$r"); done
    (( ${#roots[@]} )) || return 0
    while IFS= read -r -d '' f; do
        name=${f##*/}
        ext=""; [[ $name == *.* ]] && ext=${name##*.}; ext=${ext,,}
        [[ $ext =~ $MEDIA_EXT_REGEX ]] && review "Media file outside the home directories (remove it if it is not part of installed software): $f"
    done < <(find "${roots[@]}" -xdev \
                \( -path /opt/CyberPatriot -o -path "$QUARANTINE_DIR" -o -path /var/lib -o -path /var/cache \
                   -o -path /var/tmp -o -path /var/www -o -path /var/backups -o -path /var/log \) -prune \
                -o -type f -print0 2>/dev/null)
}

# =============================================================================
# 12. PERSISTENCE AND EXPOSURE (report only)
# =============================================================================

report_only() {
    section "Scheduled jobs, startup items and listening ports (report only)"
    local f line
    for f in /var/spool/cron/crontabs/*; do
        [[ -f $f ]] || continue
        while read -r line; do review "crontab of $(basename "$f"): $line"; done < <(grep -vE '^[[:space:]]*(#|$)' "$f")
    done
    while read -r line; do review "/etc/crontab: $line"; done < <(
        grep -vE '^[[:space:]]*(#|$)|^(SHELL|PATH|MAILTO)=|run-parts|anacron' /etc/crontab 2>/dev/null)
    for f in /etc/cron.d/* /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/*; do
        [[ -f $f && $(basename "$f") != .placeholder ]] || continue
        is_ccs "$f" && continue
        pkg_owns "$f" || review "Cron file not from any Debian package: $f"
    done
    if [[ -f /etc/rc.local ]] && grep -vE '^[[:space:]]*(#|$)|^exit 0' /etc/rc.local | grep -q .; then
        review "/etc/rc.local runs commands at boot: $(grep -vE '^[[:space:]]*(#|$)|^exit 0' /etc/rc.local | tr '\n' ';')"
    fi
    while read -r line; do
        is_ccs "$line" && continue
        review "Listening: $line"
    done < <(ss -H -tulpn 2>/dev/null | awk '$5 !~ /^(127\.|\[::1\])/ { print $1, $5, $7 }' | sort -u)
    while read -r line; do review "/etc/hosts entry: $line"; done < <(
        grep -vE '^[[:space:]]*(#|$)|localhost|ip6-|^127\.0\.1\.1' /etc/hosts 2>/dev/null)
}

# =============================================================================
#  SUMMARY
# =============================================================================

summary() {
    section "Summary"
    log INFO "Already compliant: $N_OK   Fixed: $N_FIXED   Would fix (audit): $N_WOULD   Failed: $N_FAIL"
    local i item shown=60
    { echo; echo "REVIEW (${#REVIEW[@]} items the script reports but does not decide):"
      for item in "${REVIEW[@]+"${REVIEW[@]}"}"; do echo "  - $item"; done
    } >>"$LOG"
    echo; echo "REVIEW (${#REVIEW[@]} items the script reports but does not decide):"
    i=0
    for item in "${REVIEW[@]+"${REVIEW[@]}"}"; do
        i=$((i + 1))
        if (( i > shown )); then echo "  ... and $(( ${#REVIEW[@]} - shown )) more in $LOG"; break; fi
        echo "  - $item"
    done
    { echo; echo "MANUAL STEPS (${#MANUAL[@]}):"
      i=0
      for item in "${MANUAL[@]+"${MANUAL[@]}"}"; do i=$((i + 1)); echo "  $i. $item"; done
      echo
    } | tee -a "$LOG"

    (( N_FAIL > 0 )) && echo "$N_FAIL fixes FAILED. Search the log for [FAIL]."
    if (( ! AUDIT )); then
        echo "BEFORE you close this terminal or reboot, open a second terminal and check:"
        echo "    sudo -k; sudo true             # sudo still works with your password"
        [[ -n ${CRIT[ssh]:-} ]] && echo "    ssh ${INVOKER}@localhost true   # SSH still accepts you"
        (( ${#F_CRITICAL[@]} )) && echo "Critical services to check: $(show "${F_CRITICAL[@]}")"
        echo "If either fails, restore from $BACKUP_DIR using this terminal."
        echo "A locked-out account can be cleared with: sudo faillock --user <name> --reset"
        [[ -d $QUARANTINE_DIR ]] && (( ! DELETE_PROHIBITED )) &&
            echo "Removed files are in $QUARANTINE_DIR. Check them, then delete that folder: prohibited media must not stay on the machine."
        echo "Then reboot and open the CyberPatriot Scoring Report."
    fi
    echo "Full log: $LOG"
}

# =============================================================================
#  MAIN
# =============================================================================

main() {
    while (( $# )); do
        case $1 in
            --audit)             AUDIT=1 ;;
            --force)             FORCE=1 ;;
            --delete-prohibited) DELETE_PROHIBITED=1 ;;
            --skip-upgrade)      SKIP_UPGRADE=1 ;;
            --skip-file-scan)    SKIP_FILE_SCAN=1 ;;
            --password-scope)    shift; PASSWORD_SCOPE=${1:-} ;;
            --password-scope=*)  PASSWORD_SCOPE=${1#*=} ;;
            --readme)            shift; README_SRC=${1:-} ;;
            --config)            shift; CONFIG=${1:-}; CONFIG_GIVEN=1 ;;
            --yes|-y)            ASSUME_YES=1 ;;
            -h|--help)           usage; exit 0 ;;
            *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
    case $PASSWORD_SCOPE in all|users|none) ;; *) echo "--password-scope must be all, users or none" >&2; exit 2 ;; esac
    if (( EUID != 0 )); then echo "Run this with sudo: sudo bash $0 $*" >&2; exit 1; fi

    if ! command -v dpkg-query >/dev/null 2>&1 || ! command -v apt-get >/dev/null 2>&1; then
        echo "This script supports Debian-family systems (Debian, Ubuntu, Mint) that use apt. $OS_NAME is not one of them." >&2
        exit 1
    fi
    mkdir -p "$LOG_DIR" && chmod 750 "$LOG_DIR"
    : >"$LOG"

    echo "Hardening $OS_NAME"
    readme_facts
    apply_facts
    preflight
    apt_sources
    users
    groups_and_sudo
    password_policy
    ssh_service
    firewall
    kernel_params
    services
    software
    display_manager
    permissions
    (( SKIP_FILE_SCAN )) || file_scan
    report_only
    summary
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi

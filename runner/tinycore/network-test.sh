#!/bin/sh
echo "===== NETWORK REPORT $(date) ====="
echo "--- id ---"
id
echo "--- interfaces ---"
ifconfig -a 2>&1
echo "--- ipv4 routes ---"
route -n 2>&1
echo "--- ipv6 routes ---"
route -A inet6 -n 2>&1
echo "--- kernel NIC ---"
dmesg | grep -Ei "eth|ne2k|ne2000|network|nic" 2>&1
echo "--- modules ---"
lsmod | grep -Ei "ne|8390|ether" 2>&1
echo "--- sockets ---"
netstat -lnptu 2>&1
echo "--- DNS ---"
cat /etc/resolv.conf 2>&1
echo "--- hostname ---"
hostname 2>&1
echo "--- busybox network ---"
busybox | grep -E "ifconfig|route|udhcpc|ping|ping6|netstat" 2>&1
echo "--- addresses via /proc ---"
cat /proc/net/dev 2>&1
echo "===== END NETWORK REPORT ====="

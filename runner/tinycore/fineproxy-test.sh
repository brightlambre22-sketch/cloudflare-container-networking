#!/bin/sh
USER="$1"
PASS="$2"
PROXIES="104.245.241.241 104.245.242.42 104.245.242.79 140.235.1.156 140.235.170.229 140.235.2.179 140.235.2.87 140.235.3.108 140.235.3.135 140.235.3.210 146.19.44.139 162.252.53.183 162.252.54.45 162.252.55.11 162.252.55.238 166.88.178.235 166.88.178.53 167.253.16.43 167.253.19.143 172.83.253.92 176.126.104.142 176.126.111.39 178.20.28.176 178.20.28.198 178.20.31.222 185.202.108.61 185.77.220.200 185.77.220.73 185.77.222.124 185.77.222.200 192.101.65.46 192.101.66.105 192.101.67.56 193.142.36.218 193.142.39.151 193.142.39.208 193.151.189.191 193.151.190.214 193.151.190.69 193.163.207.99 193.202.16.240 193.31.127.25 193.42.245.129 194.110.150.232 194.180.236.157 194.180.236.37 194.70.234.63 194.70.234.73 194.99.25.61 194.99.26.103 194.99.26.99 194.99.27.233 194.99.27.79 199.96.164.65 212.18.113.111 212.18.113.53 212.18.113.65 212.87.218.179 216.40.73.14 31.40.195.121 45.133.113.18 45.133.114.76 45.133.115.12 45.136.25.175 45.136.27.203 45.147.232.227 45.147.232.85 45.147.233.176 45.147.234.212 45.147.234.76 45.147.235.109 45.147.235.201 45.159.22.13 45.159.22.223 45.159.22.232 46.253.131.253 62.204.49.156 64.49.36.132 64.49.36.135 64.49.37.18 64.49.38.75 64.49.39.250 77.83.26.19 77.83.27.154 77.83.27.178 77.83.27.45 77.83.27.61 83.97.116.222 83.97.118.103 88.218.45.157 88.218.47.124 88.218.47.39 89.19.35.156 89.19.35.48 91.132.124.100 91.132.125.195 91.132.125.85 91.246.51.192 94.154.113.166"
echo "===== FINEPROXY MYSTERIUM TEST $(date) ====="
tce-load -wil curl.tcz >/tmp/fp-install.log 2>&1
echo "--- Tiny Core network ---"
ifconfig eth0 2>&1
route -n 2>&1
echo "--- Mysterium processes ---"
ps 2>&1 | grep -E '[m]yst|[m]yst-supervisor|[c]loudflare-runner' || true
echo "--- Mysterium listeners ---"
netstat -lnptu 2>&1 | grep -E 'myst|1194|4449|5650' || true
echo "--- inbound listeners ---"
(while true; do echo "TCP_INBOUND_OK"; done | nc -l -p 18080 >/tmp/fp-tcp.log 2>&1) &
(while true; do nc -u -l -p 18081; done >/tmp/fp-udp.log 2>&1) &
sleep 1
netstat -lnptu 2>&1 | grep -E ':18080|:18081' || true
echo "--- outbound SOCKS5 tests ---"
for IP in $PROXIES; do
 START=$(date +%s)
 EXITIP=$(curl -4 -sS --socks5-hostname "$IP:1080" --proxy-user "$USER:$PASS" --connect-timeout 5 --max-time 8 https://api.ipify.org 2>/tmp/fp.err)
 RC=$?
 END=$(date +%s)
 if [ $RC -eq 0 ] && [ -n "$EXITIP" ]; then
  echo "OUTBOUND PASS proxy=$IP exit_ipv4=$EXITIP seconds=$((END-START))"
 else
  echo "OUTBOUND FAIL proxy=$IP rc=$RC seconds=$((END-START))"
 fi
done
echo "--- inbound status ---"
echo "INBOUND LISTENERS READY: TCP 18080 UDP 18081"
echo "INBOUND PASS requires an external packet to reach the FineProxy public IP on these ports."
echo "SOCKS5 outbound success does not prove unsolicited inbound forwarding."
echo "===== END FINEPROXY MYSTERIUM TEST ====="

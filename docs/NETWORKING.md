# Per-node egress and public ingress

## Routing split

Each node has a matching `NODE_ID` at both ends of one authenticated WebSocket tunnel:

```text
Outbound:
node app -> loopback SOCKS5 on node-agent -> WSS -> node's Oracle gateway process
         -> that process's FineProxy SOCKS5 identity -> internet

Public ingress:
internet -> explicitly configured Oracle TCP/UDP listener
         -> authenticated WSS route for one NODE_ID
         -> node-agent's exact local-service allowlist -> node service
```

FineProxy is used only for outbound SOCKS5 TCP CONNECT and UDP ASSOCIATE, including the corresponding replies. The Oracle listener is the public ingress endpoint. SOCKS5 UDP ASSOCIATE does not forward unsolicited inbound connections, and the Cloudflare Worker is not an arbitrary public TCP/UDP listener.

## Gateway configuration

Run one `gateway/client.py` process per node on the Oracle host. Give every process the same `NODE_ID` as its paired node agent, a node-specific FineProxy endpoint/credential set, and unique public listener ports on the shared Oracle IP.

Required runtime values:

```text
TUNNEL_URL=wss://<worker-host>/tunnel
TUNNEL_TOKEN=<gateway role token>
CLIENT_TOKEN=<node role token>
NODE_ID=node-001
SOCKS5_PROXY_HOST=<FineProxy hostname from the provider dashboard>
SOCKS5_PROXY_PORT=1080
SOCKS5_PROXY_USERNAME=<rotated per-node FineProxy username>
SOCKS5_PROXY_PASSWORD=<rotated per-node FineProxy password>
TCP_ALLOWLIST=<comma-separated exact outbound host:port targets>
TCP_DIRECT_ALLOWLIST=
UDP_DESTINATION_ALLOWLIST=<comma-separated exact outbound host:port targets>
```

Keep the FineProxy endpoint and credentials in the Oracle host's secret/runtime configuration only. They are not Replit/Cloudflare worker secrets and must not be committed, copied to `.dev.vars`, or placed in a checked-in env file. Configure a different SOCKS5 credential identity for each node if FineProxy assigns distinct egress identities. UDP destinations will be denied unless explicitly present in `UDP_DESTINATION_ALLOWLIST`; the provider plan must have UDP enabled.

`TCP_DIRECT_ALLOWLIST` is empty in production so allowed TCP egress uses FineProxy. The only default direct target is the repository's loopback echo fixture (`127.0.0.1:9000`), for the existing local TCP proof. `TCP_ALLOWLIST` remains an exact destination allowlist and must include every intended TCP egress destination.

Ingress is off unless a map is set. Map the Oracle bind address and public port to a target reachable from the paired node agent:

```text
TCP_INGRESS_MAP=0.0.0.0:8081=10.50.0.11:80
UDP_INGRESS_MAP=0.0.0.0:5301=10.50.0.11:53
```

These examples are for `NODE_ID=node-001`; use non-overlapping Oracle public ports for other nodes. A public listener is created only for each explicit mapping. Restrict exposure again with Oracle/cloud firewall rules; the software configuration is not a substitute for host firewall policy.

Example port allocation on one Oracle public IP:

| Node identity | Public TCP → node target | Public UDP → node target |
|---|---|---|
| `node-001` | `8081 → 10.50.0.11:80` | `5301 → 10.50.0.11:53` |
| `node-002` | `8082 → 10.50.0.12:80` | `5302 → 10.50.0.12:53` |
| `node-003` | `8083 → 10.50.0.13:80` | `5303 → 10.50.0.13:53` |

For each row, start a separate gateway process with that node's `NODE_ID`, mapping, and FineProxy identity. The node IDs are the tunnel routing boundary; the Oracle process does not send public ingress through a different node's tunnel.

## Node-agent configuration

Run `gateway/node_agent.py` in each node's network namespace with the same `NODE_ID` and tokens as its Oracle peer:

```text
TUNNEL_URL=wss://<worker-host>/tunnel
CLIENT_TOKEN=<node role token>
NODE_ID=node-001
LOCAL_SOCKS5_LISTEN=127.0.0.1:1080
INGRESS_TCP_ALLOWLIST=10.50.0.11:80
INGRESS_UDP_ALLOWLIST=10.50.0.11:53
```

The local SOCKS5 endpoint listens on loopback only and supports TCP CONNECT and UDP ASSOCIATE. Configure node applications to use it when they need the node's FineProxy egress identity. For inbound service traffic, the agent connects only to exact targets in the separate `INGRESS_TCP_ALLOWLIST` and `INGRESS_UDP_ALLOWLIST`; these must match the target in the Oracle map. If a service listens only on loopback, map to the appropriate loopback address instead of the example private IP.

The Oracle port maps and node allowlists are separate from the outbound egress allowlists. Do not widen any of them to `*`, a whole subnet, or an unrestricted port range.

## Verify before production

1. Run `cd gateway && python -m unittest -v` for protocol, SOCKS packet, and fake-proxy handshake tests.
2. Confirm each FineProxy plan has SOCKS5 UDP enabled, then test outbound TCP and UDP through each node's own proxy identity. The repository tests do not contact FineProxy.
3. Start one node-agent/gateway pair with a single non-sensitive test service and one high, non-privileged TCP and UDP port.
4. Verify each public port reaches only its paired node, and that unconfigured ports remain closed. Check both Oracle/cloud firewall rules and the provider's UDP behavior.
5. Rotate any proxy credential that has been pasted into chat or a source repository before putting it into the Oracle runtime environment.

For a live UDP egress probe after setup, provide a safe request packet as hex to `python udp_smoke.py <destination-host> <port> <payload-hex>` from `gateway/`. The probe sends one datagram through the node's loopback SOCKS5 endpoint and reports whether a reply returned; choose a destination and payload appropriate for the service being tested.

There is no arbitrary public inbound path through FineProxy or Cloudflare in this design.

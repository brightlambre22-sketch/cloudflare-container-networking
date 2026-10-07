# Relay frame protocol v1

Each WebSocket binary message carries exactly one complete frame. Frames relay TCP stream chunks or one complete UDP datagram per frame. Payload limit is 65,536 bytes; implementations must reject an oversized frame rather than buffer it without limit. SOCKS5 UDP packets include their address header inside UDP_DATA, so the maximum application datagram is smaller by the address-header length.

## Header

All integers are unsigned and big-endian. Fixed header is 20 bytes, followed by node ID bytes, followed by payload.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | Magic ASCII RLY1 |
| 4 | 1 | Version, currently 1 |
| 5 | 1 | Frame type |
| 6 | 1 | Flags, currently zero |
| 7 | 1 | Node ID byte length, 1 through 64 |
| 8 | 4 | Stream ID |
| 12 | 4 | Sequence number |
| 16 | 4 | Payload byte length |
| 20 | variable | ASCII node ID matching [A-Za-z0-9._-]{1,64} |
| 20 + node ID length | variable | Payload |

The total WebSocket message length must equal 20 + node ID length + payload length. TCP_DATA payload bytes are opaque and maintain stream order; TCP frames never merge or split TCP stream boundaries beyond normal chunking. OPEN_TCP and INGRESS_TCP_OPEN/INGRESS_UDP_OPEN payloads are UTF-8 JSON with host and port. ERROR payloads are UTF-8 JSON with a short code; TCP_OPENED may carry the destination JSON.

## Type IDs

| ID | Name | Direction | Purpose |
|---:|---|---|---|
| 1 | HELLO | Reserved | Future protocol negotiation |
| 2 | OPEN_TCP | node to gateway | JSON destination request for FineProxy SOCKS5 CONNECT |
| 3 | TCP_OPENED | either | Destination connected |
| 4 | TCP_DATA | either | Raw bytes for stream ID |
| 5 | CLOSE | either | Close that TCP stream |
| 6 | ERROR | either | JSON failure code |
| 7 | PING | either | Application heartbeat |
| 8 | PONG | either | Heartbeat reply |
| 9 | INGRESS_TCP_OPEN | gateway to node | JSON node-local target for a public TCP connection |
| 10 | UDP_OPEN | node to gateway | Open a FineProxy SOCKS5 UDP ASSOCIATE |
| 11 | UDP_OPENED | either | UDP association or service flow ready |
| 12 | UDP_DATA | either | One datagram: SOCKS5-encapsulated for egress, raw service bytes for public ingress |
| 13 | UDP_CLOSE | either | Close a UDP association or service flow |
| 14 | INGRESS_UDP_OPEN | gateway to node | JSON node-local target for a public UDP flow |

## Session rules in this proof

The HTTPS handshake authenticates a role (client or gateway) and node ID separately from frame contents. The Durable Object allows one live WebSocket per role and node ID. Outbound OPEN_TCP and UDP_OPEN from a node route to that same node's Oracle gateway process, which enforces destination allowlists and uses its configured FineProxy identity. Public ingress follows a separate route: an explicitly configured Oracle TCP/UDP listener sends INGRESS_TCP_OPEN or INGRESS_UDP_OPEN only to the matching node ID; the node agent checks its own exact local-service allowlist. UDP_DATA preserves a datagram boundary and carries the SOCKS5 UDP header for egress; public-ingress UDP_DATA carries the unmodified service datagram. FineProxy does not provide the public listener.

No unsolicited inbound connection is inferred from SOCKS5 UDP ASSOCIATE. Cloudflare's HTTP/WebSocket endpoint and this protocol are not public arbitrary-TCP/UDP listeners; public access is provided only by Oracle listener mappings.

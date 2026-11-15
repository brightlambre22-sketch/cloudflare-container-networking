# amd64 Mysterium runtime

This is the real Mysterium runtime for a Linux amd64 host. The browser/v86 Tiny Core VM remains a console/UI proof of concept; this runtime is where the Mysterium provider process runs.

## Requirements

- Linux amd64 host (Oracle VM, VPS, or another Linux server)
- Docker Engine with Compose v2 and cgroup support enabled
- outbound Internet access
- host networking
- /dev/net/tun
- NET_ADMIN and NET_RAW capabilities for the WireGuard/provider networking path
- a deployed Cloudflare Worker URL
- the Vampirequid admin access key for one-time node provisioning
- a Mysterium onboarding key supplied only through the local .env file, if onboarding is desired

Mysterium's provider service uses WireGuard, so this runtime intentionally uses host networking and the host TUN device rather than trying to run the provider inside the browser/v86 VM.

## Provision and start

1. From this directory, set CLOUDFLARE_API_URL and ADMIN_ACCESS_KEY in the shell.
2. Run ./provision-node.sh. It creates a node through the authenticated Worker API and writes the returned one-time node credential to a mode-600 .env file.
3. Keep .env private. Do not commit it, paste it into chat, or reuse its node credential for another node.
4. Optionally add MYSTERIUM_API_KEY to .env for automatic MMN onboarding.
5. Start the runtime:

   docker compose up -d --build

The one-time node credential is stored as a SHA-256 digest by the Worker. If the local credential is lost, an administrator can rotate it with an authenticated POST to /v1/nodes/{node_id}/agent-token; update the node's .env before restarting it. Rotation immediately invalidates the previous credential.

## Resource isolation baseline

Docker applies the Compose cpus, mem_limit, and pids_limit settings through Linux cgroups. Defaults are 2 CPU cores, 2 GiB RAM, and 512 processes/threads per node container. Tune them per host using NODE_CPU_LIMIT, NODE_MEMORY_LIMIT, and NODE_PIDS_LIMIT.

The container drops all Linux capabilities and adds back only NET_ADMIN and NET_RAW, which the current provider networking path requires. no-new-privileges is enabled. These are per-container resource limits, not per-merchant isolation: do not enable arbitrary merchant shell execution on this shared node. Per-account workloads still require separate containers/cgroups, namespaces, storage boundaries, and explicit egress policy before that capability is enabled.

## Verify

The container exposes Mysterium TequilaAPI on host port 4050 and the runtime health endpoint on port 8080.

    curl http://127.0.0.1:4050/healthcheck
    curl http://127.0.0.1:8080/health

The Worker heartbeat uses the per-node credential from .env. The credential is not returned by subsequent node reads. Do not commit .env or any Mysterium onboarding key.

# Tiny Core Linux runner

This directory contains the Tiny Core runtime and boot scripts for the proof of concept.

## Current milestone: final boot and state save

For now, the startup gate deliberately ignores Fineproxy and Mysterium. It verifies
basic network readiness and a real HTTPS request, then saves Tiny Core's state
only after both checks pass.

1. The existing Tiny Core image/DHCP hook brings up the network.
2. `bootlocal.sh` waits up to 60 seconds for a default route.
3. It performs a certificate-validated HTTPS request to `https://example.com/`
   (override with `BOOT_HTTPS_TEST_URL` if needed).
4. Only after that succeeds, it runs `filetool.sh -b`.
5. Failures are recorded in `/var/log/tinycore-final-boot.log` and do not trigger a save.

The wait and HTTPS retry loops are bounded. The HTTPS check does not disable
certificate verification. A successful HTTP response is not required; a completed
request with valid TLS is the criterion.

## Install

Copy this directory to the guest, then run the installer as root, for example:

```sh
sudo ./install-persistence.sh /tmp/cloudflare-node
```

The installer places the hook at `/opt/bootlocal.sh`, the Tiny Core startup
hook location used by `/opt/bootsync.sh`. Ensure `/opt` is included in
`/opt/.filetool.lst`; the installer creates or updates that list and does not
save state prematurely.

On the next boot, inspect `/var/log/tinycore-final-boot.log` for the readiness
checks and backup result. Tiny Core's `filetool.sh -b` saves only paths listed
in `/opt/.filetool.lst` (minus exclusions), to the configured TCE backup area.

## Authenticated control runner

The Worker now requires a unique per-node bearer credential for runtime polling,
heartbeats, and node status updates. Create the node through the authenticated
admin endpoint; the response contains node_id and agent_token exactly once.
Store the credential in the persistent node.env file with mode 600 and load it
before starting bootstrap.sh. Never commit or share that credential. If it is
lost, an administrator can rotate it through POST /v1/nodes/{node_id}/agent-token;
the previous token is invalid immediately.

The boot/persistence gate above remains separate from this runner. Do not start
network services or account execution until the base boot, persistence, and
per-node authentication checks pass.

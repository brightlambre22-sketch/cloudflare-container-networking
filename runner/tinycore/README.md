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

The browser bootstrap can install and start the Mysterium/Cloudflare runner after
the base network setup. It requires a high-entropy `NODE_CONTROL_TOKEN` supplied
through a trusted provisioning environment variable. The token is passed to the
runner process without being written into `node.env`, the ISO, or the Tiny Core
backup list. The Worker must have the matching `NODE_CONTROL_TOKEN` secret.

The runner's node-status polling, heartbeat, and status PATCH calls are
authenticated. It cannot enumerate or create nodes or start/stop runtimes.

**Reboot limitation:** the current boot hook does not reissue the runner token or
automatically relaunch the runner after a guest reboot. A trusted, short-lived
per-node credential-delivery mechanism is required before this can be considered
persistent production operation. Do not persist the shared runner token in
`node.env` or the guest backup.

Fineproxy routing, per-merchant isolation, cgroups, seccomp, and a verified
headless merchant shell remain separate acceptance gates.

# Tiny Core Linux runner

This directory is the non-Container runtime for the PoC.

Tiny Core is booted by the external Linux/VM runtime, while Cloudflare remains
the control plane.

## Base image

Use the official Tiny Core Linux 17.1 x86_64 release.

ISO:
https://www.tinycorelinux.net/17.x/x86_64/release/CorePure64-17.1.iso

Distribution files:
https://www.tinycorelinux.net/17.x/x86_64/release/distribution_files/

Do not commit the ISO into Git. The repository contains the deterministic
bootstrap/configuration instead.

## Persistence

Tiny Core is normally a live system. The runner must boot with a persistent
tce directory and persistent writable storage. Mysterium data must live on
that persistent storage, not only in RAM.

On every boot the runner should:

1. Bring up networking.
2. Restore the persistent tce directory.
3. Restore the Mysterium data directory.
4. Configure the assigned 10.240.x.x addresses.
5. Start the Mysterium service.
6. Start the Cloudflare runner/heartbeat.

The browser is not part of the lifecycle.

## Mysterium

Mysterium publishes an amd64 DEB and documents native Linux installation.
Tiny Core is not one of the officially tested distributions, so this runner
is a PoC and dependency compatibility must be verified on the target image.

Official installation reference:
https://github.com/MysteriumNetwork/node

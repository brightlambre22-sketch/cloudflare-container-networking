# Tiny Core Linux runner

This directory contains the non-Container runtime for the PoC.

## Canonical boot image

The repository now uses:

`public/boot/cloudflare-tinycore-dhcp.iso`

This is the verified custom Tiny Core Pure64 image based on the repository's
working Tiny Core 11.x base. The image has a boot-time DHCP hook so the first
milestone is simply:

1. Boot Tiny Core.
2. Bring up `eth0`.
3. Obtain an IPv4 address through DHCP.

The ISO is intentionally kept separate from the source scripts so it can be
replaced by a later verified build without changing the runtime source.

## Persistence

Tiny Core is normally a live system. The later persistent-node runner should
boot with persistent writable storage. Mysterium data must live on that
persistent storage, not only in RAM.

The intended lifecycle remains:

1. Bring up networking.
2. Restore persistent storage.
3. Restore the Mysterium data directory.
4. Configure assigned node addresses.
5. Start the Mysterium service.
6. Start the Cloudflare runner/heartbeat.

The browser is not part of that lifecycle.

## Mysterium

Mysterium integration remains a later stage. The current custom ISO does not
claim to contain a Mysterium executable. Do not fabricate or silently assume
`/opt/mysterium/myst` exists on the base image.

## Important

The DHCP-enabled ISO is the current known-good Tiny Core boot foundation.
Older automated ISO-build/download workflows are intentionally removed so
they cannot replace this verified image with an incompatible base.

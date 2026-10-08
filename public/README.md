# Tiny Core / v86 boot assets

The repository's canonical Tiny Core boot image is the verified custom
DHCP-enabled Pure64 image:

`public/boot/cloudflare-tinycore-dhcp.iso`

It is based on Tiny Core Pure64 11.1 and was remastered from the working
Pure64 base. Its startup hook brings up `eth0` and requests an IPv4 address
through DHCP.

Expected boot layout:

```text
public/
├── boot/
│   └── cloudflare-tinycore-dhcp.iso
├── bios/
│   ├── seabios.bin
│   └── vgabios.bin
└── v86/
    ├── libv86.js
    └── v86.wasm
```

The custom ISO is now the source boot asset for this project. Do not add an
automated workflow that downloads or rebuilds a different Tiny Core release
over it.

The browser/v86 VM remains a boot/reference PoC. It is not the always-on
runtime for the persistent Tiny Core node.

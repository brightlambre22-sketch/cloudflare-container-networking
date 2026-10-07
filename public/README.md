# Tiny Core / v86 boot assets

This directory is reserved for the browser/v86 Tiny Core boot PoC.

Expected layout:

```text
public/
├── boot/
│   └── TinyCore-17.1.iso
├── bios/
│   ├── seabios.bin
│   └── vgabios.bin
└── v86/
    ├── libv86.js
    └── v86.wasm
```

The ISO and v86 runtime assets are intentionally not committed by the
persistent-node automation changes. Add the working boot assets here when
available, or serve them from the existing public asset host.

The browser/v86 VM is only a boot/reference PoC. It is not the always-on
runtime for the persistent Tiny Core node.

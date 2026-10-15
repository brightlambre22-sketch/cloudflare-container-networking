# Worker-only headless v86 feasibility spike

## Goal

Execute a real Linux shell command in the Cloudflare Worker runtime without a browser tab, browser WebSocket agent, container, or external VM host.

## Current implementation facts

- `/v1/vm/exec` forwards commands to the `VmExecution` Durable Object.
- `VmExecution` can execute only when an agent WebSocket is connected. Its status explicitly reports `runtime: "browser-v86"`.
- `public/v86/libv86.js` is a bundled browser/Node distribution, not a Cloudflare Workers build.
- The bundle chooses its filesystem loader when `XMLHttpRequest` is missing (or when Node's `process.versions.node` is present). That branch uses `require("fs")` or `import("node:fs/promises")`, neither of which is a Worker filesystem API.
- The bundled code also contains browser-specific DOM and `window` references. Compiling `v86.wasm` alone does not provide the host APIs needed to initialize the emulator.
- The existing saved VM snapshot is about 103 MB, before emulator allocations. Do not use it for the first runtime test; test a deliberately small guest and measure memory/CPU first.

## Required implementation gates

1. Identify or build an emulator entry point that is compatible with Workers (no Node filesystem imports and no mandatory DOM/window APIs).
2. Load guest boot media through Worker-compatible fetch/asset APIs and ensure the emulator's resource loader uses them.
3. Boot a minimal guest and obtain a deterministic proof from the guest shell, such as a unique marker plus a zero exit code.
4. Add a command coordinator that reports ready only after the guest shell is responsive and startup commands complete.
5. Verify guest networking from inside the guest: NIC present, DHCP lease, default route, DNS resolution, and outbound HTTPS.
6. Measure memory, CPU time, and startup duration. Fail closed with a clear unsupported/limit error if Worker limits are exceeded.
7. Keep the current browser-agent path working until the headless path passes these gates.

## Acceptance criteria

A test must call the deployed Worker API with the browser closed and receive the output of a command executed by the guest shell. A successful snapshot integrity check, WASM compilation, direct Worker egress request, or Durable Object status response is not sufficient.

## Current status

Research/spike notes only. No headless guest execution has been implemented or deployed by this change.

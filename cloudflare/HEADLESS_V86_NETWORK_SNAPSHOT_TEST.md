# Headless v86 network and snapshot round-trip test

## Known-good prerequisite

The Tiny Core boot probe has already succeeded in Cloudflare Workerd. The accepted boot evidence is the structured result:

- `runtime: "workerd"`
- `wasm_module_loaded: true`
- `static_module_instantiated: true`
- `emulator_initialized: true`
- `emulator_started: true`
- `guest_booted: true`
- `guest_boot_evidence: "vga_text_marker"`
- screen excerpt reaches `tc@box:~$`

That probe boots a small Tiny Core ISO without restoring the 103 MB snapshot. Do not treat the separate emulator-initialization smoke worker as the boot test: it sets `autostart: false`, attaches no boot media, and explicitly reports `guest_booted: false`.

## Next acceptance sequence

Run this against the already-proven boot worker/configuration, on an isolated test identity and isolated R2 snapshot prefix. Do not use or overwrite the live `admin` snapshot and do not assume the missing `v2` baseline exists.

1. **Shell execution:** wait for the VGA text marker `tc@box:~$`; send a harmless deterministic command such as `echo HEADLESS_EXEC_OK`; capture output and require the exact marker.
2. **Network diagnosis:** from the guest, record `/sbin/ifconfig -a`, `/sbin/route -n`, resolver configuration, and `/proc/cmdline`. Bring up the configured NIC and request DHCP using the existing known-good guest networking sequence. Do not infer guest connectivity from the Worker's own `fetch()`.
3. **DNS and HTTPS:** after DHCP succeeds, test name resolution and an HTTPS request from inside the guest. Capture exit codes separately so a DNS failure is distinguishable from TLS or routing failure. Use a stable public HTTPS endpoint and a short timeout.
4. **Guest marker:** write a unique, non-secret marker to the guest's persistent filesystem, then request a v86 saved-state export from the emulator.
5. **API persistence:** upload exported state chunks to a new test identity/generation using the existing snapshot chunk API; commit the manifest only after all chunks have been uploaded and verified. Read the committed manifest back and verify chunk counts and byte lengths.
6. **Fresh restore:** create a new emulator instance, restore only from the API-backed test snapshot, and wait for the same VGA shell marker. Execute a command that reads the saved marker and require an exact match.
7. **Restored networking:** repeat the in-guest DNS and HTTPS request after restore. Record each result independently.

## Pass criteria

The end-to-end test passes only when a fresh emulator instance restores the guest-written marker and completes a network request from inside the restored guest. A clean ISO boot, a valid R2 manifest, emulator initialization, or a Worker-side HTTPS fetch alone is not sufficient.

## Safety and test isolation

- Never write to the live `admin` snapshot.
- Do not create a `v2` baseline by copying the `admin` snapshot; it may contain private or mutable state.
- Use a unique test identity and generation for each run; retain the prior generation until the new manifest and all chunks have been verified.
- Keep `VM_API_TOKEN` server-side. Do not print it in logs or pass it to the guest.
- Do not deploy this experimental harness to production or merge it without review.

## Current integration blocker

The checked-in `cloudflare/src/headless-v86-smoke-worker.ts` on the account/snapshot branch is an emulator-initialization smoke test, not the already-proven Tiny Core boot probe. It allocates 16 MiB RAM, uses `autostart: false`, attaches no ISO/disk, and returns `guest_booted: false`. The working boot configuration must be located/reused before adding shell-command, network, and snapshot assertions; replacing it with this smoke worker would regress the proof already achieved.


## API read-back implementation status (experimental branch)

The branch `experiment/workerd-registration-snapshot-roundtrip` adds:

- `src/headless-snapshot-store.ts`: a transactional R2 helper that refuses to commit unless the caller reports all guest acceptance checks passed; writes chunks, reads them back, checks SHA-256, then writes the manifest last.
- `test/headless-snapshot-store.test.ts`: tests chunk boundaries, fail-closed acceptance checks, round-trip byte equality, and corrupted-chunk detection.
- `POST /v1/runtime/snapshot-readback`: authenticated API endpoint that reads a committed test/account snapshot from R2 and verifies its complete byte length and SHA-256 digest.

This is only the storage/read-back segment. It is deliberately not presented as the complete proof: the endpoint does not boot a VM, and the storage helper is not yet called by the signup flow or by the Tiny Core test worker. The next integration must call the helper with the actual v86 `save_state()` output only after the real guest network checks pass, then create a fresh v86 instance, restore the read-back bytes, and verify a guest-written marker. Only after that should signup stop cloning the baseline and await server-side initialization before marking the account ready.

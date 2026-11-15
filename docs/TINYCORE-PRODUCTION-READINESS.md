# TinyCore production-readiness gate

This checklist distinguishes source changes from verified runtime behavior. A checked source item is not a production acceptance result.

## Improved on the hardening branch

- [x] Guard node inventory/create/read and operator lifecycle routes with admin authorization.
- [x] Require a dedicated `NODE_CONTROL_TOKEN` for runner status polling, heartbeat, and PATCH.
- [x] Fail closed when the runner credential is missing.
- [x] Restrict runner PATCH fields to status and bounded error text; runtime classification and node identity cannot be changed by the runner.
- [x] Apply the 30-second heartbeat expiry when reading runtime state.
- [x] Update both runner copies and browser bootstrap to send the credential without writing it to the persistent node configuration.
- [x] Add source-contract tests and CI shell syntax checks.
- [x] Add a headless guest preflight gate that mounts cgroup v2 when the kernel supports it, enables CPU/memory/PID controllers, verifies writable limits and process attachment, and checks namespace creation and seccomp capability before a snapshot can be marked ready.
- [x] Shell syntax check performed in the working environment for the updated runner/bootstrap scripts.

## Not yet accepted for production

- [ ] Run the branch's Worker contract tests and Wrangler dry-run build. They have not been executed for this branch.
- [ ] Run the actual Workerd TinyCore guest boot workflow and capture its isolation preflight output. No completed guest round-trip workflow run was found in the repository's recent Actions history.
- [ ] Demonstrate cgroups v2 controllers are present in the actual TinyCore kernel and that resource limits can be applied to a real merchant service process. The preflight now attempts to mount cgroup2 and enable controllers when supported; it remains a capability probe and does not enforce limits for merchant workloads.
- [ ] Demonstrate namespace creation and an installed seccomp filter on the real guest. The preflight detects namespace handles and seccomp kernel support; it does not yet install policy.
- [ ] Replace the shared platform-wide runner credential with short-lived per-node credentials, scoped to a node ID and revocable independently.
- [ ] Deliver runner credentials securely after every reboot without storing a reusable bearer secret in an unencrypted guest backup.
- [ ] Provision the required `NODE_CONTROL_TOKEN` Worker secret through the approved secrets process. No secret or Cloudflare binding has been changed.
- [ ] Prove the guest can boot and execute merchant shell commands without a browser tab remaining open. The current v86 execution path still has a browser-session dependency; the Oracle executor is a separate host path.
- [ ] Prove per-merchant isolation, resource ceilings, cross-tenant denial, and console authorization with adversarial integration tests.
- [ ] Move Stockroom execution and its SQLite database into each merchant's TinyCore runtime, or explicitly accept and document the current per-account Durable Object fallback. The current code does not prove TinyCore-hosted Stockroom.
- [ ] Implement independent encrypted merchant database backups, point-in-time recovery, restore drills, and order/inventory reconciliation.
- [ ] Implement automatic VM/Stockroom recovery and verified tunnel reconnect after a reboot or host failure.
- [ ] Validate the production merchant console, admin console, audit trail, and emergency recovery workflow end-to-end.

## Release rule

Do not mark TinyCore as a production VPS or enable merchant production workloads until every unchecked acceptance item has passing evidence. The current branch is source hardening and test scaffolding, not a production deployment.

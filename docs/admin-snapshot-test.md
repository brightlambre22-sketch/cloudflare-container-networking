# Admin VM snapshot test sheet

Print this page or keep it for the first snapshot test.

## Accounts
- **Admin User A** — snapshot key: `admin-user-a` — marker: `ADMIN-A-TEST`
- **Admin User B** — snapshot key: `admin-user-b` — marker: `ADMIN-B-TEST`

## Test steps
1. Open the VM and select **Admin User A**. Enter the five-digit admin code.
2. Wait for the page to report that startup and network preflight are complete and the snapshot is saved.
3. Add the marker `ADMIN-A-TEST` inside the VM and click **Save VM state**.
4. Log out by closing the page, clear browser site data, reopen the page, sign in as Admin User A, and confirm the marker is restored.
5. Repeat for **Admin User B** with marker `ADMIN-B-TEST`.
6. Switch between A and B. Each account must restore only its own marker.

## Record
- Date: ____________________
- Admin A restored after browser data clear: Pass / Fail
- Admin B restored after browser data clear: Pass / Fail
- A and B snapshots remain separate: Pass / Fail
- Save occurs only after startup finishes: Pass / Fail

**One-time setup before deployment:** Create the R2 bucket with `npx wrangler r2 bucket create cloudflare-container-vm-snapshots` (skip this if it already exists). Snapshot files live in Cloudflare R2, not browser storage. Regular-user usernames are identifiers, not secure authentication; don't store private data under username-only accounts.

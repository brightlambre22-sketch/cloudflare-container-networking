#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const baseUrl = process.env.WORKER_BASE_URL?.replace(/\/+$/, "");
const username = process.env.TEST_USERNAME?.trim().toLowerCase();
const password = process.env.TEST_PASSWORD;
const expectedDigest = process.env.EXPECTED_SNAPSHOT_SHA256?.trim().toLowerCase();
const outputPath = process.env.SNAPSHOT_OUT;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${path} returned non-JSON HTTP ${response.status}`); }
  return { response, data };
}

if (!baseUrl || !username || !password) {
  console.error("Set WORKER_BASE_URL, TEST_USERNAME, and TEST_PASSWORD.");
  process.exit(2);
}
if (expectedDigest && !/^[a-f0-9]{64}$/.test(expectedDigest)) {
  console.error("EXPECTED_SNAPSHOT_SHA256 must be a 64-character SHA-256 hex digest.");
  process.exit(2);
}

try {
  console.log("1/5 Login using existing registered account...");
  const login = await requestJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!login.response.ok) throw new Error(`login failed: HTTP ${login.response.status} (${login.data.error ?? "unknown_error"})`);
  const { account_id: accountId, session_token: sessionToken } = login.data;
  if (typeof accountId !== "string" || !/^acct-[a-f0-9-]{36}$/.test(accountId) ||
      typeof sessionToken !== "string" || !/^[a-f0-9]{64}$/.test(sessionToken)) {
    throw new Error("login response did not contain a valid account_id and session_token");
  }
  console.log(`PASS login; account_id=${accountId}; session token not printed`);

  const authHeaders = { authorization: `Bearer ${sessionToken}` };
  console.log("2/5 Request this account's snapshot manifest with the login session...");
  const manifestResult = await requestJson(`/api/vm-snapshots/${encodeURIComponent(accountId)}`, {
    headers: authHeaders,
  });
  if (!manifestResult.response.ok) {
    throw new Error(`snapshot manifest request failed: HTTP ${manifestResult.response.status} (${manifestResult.data.error ?? "unknown_error"})`);
  }
  const manifest = manifestResult.data;
  if (manifest.version !== 1 || typeof manifest.generation !== "string" ||
      !/^[a-z0-9-]{1,40}$/.test(manifest.generation) ||
      !Number.isInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > 128 ||
      !Number.isInteger(manifest.byteLength) || manifest.byteLength < 1 || manifest.byteLength > 536870912 ||
      manifest.chunks !== Math.ceil(manifest.byteLength / 8388608)) {
    throw new Error("snapshot manifest failed schema/integrity checks");
  }
  console.log(`PASS manifest; generation=${manifest.generation}; chunks=${manifest.chunks}; expected_bytes=${manifest.byteLength}`);

  console.log("3/5 Download all chunks using the same authenticated session...");
  const parts = [];
  let downloadedBytes = 0;
  for (let part = 0; part < manifest.chunks; part += 1) {
    const path = `/api/vm-snapshots/${encodeURIComponent(accountId)}/chunks/${encodeURIComponent(manifest.generation)}/${part}`;
    const response = await fetch(`${baseUrl}${path}`, {
      headers: authHeaders,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`chunk ${part} failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedPartBytes = Math.min(8388608, manifest.byteLength - part * 8388608);
    if (bytes.byteLength !== expectedPartBytes) {
      throw new Error(`chunk ${part} length mismatch: got ${bytes.byteLength}, expected ${expectedPartBytes}`);
    }
    downloadedBytes += bytes.byteLength;
    parts.push(bytes);
    console.log(`  chunk ${part + 1}/${manifest.chunks}: ${bytes.byteLength} bytes`);
  }
  if (downloadedBytes !== manifest.byteLength) {
    throw new Error(`total byte count mismatch: got ${downloadedBytes}, expected ${manifest.byteLength}`);
  }
  console.log(`PASS downloaded all chunks; total_bytes=${downloadedBytes}`);

  console.log("4/5 Reassemble and verify the recovered snapshot...");
  const snapshot = new Uint8Array(downloadedBytes);
  let offset = 0;
  const hash = createHash("sha256");
  for (const part of parts) {
    snapshot.set(part, offset);
    hash.update(part);
    offset += part.byteLength;
  }
  const digest = hash.digest("hex");
  console.log(`PASS SHA256=${digest}`);
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error(`SHA-256 mismatch: got ${digest}, expected ${expectedDigest}`);
  }
  if (expectedDigest) console.log("PASS digest matches EXPECTED_SNAPSHOT_SHA256");
  if (outputPath) {
    await writeFile(outputPath, snapshot, { flag: "wx" });
    console.log(`PASS wrote recovered snapshot to ${outputPath}`);
  }

  console.log("5/5 Verify unauthenticated access is denied...");
  const unauthenticated = await fetch(`${baseUrl}/api/vm-snapshots/${encodeURIComponent(accountId)}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (unauthenticated.status !== 401) {
    throw new Error(`expected unauthenticated manifest request to return 401; got ${unauthenticated.status}`);
  }
  console.log("PASS unauthenticated request rejected with HTTP 401");
  console.log(JSON.stringify({
    result: "PASS",
    account_id: accountId,
    generation: manifest.generation,
    chunks: manifest.chunks,
    byte_length: downloadedBytes,
    sha256: digest,
    saved_at: manifest.savedAt ?? null,
    output_path: outputPath ?? null,
    session_authenticated: true,
    unauthenticated_denied: true,
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

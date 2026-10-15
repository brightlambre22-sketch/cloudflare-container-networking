/**
 * Transactional R2 persistence for a server-side v86 saved state.
 *
 * The caller must run the guest boot/network/HTTPS checks before calling
 * commitGuestSnapshot(). Chunks are written and read back first; the manifest
 * is the commit record and is written last. This module deliberately does not
 * decide whether guest checks passed.
 */
export const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
export const SNAPSHOT_MAX_CHUNKS = 128;

export interface GuestSnapshotManifest {
  version: 1;
  identity: string;
  generation: string;
  chunks: number;
  byteLength: number;
  sha256: string;
  savedAt: string;
  checks: {
    guest_booted: true;
    shell_command_passed: true;
    dhcp_passed: true;
    dns_passed: true;
    https_passed: true;
  };
}

export interface GuestCheckResults {
  guest_booted: boolean;
  shell_command_passed: boolean;
  dhcp_passed: boolean;
  dns_passed: boolean;
  https_passed: boolean;
}

function validIdentity(value: string): boolean {
  return /^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(value);
}

function validGeneration(value: string): boolean {
  return /^[a-z0-9-]{1,40}$/.test(value);
}

export function splitSnapshot(state: ArrayBuffer | Uint8Array): Uint8Array[] {
  const bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
  if (bytes.byteLength < 1 || bytes.byteLength > SNAPSHOT_MAX_BYTES) {
    throw new Error("snapshot_size_out_of_range");
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, Math.min(offset + SNAPSHOT_CHUNK_BYTES, bytes.byteLength)));
  }
  if (chunks.length > SNAPSHOT_MAX_CHUNKS) throw new Error("snapshot_chunk_count_out_of_range");
  return chunks;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Persist a v86 saved-state byte buffer under an isolated identity. This is
 * intentionally fail-closed: no manifest means no committed snapshot.
 */
export async function commitGuestSnapshot(
  bucket: R2Bucket,
  identity: string,
  generation: string,
  state: ArrayBuffer | Uint8Array,
  checks: GuestCheckResults,
): Promise<GuestSnapshotManifest> {
  if (!validIdentity(identity)) throw new Error("snapshot_identity_invalid");
  if (!validGeneration(generation)) throw new Error("snapshot_generation_invalid");
  if (!checks.guest_booted || !checks.shell_command_passed || !checks.dhcp_passed ||
      !checks.dns_passed || !checks.https_passed) {
    throw new Error("guest_acceptance_checks_failed");
  }

  const bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
  const chunks = splitSnapshot(bytes);
  const digest = await sha256Hex(bytes);
  const prefix = `vm-snapshots/${identity}/`;
  const generationPrefix = `${prefix}${generation}/`;

  // Never overwrite a generation. A retry must use a fresh UUID generation.
  if (await bucket.head(prefix + "manifest.json")) {
    const existing = await bucket.get(prefix + "manifest.json");
    const manifest = existing ? await existing.json<GuestSnapshotManifest>() : null;
    if (manifest?.generation === generation) throw new Error("snapshot_generation_already_committed");
  }

  try {
    await Promise.all(chunks.map((chunk, part) =>
      bucket.put(`${generationPrefix}${part}.bin`, chunk, {
        httpMetadata: { contentType: "application/octet-stream" },
      }),
    ));

    // Verify R2's persisted bytes before making this generation discoverable.
    const persisted = await Promise.all(chunks.map(async (chunk, part) => {
      const object = await bucket.get(`${generationPrefix}${part}.bin`);
      if (!object) throw new Error("snapshot_chunk_readback_missing_" + part);
      const stored = new Uint8Array(await object.arrayBuffer());
      if (stored.byteLength !== chunk.byteLength) throw new Error("snapshot_chunk_readback_length_mismatch_" + part);
      return stored;
    }));
    const reconstructed = new Uint8Array(bytes.byteLength);
    let offset = 0;
    for (const part of persisted) {
      reconstructed.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== bytes.byteLength || await sha256Hex(reconstructed) !== digest) {
      throw new Error("snapshot_readback_digest_mismatch");
    }

    const manifest: GuestSnapshotManifest = {
      version: 1,
      identity,
      generation,
      chunks: chunks.length,
      byteLength: bytes.byteLength,
      sha256: digest,
      savedAt: new Date().toISOString(),
      checks: {
        guest_booted: true,
        shell_command_passed: true,
        dhcp_passed: true,
        dns_passed: true,
        https_passed: true,
      },
    };
    // Commit marker last: readers must ignore unmanifested generations.
    await bucket.put(prefix + "manifest.json", JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { savedAt: manifest.savedAt, generation, sha256: digest },
    });
    return manifest;
  } catch (error) {
    // Leave no committed manifest pointing at a failed generation. The caller
    // can clean up the uncommitted generation later without harming old state.
    throw error;
  }
}

/** Read a committed snapshot and verify every chunk and the full-state digest. */
export async function readCommittedGuestSnapshot(
  bucket: R2Bucket,
  identity: string,
): Promise<{ manifest: GuestSnapshotManifest; state: Uint8Array }> {
  if (!validIdentity(identity)) throw new Error("snapshot_identity_invalid");
  const prefix = `vm-snapshots/${identity}/`;
  const object = await bucket.get(prefix + "manifest.json");
  if (!object) throw new Error("snapshot_manifest_missing");
  const manifest = await object.json<GuestSnapshotManifest>();
  if (manifest.version !== 1 || manifest.identity !== identity ||
      !validGeneration(manifest.generation) || !Number.isInteger(manifest.chunks) ||
      manifest.chunks < 1 || manifest.chunks > SNAPSHOT_MAX_CHUNKS ||
      !Number.isInteger(manifest.byteLength) || manifest.byteLength < 1 ||
      manifest.byteLength > SNAPSHOT_MAX_BYTES ||
      manifest.chunks !== Math.ceil(manifest.byteLength / SNAPSHOT_CHUNK_BYTES) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("snapshot_manifest_invalid");
  }
  const parts = await Promise.all(Array.from({ length: manifest.chunks }, async (_, part) => {
    const chunk = await bucket.get(`${prefix}${manifest.generation}/${part}.bin`);
    if (!chunk) throw new Error("snapshot_chunk_missing_" + part);
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    const expected = Math.min(SNAPSHOT_CHUNK_BYTES, manifest.byteLength - part * SNAPSHOT_CHUNK_BYTES);
    if (bytes.byteLength !== expected) throw new Error("snapshot_chunk_length_invalid_" + part);
    return bytes;
  }));
  const state = new Uint8Array(manifest.byteLength);
  let offset = 0;
  for (const part of parts) { state.set(part, offset); offset += part.byteLength; }
  if (await sha256Hex(state) !== manifest.sha256) throw new Error("snapshot_digest_invalid");
  return { manifest, state };
}

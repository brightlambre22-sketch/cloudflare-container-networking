import test from "node:test";
import assert from "node:assert/strict";
import {
  commitGuestSnapshot,
  readCommittedGuestSnapshot,
  splitSnapshot,
  SNAPSHOT_CHUNK_BYTES,
} from "../src/headless-snapshot-store.ts";

const passingChecks = {
  guest_booted: true,
  shell_command_passed: true,
  dhcp_passed: true,
  dns_passed: true,
  https_passed: true,
};

function memoryBucket() {
  const values = new Map<string, Uint8Array>();
  const bucket = {
    async head(key: string) {
      const value = values.get(key);
      return value ? { size: value.byteLength } : null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      else throw new Error("stream_not_supported_by_test_double");
      values.set(key, bytes.slice());
      return { key };
    },
    async get(key: string) {
      const bytes = values.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
        async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, values };
}

test("splits saved-state bytes into bounded 8 MiB chunks", () => {
  const bytes = new Uint8Array(SNAPSHOT_CHUNK_BYTES + 19);
  bytes[0] = 7;
  bytes[SNAPSHOT_CHUNK_BYTES] = 9;
  const chunks = splitSnapshot(bytes);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, SNAPSHOT_CHUNK_BYTES);
  assert.equal(chunks[1].byteLength, 19);
  assert.equal(chunks[1][0], 9);
});

test("does not commit a snapshot until all guest acceptance checks pass", async () => {
  const { bucket, values } = memoryBucket();
  await assert.rejects(
    commitGuestSnapshot(bucket, "test-roundtrip-1", "gen-1", new Uint8Array([1, 2, 3]), {
      ...passingChecks,
      https_passed: false,
    }),
    /guest_acceptance_checks_failed/,
  );
  assert.equal(values.has("vm-snapshots/test-roundtrip-1/manifest.json"), false);
});

test("writes, reads back, and verifies a committed snapshot round trip", async () => {
  const { bucket, values } = memoryBucket();
  const state = new Uint8Array(2 * 1024 * 1024 + 37);
  for (let i = 0; i < state.length; i += 7919) state[i] = (i * 17) & 0xff;
  const manifest = await commitGuestSnapshot(bucket, "test-roundtrip-2", "gen-2", state, passingChecks);
  assert.equal(manifest.byteLength, state.byteLength);
  assert.equal(manifest.chunks, 1);
  assert.equal(values.has("vm-snapshots/test-roundtrip-2/manifest.json"), true);
  const restored = await readCommittedGuestSnapshot(bucket, "test-roundtrip-2");
  assert.deepEqual(restored.state, state);
  assert.equal(restored.manifest.sha256, manifest.sha256);
});

test("fails closed when a committed snapshot chunk is corrupted", async () => {
  const { bucket, values } = memoryBucket();
  const state = new Uint8Array([1, 2, 3, 4, 5]);
  await commitGuestSnapshot(bucket, "test-roundtrip-3", "gen-3", state, passingChecks);
  values.set("vm-snapshots/test-roundtrip-3/gen-3/0.bin", new Uint8Array([9, 9, 9, 9, 9]));
  await assert.rejects(readCommittedGuestSnapshot(bucket, "test-roundtrip-3"), /snapshot_digest_invalid/);
});

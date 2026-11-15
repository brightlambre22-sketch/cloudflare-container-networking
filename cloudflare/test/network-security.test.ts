import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedDestination } from "../src/network-security.ts";

test("WISP allows only public IPv4 HTTP and HTTPS destinations", () => {
  assert.equal(isAllowedDestination("1.1.1.1", 443), true);
  assert.equal(isAllowedDestination("8.8.8.8", 80), true);
  for (const address of [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "100.100.100.200", "168.63.129.16",
    "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "256.1.1.1", "01.2.3.4",
    "::1", "localhost"
  ]) {
    assert.equal(isAllowedDestination(address, 443), false, address);
  }
  assert.equal(isAllowedDestination("1.1.1.1", 22), false);
  assert.equal(isAllowedDestination("1.1.1.1", 8080), false);
});

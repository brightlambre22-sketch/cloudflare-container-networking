import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../public/runner/tinycore/browser-bootstrap.sh", import.meta.url), "utf8");

test("inline browser scripts parse", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.some((match) => match[1].trim()));
  for (const [index, match] of scripts.entries()) {
    const source = match[1].trim();
    if (source) assert.doesNotThrow(() => new vm.Script(source), "inline script " + (index + 1));
  }
});

test("shell prompt detection accepts the active Tiny Core prompt and ignores trailing blank rows", () => {
  const match = html.match(/function shellPrompt\(text\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match);
  const prompt = vm.runInNewContext("(" + match[0] + ")");
  assert.equal(prompt("boot output\n tc@box:~$\n\n\n"), "tc@box:~$");
  assert.equal(prompt("tc@box:~$\ncommand still running\n\n"), "");
});

test("VM starts with the built NE2000 Tiny Core image and account-authenticated WISP networking", () => {
  assert.ok(html.includes("cdrom:{url:'/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso'}"));
  assert.ok(html.includes("type:'ne2k',relay_url:relayUrl,router_ip:routerIp,vm_ip:virtualIp"));
  assert.ok(html.includes("masquerade:true,dns_method:'doh',doh_server:'cloudflare-dns.com'"));
  assert.ok(html.includes("wisps://'+window.location.host+'/api/network/wisp/"));
  assert.ok(html.includes("/api/network/ticket"));
  assert.ok(html.includes("networkIdentity"));
  assert.ok(html.includes("ticketData.ticket"));
  assert.ok(!html.includes("relay.widgetry.org"));
});

test("DHCP startup applies the account MAC and retries until the assigned address and gateway are active", () => {
  assert.ok(html.includes("/sbin/modprobe ne2k-pci"));
  assert.ok(html.includes("NIC_MISSING"));
  assert.ok(html.includes("DHCP_EXPECTED_IP=$ip"));
  assert.ok(html.includes("DHCP_ASSIGNED_IP=$ip"));
  assert.ok(html.includes("DHCP_ASSIGNED_GATEWAY=$gw"));
  assert.ok(html.includes("/sbin/udhcpc -f -n -q -i"));
  assert.ok(html.includes("DHCP_OK"));
  assert.ok(html.includes("DHCP_DONE"));
  assert.ok(html.includes("while [ \"$n\" -le 8 ]"));
});

test("restored snapshots are automatically woken and verified with a stable prompt and echo round-trip", () => {
  assert.ok(html.includes("AUTOMATIC RESTORED SHELL WAKE"));
  assert.ok(html.includes("verifyRestoredGuestShell()"));
  assert.ok(html.includes("await sendVmCommand('\\n')"));
  assert.ok(html.includes("PROMPT_STABLE_MS=2000"));
  assert.ok(html.includes("RESTORED_GUEST_SHELL_VERIFIED=1"));
  assert.ok(html.includes("echo '+marker"));
  assert.ok(html.includes("Saved snapshot was not modified"));
});

test("new account baselines bootstrap once while existing restored snapshots avoid a destructive fresh boot", () => {
  assert.ok(html.includes("record.bootstrapRequired"));
  assert.ok(html.includes("New account baseline restored; running one-time VM setup"));
  assert.ok(html.includes("if(restoredSnapshot)"));
  assert.ok(html.includes("snapshotLoadFailed"));
  assert.ok(html.includes("refusing to overwrite server state"));
});

test("startup wakes the shell before the first command and waits for a bounded boot prompt", () => {
  assert.ok(html.includes("KEYBOARD INPUT WAKE"));
  assert.ok(html.includes("await sendVmCommand('\\n')"));
  assert.ok(html.includes("const BOOT_TIMEOUT_MS=300000"));
  assert.ok(html.includes("/^boot:\\s*$/i.test(line.trim())"));
  assert.ok(html.includes("BOOT TIMEOUT after "));
});

test("startup completion markers match the sequential command controller", () => {
  const normalized = html.replace(/""\s*""/g, "");
  for (const marker of ["DHCP_DONE","__RESOURCE_PREFLIGHT_DONE","__TLS_DOWNLOAD_DONE:","__OPENSSL_INSTALL_DONE:","__CA_CERTIFICATES_INSTALL_DONE:","__EGRESS_PREFLIGHT_DONE:"]) {
    assert.ok(normalized.includes(marker), "expected startup marker: " + marker);
  }
  assert.ok(html.includes("const markers=['DHCP_DONE'"));
  assert.ok(html.includes("markerCount(t,marker)>markerCountBefore"));
  assert.ok(html.includes("shellPrompt(t.slice(markerAt+marker.length))"));
});

test("TLS and CA certificate packages install in the foreground before HTTPS validation", () => {
  assert.ok(html.includes("tce-load -w openssl-1.1.1.tcz"));
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -i openssl-1.1.1"));
  assert.ok(html.includes("tce-load -i ca-certificates"));
  assert.ok(html.includes("CA_BUNDLE_PATH=$CA_BUNDLE"));
  assert.ok(!html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1 &"));
  assert.ok(!html.includes("tce-load -i ca-certificates >/tmp/ca.log 2>&1 &"));
  assert.ok(html.includes("__EGRESS_PREFLIGHT_DONE:"));
});

test("startup saves a snapshot only after DHCP, TLS, DNS, HTTP, and HTTPS checks succeed", () => {
  assert.ok(html.includes("DHCP, CA, DNS, HTTP, and HTTPS checks complete. Saving"));
  assert.ok(html.includes("DNS/HTTP/HTTPS preflight failed; snapshot not saved."));
  assert.ok(html.includes("saved=await saveVmState(false)"));
  assert.ok(html.includes("Automatic snapshot save failed after 3 attempts."));
});

test("the active diagnostic scripts are served from same-origin Worker assets", () => {
  assert.ok(html.includes("${apiUrl}/health"));
  assert.ok(html.includes("${apiUrl}/runner/tinycore/network-test.sh"));
  assert.ok(html.includes("${apiUrl}/runner/tinycore/fineproxy-test.sh"));
  assert.ok(bootstrap.includes("Mysterium bootstrap is temporarily disabled."));
  assert.ok(!bootstrap.includes("wget "));
  assert.ok(!bootstrap.includes("/opt/mysterium/myst"));
});

test("the account terminal is enabled only after the restored or freshly booted shell is verified", () => {
  assert.ok(html.includes("checkAccountExecution()"));
  assert.ok(html.includes("connectApiAgent()"));
  assert.ok(html.includes("bootComplete=true"));
  assert.ok(html.includes("RESTORED_GUEST_SHELL_VERIFIED=1"));
});

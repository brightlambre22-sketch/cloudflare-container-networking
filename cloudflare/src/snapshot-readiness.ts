export interface BaselineManifest {
  version?: unknown;
  generation?: unknown;
  chunks?: unknown;
  byteLength?: unknown;
  savedAt?: unknown;
  adminReady?: unknown;
  checks?: {
    guest_booted?: unknown;
    shell_command_passed?: unknown;
    dhcp_passed?: unknown;
    ca_certificates_passed?: unknown;
  };
}

/** Keep the admin baseline contract shared by the uploader and account provisioner. */
export function baselineIsReady(value: BaselineManifest): boolean {
  const checks = value.checks;
  return value.adminReady === true && Boolean(checks) &&
    checks!.guest_booted === true && checks!.shell_command_passed === true &&
    checks!.dhcp_passed === true && checks!.ca_certificates_passed === true;
}

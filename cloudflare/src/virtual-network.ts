export const VIRTUAL_NETWORK = {
  cidr: "10.240.0.0/16",
  gateway: "10.240.0.1",
  first_allocatable_host: 2,
  last_allocatable_host: 65534,
} as const;

export function isVirtualPrivateIp(value: string): boolean {
  const match = /^(10\.240)\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const third = Number(match[2]);
  const fourth = Number(match[3]);
  return third >= 0 && third <= 255 && fourth >= 1 && fourth <= 254;
}

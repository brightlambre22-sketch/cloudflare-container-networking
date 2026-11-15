export function isAllowedDestination(host: string, port: number): boolean {
  if (port !== 80 && port !== 443) return false;
  // v86 sends a resolved IPv4 address. Reject non-canonical values and special-use
  // ranges, including Oracle/AWS/Azure/Alibaba metadata destinations.
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b, c, d] = octets;
  const blocked =
    a === 0 || a === 10 || a === 127 || a >= 224 || a === 255 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 168 && b === 63 && c === 129 && d === 16);
  return !blocked;
}

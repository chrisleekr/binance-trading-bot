import { isIP } from 'node:net';

/**
 * The client IP from the forwarding headers of a request that crossed exactly one trusted proxy.
 *
 * The proxy appends the real client to the RIGHT of `x-forwarded-for`, so the leftmost entries are whatever the client sent and are forgeable; only the rightmost is trusted. Falls back to `x-real-ip`, then the literal `unknown`, so callers keying limits or audit rows always get a string. Better Auth's session hook and the Hono middleware both call this, so there is one answer to "who is this" per request.
 *
 * @param headers - The incoming request headers.
 * @returns The rightmost forwarded hop, `x-real-ip`, or `unknown`. Not validated; use {@link addressLimitKey} before keying a limit on it.
 */
export const clientIpFromHeaders = (headers: Headers): string => {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const realIp = headers.get('x-real-ip')?.trim();
  return hops.at(-1) ?? (realIp !== undefined && realIp.length > 0 ? realIp : 'unknown');
};

/**
 * Expands an IPv6 literal to eight 16-bit groups. The limit key groups an address by its leading groups, and the textual form cannot be sliced for that: `::` compression and an embedded IPv4 tail let one address be written many ways, and each spelling would otherwise get its own budget. A zone suffix (`%eth0`) is dropped for the same reason.
 *
 * @param address - A string `isIP` already classified as IPv6.
 * @returns The eight groups, with an embedded IPv4 tail folded into the last two, or null when the text does not expand to exactly eight valid groups.
 */
const expandIpv6 = (address: string): number[] | null => {
  const zoneless = address.split('%')[0] ?? address;
  let text = zoneless;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (isIP(maybeV4) === 4) {
    const octets = maybeV4.split('.').map(Number);
    tail.push(
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    );
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff))
    return null;
  if (tail.length === 2) groups.splice(6, 2, tail[0] ?? 0, tail[1] ?? 0);
  return groups;
};

/**
 * Normalises a client address into the key a per-address limit counts against.
 *
 * IPv4 is used as is. IPv6 is grouped by its /64, because one ordinary subscriber is routinely handed a whole /64 and could otherwise rotate through 2^64 fresh budgets; the /48 is returned separately for the coarser tier. An address that is not a valid IP (a malformed header, or `unknown` when no header was sent) shares one deliberately tight bucket rather than each getting its own.
 *
 * @param address - The value from {@link clientIpFromHeaders}.
 * @returns The key to count against, and for IPv6 the /48 key of the wider tier.
 */
export const addressLimitKey = (address: string): { key: string; wideKey: string | null } => {
  const version = isIP(address);
  if (version === 4) return { key: `v4:${address}`, wideKey: null };
  if (version === 6) {
    const groups = expandIpv6(address);
    if (groups === null) return { key: 'invalid', wideKey: null };
    // An IPv4-mapped address (::ffff:a.b.c.d) is an IPv4 client. Grouping it by /64 would put every IPv4 client behind a dual-stack socket into one shared bucket.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const hi = groups[6] ?? 0;
      const lo = groups[7] ?? 0;
      return { key: `v4:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, wideKey: null };
    }
    const hex = groups.map((g) => g.toString(16));
    return {
      key: `v6:${hex.slice(0, 4).join(':')}::/64`,
      wideKey: `v6:${hex.slice(0, 3).join(':')}::/48`,
    };
  }
  return { key: 'invalid', wideKey: null };
};

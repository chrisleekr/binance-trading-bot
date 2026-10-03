import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

/** Metadata documents are small by specification: the CIMD plugin re-reads the body this transport returns and refuses a metadata document over 5 KB, so anything buffered past that is already rejected one layer up. The cap here stays a single number rather than two because the transport is handed a URL without being told whether it points at a metadata document or at a discovery-owned resource such as a JWKS, and a cap picked by guessing which one it is would refuse a legitimate key set. One cap, set far above the document budget so no legitimate discovery resource is refused here and the plugin's own limit stays the binding one, bounds what a single anonymous `client_id` can make this process buffer. A body larger than this is either a mistake or an attempt to make this process pay for someone else's bandwidth, and either way it is not a client registration. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

/** Socket inactivity budget. `https.request`'s `timeout` option destroys the socket only when nothing moves on it, so it catches a host that goes silent and nothing else. */
const SOCKET_IDLE_TIMEOUT_MS = 5_000;

/** Wall-clock budget for the whole exchange, measured from the call: DNS resolution and every address attempt draw on the same budget rather than each getting a fresh one. The idle timer above restarts on every byte, so a host that trickles one byte every few seconds stays under both that timer and the document cap forever while holding a request handler open. The CIMD plugin also holds a global fetch permit until this transport settles, so a hanging resolver or a string of silent addresses would otherwise hold that permit for a multiple of this budget. Set above the idle budget so an ordinarily slow but progressing transfer still completes. */
const REQUEST_DEADLINE_MS = 10_000;

/**
 * Dotted-quad to a 32-bit number. Deliberately strict: a leading zero is an octal invitation and a short form like `127.1` is a valid address to some resolvers, so anything but four plain decimal octets is rejected and the caller treats that as special-use.
 *
 * @param text - A candidate IPv4 literal with no zone index.
 * @returns The address as an unsigned 32-bit value, or undefined when the text is not exactly four decimal octets.
 */
function parseIpv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * One run of colon-separated v6 groups, with the trailing dotted-quad form permitted in the last position.
 *
 * @param text - The text on one side of a `::`, or the whole address when there is none. An empty string is an empty run.
 * @returns The 16-bit groups it denotes, or undefined when any piece is not a valid group.
 */
const parseIpv6Groups = (text: string): number[] | undefined => {
  if (text === '') return [];
  const parts = text.split(':');
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part.includes('.')) {
      const embedded = parseIpv4(part);
      if (embedded === undefined) return undefined;
      groups.push(Math.floor(embedded / 65_536), embedded % 65_536);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
};

/**
 * Textual IPv6 to its 16 bytes, so ranges can be compared by prefix arithmetic rather than by string shape.
 *
 * @param text - A lowercased IPv6 literal with any zone index already stripped.
 * @returns The address as 16 bytes, or undefined when it does not parse, which the caller treats as special-use.
 */
function parseIpv6(text: string): Uint8Array | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = parseIpv6Groups(halves[0] ?? '');
  if (head === undefined) return undefined;
  let groups = head;
  if (halves.length === 2) {
    const tail = parseIpv6Groups(halves[1] ?? '');
    if (tail === undefined) return undefined;
    // `::` stands for at least one group of zeros, so a run that already fills the address leaves nothing for it to elide.
    const elided = 8 - head.length - tail.length;
    if (elided < 1) return undefined;
    groups = [...head, ...Array<number>(elided).fill(0), ...tail];
  }
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = (group >>> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** A malformed literal in the tables below would silently widen what this module lets through, so it fails at module load instead. */
const parsedIpv4Prefix = (text: string): number => {
  const value = parseIpv4(text);
  if (value === undefined) throw new Error(`cimd: unparseable IPv4 prefix ${text}`);
  return value;
};

const parsedIpv6Prefix = (text: string): Uint8Array => {
  const value = parseIpv6(text);
  if (value === undefined) throw new Error(`cimd: unparseable IPv6 prefix ${text}`);
  return value;
};

/** RFC 6890 and its successors, as `[base, prefix bits]`. 224/4 and 240/4 together cover multicast, reserved and broadcast in one sweep. */
const IPV4_SPECIAL: readonly (readonly [number, number])[] = [
  [parsedIpv4Prefix('0.0.0.0'), 8],
  [parsedIpv4Prefix('10.0.0.0'), 8],
  [parsedIpv4Prefix('100.64.0.0'), 10],
  [parsedIpv4Prefix('127.0.0.0'), 8],
  [parsedIpv4Prefix('169.254.0.0'), 16],
  [parsedIpv4Prefix('172.16.0.0'), 12],
  [parsedIpv4Prefix('192.0.0.0'), 24],
  [parsedIpv4Prefix('192.0.2.0'), 24],
  [parsedIpv4Prefix('192.88.99.0'), 24],
  [parsedIpv4Prefix('192.168.0.0'), 16],
  [parsedIpv4Prefix('198.18.0.0'), 15],
  [parsedIpv4Prefix('198.51.100.0'), 24],
  [parsedIpv4Prefix('203.0.113.0'), 24],
  [parsedIpv4Prefix('224.0.0.0'), 4],
  [parsedIpv4Prefix('240.0.0.0'), 4],
];

/**
 * The v6 half of the same registry. Five of these carry an IPv4 address inside a v6 one and are the reason a textual prefix check is not enough: `::ffff:` (IPv4-mapped), both NAT64 prefixes, `2002::/16` (6to4) and `2001::/23`, which contains Teredo at `2001::/32`.
 *
 * NAT64 needs both of its prefixes listed. RFC 6052 section 3.1 forbids translating a non-global IPv4 address through the well-known `64:ff9b::/96`, which is exactly why RFC 8215 reserved `64:ff9b:1::/48` for local use: the local-use prefix is what an operator deploys to translate RFC 1918 and link-local space, so `64:ff9b:1::a9fe:a9fe` is the form that actually reaches the cloud credential endpoint, while the same suffix under the well-known prefix is the case the specification rules out.
 *
 * `2001::/23` is the IETF Protocol Assignments block, one entry covering Teredo, benchmarking at `2001:2::/48` and ORCHID at `2001:10::/28` and `2001:20::/28`. It stops short of `2001:db8::/32`, which is why documentation space is a separate entry rather than something the widening absorbs. `ff00::/8` is multicast, the counterpart of the v4 `224/4` above.
 *
 * `100:0:0:1::/64` (dummy prefix, RFC 9780), `3fff::/20` (documentation, RFC 9637) and `5f00::/16` (SRv6 SIDs, RFC 9602) are later registry entries marked not globally reachable, so a public metadata host has no reason to resolve into any of them.
 */
const IPV6_SPECIAL: readonly (readonly [Uint8Array, number])[] = [
  [parsedIpv6Prefix('::'), 128],
  [parsedIpv6Prefix('::1'), 128],
  [parsedIpv6Prefix('::ffff:0:0'), 96],
  [parsedIpv6Prefix('64:ff9b::'), 96],
  [parsedIpv6Prefix('64:ff9b:1::'), 48],
  [parsedIpv6Prefix('100::'), 64],
  [parsedIpv6Prefix('100:0:0:1::'), 64],
  [parsedIpv6Prefix('2001::'), 23],
  [parsedIpv6Prefix('2001:db8::'), 32],
  [parsedIpv6Prefix('2002::'), 16],
  [parsedIpv6Prefix('3fff::'), 20],
  [parsedIpv6Prefix('5f00::'), 16],
  [parsedIpv6Prefix('fc00::'), 7],
  [parsedIpv6Prefix('fe80::'), 10],
  [parsedIpv6Prefix('ff00::'), 8],
];

const matchesIpv4Prefix = (value: number, base: number, bits: number): boolean => {
  const blockSize = 2 ** (32 - bits);
  return Math.floor(value / blockSize) === Math.floor(base / blockSize);
};

const matchesIpv6Prefix = (value: Uint8Array, base: Uint8Array, bits: number): boolean => {
  const wholeBytes = bits >>> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (value[index] !== base[index]) return false;
  }
  const remainingBits = bits & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((value[wholeBytes] ?? 0) & mask) === ((base[wholeBytes] ?? 0) & mask);
};

/**
 * RFC 6890 special-use ranges. A CIMD `client_id` is an attacker-supplied URL, so a hostname that resolves inward is the SSRF vector: the fetch would run from inside the trust boundary that holds the plaintext Binance keys, and `169.254.169.254` in particular is a cloud credential endpoint. Checked against the RESOLVED address rather than the hostname, because DNS is the part that lies.
 *
 * The address is classified numerically against the registry rather than by textual prefix, because several v6 ranges carry a v4 address inside them and reach the same internal targets under a shape no string prefix catches. What such a reach actually buys is bounded: the transport is https only and the certificate identity stays bound to the attacker's hostname, so an internal service without a matching certificate fails the handshake. That is a blind reachability and port probe, not response exfiltration, which is why this is hardening rather than a live data leak.
 *
 * Anything the parser cannot classify is treated as special-use, so a form this module does not understand cannot be reached.
 *
 * @param ip - A resolved address in the textual form `node:dns` returns it, possibly carrying a `%zone` suffix.
 * @returns True when the address falls in a range that must never be reached from here, and true for any address that does not parse.
 */
const isSpecialUse = (ip: string): boolean => {
  // A zone index is a local interface selector, never part of the address, and leaving it attached would make every scoped address unparseable-and-refused for the wrong reason.
  const address = (ip.split('%')[0] ?? '').toLowerCase();
  if (address.includes(':')) {
    const bytes = parseIpv6(address);
    if (bytes === undefined) return true;
    return IPV6_SPECIAL.some(([base, bits]) => matchesIpv6Prefix(bytes, base, bits));
  }
  const value = parseIpv4(address);
  if (value === undefined) return true;
  return IPV4_SPECIAL.some(([base, bits]) => matchesIpv4Prefix(value, base, bits));
};

/** Every refusal this transport makes is a policy decision rather than a transport failure, and the CIMD plugin logs the reason, so the distinct type keeps a refusal from reading as a flaky network. */
export class CimdTransportRefusal extends Error {
  public constructor(message: string) {
    super(`cimd: ${message}`);
    this.name = 'CimdTransportRefusal';
  }
}

const targetUrl = (input: string | URL | Request): URL =>
  input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);

const methodOf = (input: string | URL | Request, init?: RequestInit): string => {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
};

const signalOf = (input: string | URL | Request, init?: RequestInit): AbortSignal | undefined => {
  if (init?.signal != null) return init.signal;
  if (input instanceof Request) return input.signal;
  return undefined;
};

/**
 * SSRF-hardened GET/HEAD for CIMD metadata documents and the discovery-owned resources they point at, such as `jwks_uri`. Bun cannot use `@better-auth/cimd/node`, whose bundled transport is Node-only, so the plugin's required guarantees are supplied here instead: https only, resolve once, refuse every RFC 6890 result, pin the approved address while leaving TLS identity bound to the hostname, GET and HEAD only, and no redirects.
 *
 * The hostname is resolved exactly once and the approved address is handed to the socket through `lookup`. Putting the address in `host` would verify the certificate against the IP and turn the pin into a certificate-identity bypass; resolving a second time at connect time would reopen the DNS-rebinding window the single resolution closes.
 *
 * Bun 1.4.2 rejects Node's documented three-argument lookup callback with `ERR_INVALID_IP_ADDRESS`, so the array form is the only one that reaches the socket.
 *
 * @param input - Target resource, as a URL, a string, or a Request the plugin built. Anything but https is refused before a packet moves.
 * @param init - Standard fetch init, of which the method and the abort signal are honoured; only GET and HEAD are permitted, and an abort destroys the in-flight request.
 * @returns The response, whose body is capped rather than streamed. Rejects on policy refusal, on a redirect, on a TLS identity failure, on caller abort, and on the wall-clock deadline, which covers the whole exchange from DNS resolution through the last address attempt.
 */
export const fetchClientMetadataResource = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const startedAt = Date.now();
  const target = targetUrl(input);
  if (target.protocol !== 'https:') {
    throw new CimdTransportRefusal(`refusing non-https target ${target.protocol}`);
  }
  const method = methodOf(input, init);
  if (method !== 'GET' && method !== 'HEAD') {
    throw new CimdTransportRefusal(`refusing method ${method}`);
  }
  const signal = signalOf(input, init);

  const resolved = await lookupWithinBudget(target.hostname, REQUEST_DEADLINE_MS, signal);
  const approved = resolved.filter((entry) => !isSpecialUse(entry.address));
  if (approved.length === 0) {
    throw new CimdTransportRefusal(`${target.hostname} resolves only to special-use addresses`);
  }

  // Every approved address is tried, in resolution order, until one connects. Committing to the first is what a single `find` did, and it is wrong wherever DNS answers AAAA-first on a host with no route to IPv6: the connect fails and the document is unreachable, which on this deployment means CIMD registration cannot happen at all. Resolution still happens exactly once, so the rebinding window this closes stays closed, and each candidate is checked against the special-use rule before it is offered.
  let lastError: Error = new CimdTransportRefusal(`${target.hostname} had no reachable address`);
  for (const candidate of approved) {
    const budgetMs = REQUEST_DEADLINE_MS - (Date.now() - startedAt);
    if (budgetMs <= 0) {
      throw new CimdTransportRefusal(`exceeded ${REQUEST_DEADLINE_MS}ms deadline`);
    }
    try {
      return await attempt(target, method, candidate, budgetMs, signal);
    } catch (err) {
      // A refusal is a verdict about the document, not about this address: a redirect, an oversized body, a blown deadline, a caller abort or a certificate that does not match the hostname would be answered identically by every other address, so it ends the attempt rather than moving on. A socket that goes silent before any response is not a refusal; `attempt` reports it as ETIMEDOUT so a dropped route falls through to the next address.
      if (err instanceof CimdTransportRefusal || !isConnectFailure(err)) throw err;
      lastError = err as Error;
    }
  }
  throw lastError;
};

/**
 * `dns/promises.lookup` takes no signal and has no timeout of its own, so a resolver that never answers would hold the caller, and the plugin's fetch permit, forever. It is raced against the deadline and the abort signal instead; the lookup itself cannot be cancelled and is left to settle unobserved.
 *
 * @param hostname - The target hostname, resolved exactly once.
 * @param budgetMs - Milliseconds the lookup may take; the whole exchange budget, since nothing has run before it.
 * @param signal - The caller's abort signal, if any.
 * @returns Every resolved address. Rejects with a refusal on the deadline or on caller abort, and with the resolver's own error when resolution fails.
 */
const lookupWithinBudget = (
  hostname: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<LookupAddress[]> =>
  new Promise<LookupAddress[]>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CimdTransportRefusal('aborted by caller'));
      return;
    }
    // Started before the timer and listener exist, so a synchronous throw rejects this promise without leaving either behind.
    const pending = lookup(hostname, { all: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CimdTransportRefusal('aborted by caller'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new CimdTransportRefusal(`dns lookup exceeded ${REQUEST_DEADLINE_MS}ms deadline`));
    }, budgetMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (addresses) => {
        cleanup();
        resolve(addresses);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });

/** Connection-level failures worth trying the next address for. Anything else is the server answering, and a second address would answer the same way. */
const isConnectFailure = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET'
  );
};

/**
 * One connection attempt against one already-approved address.
 *
 * @param target - Parsed target URL; its hostname stays the TLS identity so pinning the address cannot weaken certificate verification.
 * @param method - Already restricted to GET or HEAD by the caller.
 * @param approved - The resolved address this attempt pins to, checked against the special-use rule by the caller.
 * @param budgetMs - What is left of the whole-exchange deadline when this attempt starts, not a fresh deadline, so falling through several addresses cannot multiply the wall-clock budget.
 * @param signal - The caller's abort signal, if any; aborting destroys the socket instead of leaving the plugin waiting on a request it has given up on.
 * @returns The response, body capped. Rejects on redirect, oversize, TLS identity failure, socket idleness after a response has started, the wall-clock deadline, caller abort, or a connect error (including silence before any response) the caller may retry on another address.
 */
const attempt = (
  target: URL,
  method: string,
  approved: { address: string; family: number },
  budgetMs: number,
  signal?: AbortSignal,
): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CimdTransportRefusal('aborted by caller'));
      return;
    }
    let settled = false;
    let responded = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      req.destroy();
      finish(() => reject(new CimdTransportRefusal('aborted by caller')));
    };
    // Both the deadline timer and the abort listener outlive the socket unless something drops them, and this promise has several exits, so every settle goes through here.
    const finish = (settleWith: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      settleWith();
    };
    const req = httpsRequest(
      {
        host: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { accept: 'application/json' },
        // The array form is load-bearing on Bun; the three-argument Node form throws ERR_INVALID_IP_ADDRESS.
        lookup: (_hostname, _options, cb) => {
          cb(null, [{ address: approved.address, family: approved.family }] as never);
        },
        timeout: SOCKET_IDLE_TIMEOUT_MS,
      },
      (res) => {
        responded = true;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          req.destroy();
          finish(() => reject(new CimdTransportRefusal(`refusing redirect ${status}`)));
          return;
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        res.on('data', (chunk: Uint8Array) => {
          received += chunk.byteLength;
          if (received > MAX_DOCUMENT_BYTES) {
            res.destroy();
            req.destroy();
            finish(() =>
              reject(new CimdTransportRefusal(`document exceeds ${MAX_DOCUMENT_BYTES} bytes`)),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish(() =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status,
                headers: { 'content-type': res.headers['content-type'] ?? 'application/json' },
              }),
            ),
          );
        });
      },
    );
    deadline = setTimeout(() => {
      req.destroy();
      finish(() => reject(new CimdTransportRefusal(`exceeded ${REQUEST_DEADLINE_MS}ms deadline`)));
    }, budgetMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => finish(() => reject(err)));
    req.on('timeout', () => {
      req.destroy();
      // Silence before any response is what a dropped route looks like, typically IPv6 on a host with no v6 route, and the next address may well connect. Once the server has answered, going quiet is about this server and another address would not help.
      const error = responded
        ? new CimdTransportRefusal(`socket idle for ${SOCKET_IDLE_TIMEOUT_MS}ms`)
        : Object.assign(
            new Error(`connect ETIMEDOUT ${approved.address} after ${SOCKET_IDLE_TIMEOUT_MS}ms`),
            { code: 'ETIMEDOUT' },
          );
      finish(() => reject(error));
    });
    req.end();
  });

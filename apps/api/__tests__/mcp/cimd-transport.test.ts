import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchClientMetadataResource } from '../../src/lib/cimd-transport.js';

const dnsLookup = vi.hoisted(() => vi.fn());
const httpsRequest = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));
vi.mock('node:https', () => ({ request: httpsRequest, default: { request: httpsRequest } }));

const HOSTNAME = 'metadata.example.invalid';
const METADATA_URL = `https://${HOSTNAME}/.well-known/oauth-client`;
const PUBLIC_IPV4 = '93.184.216.34';
/** A routable global-unicast v6 address, so it passes the special-use rule and the only reason it fails is the route, which is the real-world case. */
const PUBLIC_IPV6 = '2606:2800:220:1:248:1893:25c8:1946';
/** Stated independently of the transport so the boundary pair below asserts a number rather than reading back whatever the module happens to hold. */
const DOCUMENT_CAP_BYTES = 64 * 1024;

type Listener = (arg?: unknown) => void;

/** Node hands `lookup` the hostname, the resolver options, and a callback. Bun 1.4.2 accepts only the array form of that callback, so the shape is pinned here rather than assumed. */
type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (err: Error | null, value: unknown) => void,
) => void;

interface CapturedRequestOptions {
  readonly host?: string;
  readonly hostname?: string;
  readonly method?: string;
  readonly path?: string;
  readonly lookup?: PinnedLookup;
  readonly rejectUnauthorized?: boolean;
}

interface FakeClientRequest {
  on: (event: string, listener: Listener) => FakeClientRequest;
  end: () => void;
  destroy: () => void;
  emit: (event: string, arg?: unknown) => void;
  /** Destroying the socket is the observable half of a deadline or an abort: without it the transport has only stopped waiting, while the connection it opened into someone else's network stays up. */
  destroyCount: () => number;
}

const fakeClientRequest = (): FakeClientRequest => {
  const listeners = new Map<string, Listener>();
  let destroyed = 0;
  const req: FakeClientRequest = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return req;
    },
    end: () => undefined,
    destroy: () => {
      destroyed += 1;
    },
    emit: (event, arg) => listeners.get(event)?.(arg),
    destroyCount: () => destroyed,
  };
  return req;
};

interface FakeIncomingMessage {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  on: (event: string, listener: Listener) => FakeIncomingMessage;
  destroy: () => void;
  flush: () => void;
  /** Delivers a chunk without ending the body, which is how a host keeps a socket busy forever. */
  push: (text: string) => void;
}

/** A destroyed response delivers nothing further, so a transport that refuses a status and then still resolves off the body would hang instead of quietly succeeding. */
const fakeIncomingMessage = (statusCode: number, body: string): FakeIncomingMessage => {
  const listeners = new Map<string, Listener>();
  let destroyed = false;
  const res: FakeIncomingMessage = {
    statusCode,
    headers: { 'content-type': 'application/json' },
    on: (event, listener) => {
      listeners.set(event, listener);
      return res;
    },
    destroy: () => {
      destroyed = true;
    },
    flush: () => {
      if (destroyed) return;
      listeners.get('data')?.(new TextEncoder().encode(body));
      listeners.get('end')?.();
    },
    push: (text) => {
      if (destroyed) return;
      listeners.get('data')?.(new TextEncoder().encode(text));
    },
  };
  return res;
};

/** The transport registers its `error` and `timeout` listeners after `request()` returns, so every simulated socket event is deferred a microtask past that. */
const respondWith = (statusCode: number, body = '{}'): void => {
  httpsRequest.mockImplementation((_options: unknown, onResponse: Listener) => {
    const req = fakeClientRequest();
    queueMicrotask(() => {
      const res = fakeIncomingMessage(statusCode, body);
      onResponse(res);
      queueMicrotask(() => res.flush());
    });
    return req;
  });
};

const failSocketWith = (error: Error): void => {
  httpsRequest.mockImplementation(() => {
    const req = fakeClientRequest();
    queueMicrotask(() => req.emit('error', error));
    return req;
  });
};

const capturedOptions = (): CapturedRequestOptions => {
  const call = httpsRequest.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[0] ?? {}) as CapturedRequestOptions;
};

const resolvesTo = (address: string, family: 4 | 6): void => {
  dnsLookup.mockResolvedValue([{ address, family }]);
};

/** Under fake timers the awaited DNS lookup and the deferred socket events still run as microtasks, and the deadline timer does not exist until they have. Draining them first is what makes advancing the clock meaningful. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  dnsLookup.mockReset();
  httpsRequest.mockReset();
});

describe('CIMD metadata transport', () => {
  it.each(['http://metadata.example.invalid/x', 'file:///etc/passwd', 'ftp://example.invalid/x'])(
    'refuses %s before any socket work',
    async (url) => {
      // A `client_id` is an attacker-supplied URL fetched from inside the boundary that holds the plaintext Binance keys, so the scheme is decided before DNS runs: a refusal taken after resolution has already leaked the hostname to the attacker's resolver.
      await expect(fetchClientMetadataResource(url)).rejects.toThrow();
      expect(dnsLookup).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses method %s', async (method) => {
    // Discovery is a read. A method that can carry a body turns this helper into a general-purpose outbound request primitive pointed at an attacker-chosen host.
    await expect(fetchClientMetadataResource(METADATA_URL, { method })).rejects.toThrow();
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['0.0.0.0', 4],
    ['10.1.2.3', 4],
    ['127.0.0.1', 4],
    ['169.254.169.254', 4],
    ['172.16.0.1', 4],
    ['172.31.255.255', 4],
    ['192.168.1.1', 4],
    ['100.64.0.1', 4],
    ['224.0.0.1', 4],
    // IETF protocol assignments, 6to4 relay anycast, and the benchmarking block, which is routed inside some corporate and lab networks rather than being merely reserved on paper.
    ['192.0.0.1', 4],
    ['192.88.99.1', 4],
    ['198.18.0.1', 4],
    ['198.19.255.255', 4],
    // Documentation ranges. A metadata host resolving into one is not a host, and treating it as reachable is the same class of mistake as trusting a private range.
    ['192.0.2.5', 4],
    ['198.51.100.7', 4],
    ['203.0.113.9', 4],
    ['240.0.0.1', 4],
    ['255.255.255.255', 4],
    ['::1', 6],
    ['::', 6],
    ['fe80::1', 6],
    ['fc00::1', 6],
    ['fd00::1', 6],
    ['::ffff:127.0.0.1', 6],
    // The whole IPv4-mapped block, not only the loopback inside it: the mapped form reaches v4 destinations whatever they are, and the v4 rules already decide which of those are allowed.
    ['::ffff:169.254.169.254', 6],
    // fe80::/10 spans fe80 through febf, so a textual `fe80` prefix check leaves most of link-local reachable.
    ['fea0::1', 6],
    ['febf::1', 6],
    ['fdff:ffff::1', 6],
    // The v6 ranges that carry a v4 address inside them. RFC 6052 section 3.1 forbids translating a non-global IPv4 address through the well-known NAT64 prefix, so `64:ff9b::a9fe:a9fe` is a shape a conformant translator never emits; the RFC 8215 local-use prefix exists precisely for the RFC 1918 and link-local space an operator does translate, which makes `64:ff9b:1::a9fe:a9fe` the form that actually reaches the cloud credential endpoint. Both are refused, and the second is the reachable one.
    ['64:ff9b::a9fe:a9fe', 6],
    ['64:ff9b:1::a9fe:a9fe', 6],
    // The whole local-use /48, not only the address carrying the credential endpoint: it translates every non-global v4 destination, and the v4 rules above already decide which of those are allowed.
    ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 6],
    ['2002:7f00:1::1', 6],
    ['2001::1', 6],
    // 2001::/23 is the whole IETF Protocol Assignments block, so benchmarking and both ORCHID ranges are covered without an entry each.
    ['2001:2::1', 6],
    ['2001:10::1', 6],
    ['2001:20::1', 6],
    ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', 6],
    // Documentation space sits above 2001::/23, so the wider protocol-assignments entry does not reach it and it is listed on its own.
    ['2001:db8::1', 6],
    ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 6],
    ['100::1', 6],
    // Later IANA special-purpose entries marked not globally reachable: the RFC 9780 dummy prefix, RFC 9637 documentation space, and RFC 9602 SRv6 SIDs.
    ['100:0:0:1::1', 6],
    ['3fff::1', 6],
    ['5f00::1', 6],
    // Multicast, the v6 counterpart of the 224/4 entry above. A metadata host resolving to a group address is not a host, and a request addressed to one goes to whoever joined the group.
    ['ff02::1', 6],
    ['ff05::2', 6],
    ['ffff::1', 6],
    // A zone index is not part of the address, and leaving it attached must not turn a link-local address into something the parser waves through.
    ['fe80::1%eth0', 6],
    // Fail closed: anything the parser cannot classify is refused rather than assumed routable.
    ['definitely-not-an-address', 4],
    ['1.2.3', 4],
    ['010.0.0.1', 4],
    ['1.2.3.4.5', 4],
    ['::gggg', 6],
    ['1:2:3::4:5::6', 6],
  ] as const)('refuses a hostname resolving only to %s', async (address, family) => {
    resolvesTo(address, family);
    respondWith(200);

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow();
    // The refusal has to land before the connection, not after: reaching a link-local metadata service and then discarding the answer is still a reached metadata service.
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['8.8.8.8', 4],
    ['172.32.0.1', 4],
    ['100.128.0.1', 4],
    ['223.255.255.255', 4],
    ['2606:4700:4700::1111', 6],
    // One step outside each newly blocked block, so widening the tables cannot quietly swallow neighbouring public space.
    ['192.0.1.1', 4],
    ['192.0.3.1', 4],
    ['192.88.100.1', 4],
    ['198.17.255.255', 4],
    ['198.20.0.1', 4],
    ['198.51.101.1', 4],
    ['203.0.114.1', 4],
    ['64:ff9c::1', 6],
    // The gap between the two NAT64 prefixes, and the block immediately above the local-use one, so neither NAT64 entry creeps into the space the other leaves alone.
    ['64:ff9b:0:1::1', 6],
    ['64:ff9b:2::1', 6],
    // Above both discard-only /64s, and one step past each of the other two later entries.
    ['100:0:0:2::1', 6],
    ['3fff:1000::1', 6],
    ['5f01::1', 6],
    // 2001::/23 ends at 2001:01ff:ffff:ffff:ffff:ffff:ffff:ffff, so the rest of 2001::/16 stays reachable; the second of these is a real resolver address.
    ['2001:200::1', 6],
    ['2001:4860:4860::8888', 6],
    // Either side of the documentation /32, which 2001::/23 does not cover, so that entry cannot swallow its neighbours.
    ['2001:db7::1', 6],
    ['2001:db9::1', 6],
    ['2003::1', 6],
    ['fbff::1', 6],
    ['fe7f::1', 6],
    // One step below ff00::/8, so multicast cannot creep down into unicast space.
    ['feff::1', 6],
  ] as const)('accepts a hostname resolving to %s', async (address, family) => {
    // The discriminating half of the range check. Each address sits one step outside a special-use block, so a predicate that over-refuses by a bit of arithmetic fails here instead of silently making CIMD unusable.
    resolvesTo(address, family);
    respondWith(200, '{"client_id":"https://metadata.example.invalid/x"}');

    const response = await fetchClientMetadataResource(METADATA_URL);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('client_id');
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses a %i redirect rather than following it',
    async (status) => {
      resolvesTo(PUBLIC_IPV4, 4);
      respondWith(status);

      await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow();
      // Exactly one request proves the redirect was refused rather than followed: a followed hop would re-point the fetch past the address that was approved, which is the whole point of pinning.
      expect(httpsRequest).toHaveBeenCalledTimes(1);
    },
  );

  it('pins the approved address while leaving TLS identity bound to the hostname', async () => {
    resolvesTo(PUBLIC_IPV4, 4);
    const certError = Object.assign(
      new Error("Hostname/IP does not match certificate's altnames"),
      {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      },
    );
    failSocketWith(certError);

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });

    const options = capturedOptions();
    // Connecting to the resolved IP by putting it in `host` would verify the certificate against the IP, which is how a pinning fix quietly turns into a certificate-identity bypass. The hostname stays the peer identity; the address is supplied only through `lookup`.
    expect(options.host ?? options.hostname).toBe(HOSTNAME);
    expect([options.host, options.hostname]).not.toContain(PUBLIC_IPV4);
    expect(options.rejectUnauthorized).not.toBe(false);

    const pinned = await new Promise<unknown>((resolve, reject) => {
      const lookup = options.lookup;
      expect(lookup).toBeDefined();
      lookup?.(HOSTNAME, {}, (err, value) => (err ? reject(err) : resolve(value)));
    });
    // Node documents a three-argument callback, `cb(null, address, family)`, and Bun 1.4.2 throws ERR_INVALID_IP_ADDRESS on it. Only the array form works, so the pin is asserted in the form that actually reaches the socket.
    expect(pinned).toEqual([{ address: PUBLIC_IPV4, family: 4 }]);
    // Resolving a second time at connect time would reopen the DNS-rebinding window the single resolution closes.
    expect(dnsLookup).toHaveBeenCalledTimes(1);
  });

  it('permits HEAD alongside GET', async () => {
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200);

    await expect(
      fetchClientMetadataResource(METADATA_URL, { method: 'HEAD' }),
    ).resolves.toBeDefined();
    expect(capturedOptions().method).toBe('HEAD');
  });

  it('refuses a body past the document cap rather than buffering it', async () => {
    // The cap bounds what one anonymous `client_id` can make this process hold in memory, and the CIMD plugin refuses a metadata document over 5 KB once this transport hands it back, so a body of this size is never a registration. It is bandwidth someone else is spending on our behalf.
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200, 'a'.repeat(DOCUMENT_CAP_BYTES + 1));

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow(/exceeds/i);
  });

  it('accepts a body of exactly the document cap', async () => {
    // The discriminating half of the cap. Without it the refusal above passes for any cap at all, including one low enough to refuse a legitimate discovery resource.
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200, 'a'.repeat(DOCUMENT_CAP_BYTES));

    const response = await fetchClientMetadataResource(METADATA_URL);
    await expect(response.text()).resolves.toHaveLength(DOCUMENT_CAP_BYTES);
  });

  it.each(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'])(
    'moves to the next resolved address when the first fails with %s',
    async (code) => {
      // The real shape of this failure: DNS answers AAAA first, the host has no route to IPv6, and the connect fails. Committing to the first approved address made every metadata document unreachable, and with dynamic registration off that is the whole client-registration path. The fallback is what keeps an agent able to enrol at all.
      dnsLookup.mockResolvedValue([
        { address: PUBLIC_IPV6, family: 6 },
        { address: PUBLIC_IPV4, family: 4 },
      ]);
      const refused = Object.assign(new Error(`connect ${code}`), { code });
      httpsRequest
        .mockImplementationOnce(() => {
          const req = fakeClientRequest();
          queueMicrotask(() => req.emit('error', refused));
          return req;
        })
        .mockImplementationOnce((_options: unknown, onResponse: Listener) => {
          const req = fakeClientRequest();
          queueMicrotask(() => {
            const res = fakeIncomingMessage(200, '{"ok":true}');
            onResponse(res);
            queueMicrotask(() => res.flush());
          });
          return req;
        });

      const res = await fetchClientMetadataResource(METADATA_URL);
      expect(res.status).toBe(200);
      expect(httpsRequest.mock.calls).toHaveLength(2);
      // Still one resolution for both attempts: the candidate list is fixed up front, so falling back cannot become a second lookup and reopen the rebinding window.
      expect(dnsLookup).toHaveBeenCalledTimes(1);
      const second = (httpsRequest.mock.calls[1]?.[0] ?? {}) as CapturedRequestOptions;
      const pinned: string[] = [];
      second.lookup?.(HOSTNAME, {}, (_err, value) => {
        pinned.push(...(value as { address: string }[]).map((entry) => entry.address));
      });
      expect(pinned).toEqual([PUBLIC_IPV4]);
    },
  );

  it('does not try another address when the first one answered with a refusal', async () => {
    // A redirect is a verdict about the document, not about the route to it. Retrying would ask a second server the same question and turn one refusal into several connections.
    dnsLookup.mockResolvedValue([
      { address: PUBLIC_IPV6, family: 6 },
      { address: PUBLIC_IPV4, family: 4 },
    ]);
    respondWith(302);

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow(/redirect/i);
    expect(httpsRequest.mock.calls).toHaveLength(1);
  });

  it('refuses when every resolved address is unreachable', async () => {
    dnsLookup.mockResolvedValue([
      { address: PUBLIC_IPV6, family: 6 },
      { address: PUBLIC_IPV4, family: 4 },
    ]);
    failSocketWith(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }));

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow(/EHOSTUNREACH/);
    expect(httpsRequest.mock.calls).toHaveLength(2);
  });

  it('ends the exchange on a wall-clock deadline even while the socket keeps trickling bytes', async () => {
    // `timeout` on `https.request` is a socket INACTIVITY timer: it restarts on every byte. A host that sends one byte every few seconds therefore resets it forever while staying far under the document cap, and holds a request handler open for as long as it likes. Only a total deadline ends that.
    vi.useFakeTimers();
    try {
      resolvesTo(PUBLIC_IPV4, 4);
      let req: FakeClientRequest | undefined;
      httpsRequest.mockImplementation((_options: unknown, onResponse: Listener) => {
        const created = fakeClientRequest();
        req = created;
        queueMicrotask(() => {
          const res = fakeIncomingMessage(200, '');
          onResponse(res);
          setInterval(() => res.push('x'), 4_000);
        });
        return created;
      });

      const pending = fetchClientMetadataResource(METADATA_URL);
      const settled = expect(pending).rejects.toThrow(/deadline/i);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      // The socket has to go, not just the wait: a transport that only stopped listening has left a live connection into someone else's network.
      expect(req?.destroyCount()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer pending once a response has been delivered', async () => {
    vi.useFakeTimers();
    try {
      resolvesTo(PUBLIC_IPV4, 4);
      respondWith(200, '{"ok":true}');

      await expect(fetchClientMetadataResource(METADATA_URL)).resolves.toBeDefined();
      // A deadline that outlives its own request is a leaked handle, and it would later fire against a socket that is already gone.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys the in-flight request when the caller aborts', async () => {
    // The CIMD plugin can give up on a fetch; discarding its signal leaves the request running against an attacker-chosen host with nobody waiting for the answer.
    resolvesTo(PUBLIC_IPV4, 4);
    let req: FakeClientRequest | undefined;
    httpsRequest.mockImplementation(() => {
      const created = fakeClientRequest();
      req = created;
      return created;
    });
    const controller = new AbortController();

    const pending = fetchClientMetadataResource(METADATA_URL, { signal: controller.signal });
    await vi.waitFor(() => expect(httpsRequest).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(req?.destroyCount()).toBeGreaterThan(0);
  });

  it('refuses without opening a socket when the signal is already aborted', async () => {
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchClientMetadataResource(METADATA_URL, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    // An already-aborted signal fires no `abort` event, so a listener alone would open the connection and then wait for the deadline.
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('honours an already-aborted signal carried on a Request', async () => {
    // The CIMD plugin hands the transport a Request rather than a separate init, so a signal read only from `init` would be silently dropped.
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchClientMetadataResource(new Request(METADATA_URL, { signal: controller.signal })),
    ).rejects.toThrow(/abort/i);
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('refuses a non-read method carried on a Request', async () => {
    // Same reasoning as the signal: a method read only from `init` would let a POST Request through as a GET-shaped fetch.
    resolvesTo(PUBLIC_IPV4, 4);
    respondWith(200);

    await expect(
      fetchClientMetadataResource(new Request(METADATA_URL, { method: 'POST' })),
    ).rejects.toThrow(/method/i);
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('ends the exchange when the socket goes idle after a response has started', async () => {
    // Once the server has answered, silence is about this server, so another address would answer the same way and the idle timeout stays a final refusal.
    dnsLookup.mockResolvedValue([
      { address: PUBLIC_IPV6, family: 6 },
      { address: PUBLIC_IPV4, family: 4 },
    ]);
    let req: FakeClientRequest | undefined;
    httpsRequest.mockImplementation((_options: unknown, onResponse: Listener) => {
      const created = fakeClientRequest();
      req = created;
      queueMicrotask(() => {
        onResponse(fakeIncomingMessage(200, ''));
        queueMicrotask(() => created.emit('timeout'));
      });
      return created;
    });

    await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toMatchObject({
      name: 'CimdTransportRefusal',
    });
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(req?.destroyCount()).toBeGreaterThan(0);
  });

  it('moves to the next resolved address when the first goes silent before any response', async () => {
    // A route that drops packets never produces a connect error, only silence, so treating that silence as a final refusal would end registration on exactly the AAAA-first host the fallback exists for.
    dnsLookup.mockResolvedValue([
      { address: PUBLIC_IPV6, family: 6 },
      { address: PUBLIC_IPV4, family: 4 },
    ]);
    let first: FakeClientRequest | undefined;
    httpsRequest
      .mockImplementationOnce(() => {
        const created = fakeClientRequest();
        first = created;
        queueMicrotask(() => created.emit('timeout'));
        return created;
      })
      .mockImplementationOnce((_options: unknown, onResponse: Listener) => {
        const created = fakeClientRequest();
        queueMicrotask(() => {
          const res = fakeIncomingMessage(200, '{"ok":true}');
          onResponse(res);
          queueMicrotask(() => res.flush());
        });
        return created;
      });

    const res = await fetchClientMetadataResource(METADATA_URL);
    expect(res.status).toBe(200);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(first?.destroyCount()).toBeGreaterThan(0);
  });

  it('rejects on caller abort while DNS resolution hangs, leaving no timer behind', async () => {
    // `dns/promises.lookup` takes no signal, and the plugin holds a fetch permit until this settles, so a resolver that never answers must not outlast the caller giving up.
    vi.useFakeTimers();
    try {
      dnsLookup.mockReturnValue(new Promise(() => undefined));
      const controller = new AbortController();

      const pending = fetchClientMetadataResource(METADATA_URL, { signal: controller.signal });
      const settled = expect(pending).rejects.toThrow(/abort/i);
      await flushMicrotasks();
      controller.abort();
      await settled;
      expect(httpsRequest).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on the deadline while DNS resolution hangs', async () => {
    vi.useFakeTimers();
    try {
      dnsLookup.mockReturnValue(new Promise(() => undefined));

      const pending = fetchClientMetadataResource(METADATA_URL);
      const settled = expect(pending).rejects.toThrow(/dns lookup exceeded .*deadline/i);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the connection only what the lookup left of the deadline', async () => {
    // A fresh budget per stage would let a slow resolver plus a silent host hold the fetch permit for twice the deadline, and more again for each extra address.
    vi.useFakeTimers();
    try {
      dnsLookup.mockImplementation(() => {
        vi.setSystemTime(Date.now() + 8_000);
        return Promise.resolve([{ address: PUBLIC_IPV4, family: 4 }]);
      });
      httpsRequest.mockImplementation(() => fakeClientRequest());

      let outcome: unknown;
      fetchClientMetadataResource(METADATA_URL).catch((err: unknown) => {
        outcome = err;
      });
      await flushMicrotasks();
      expect(httpsRequest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ message: expect.stringMatching(/deadline/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses before connecting when the lookup used the whole deadline', async () => {
    vi.useFakeTimers();
    try {
      dnsLookup.mockImplementation(() => {
        vi.setSystemTime(Date.now() + 10_000);
        return Promise.resolve([{ address: PUBLIC_IPV4, family: 4 }]);
      });
      respondWith(200);

      await expect(fetchClientMetadataResource(METADATA_URL)).rejects.toThrow(/deadline/i);
      // An attempt started with no budget left would still open a socket into someone else's network before its zero-length timer fired.
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

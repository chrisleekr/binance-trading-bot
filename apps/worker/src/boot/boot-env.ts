// The worker boot input. A leaf module so the per-subsystem builders and the
// composer can all read `BootEnv` without a cycle through `boot-context.ts`.

export interface BootEnv {
  readonly redisUrl: string;
  readonly pgUrl: string;
  readonly logLevel?: string;
  readonly binanceWsUrl?: string;
  readonly adminPort?: number;
  /**
   * Interface the admin server binds. Defaults to loopback so compose/host dev
   * keep the unauthenticated /healthz, /readyz, /metrics off the LAN. k8s sets
   * `0.0.0.0` so the kubelet's httpGet probes (which hit the pod IP, not
   * loopback) and a Prometheus ServiceMonitor can reach them; restrict the
   * exposed port with a default-deny ingress NetworkPolicy (a Service is not a
   * firewall, and pod IPs are reachable cluster-wide by default).
   */
  readonly adminHost?: string;
  /**
   * Build SHA, written to the `worker:status` heartbeat. Empty falls back to
   * the local git SHA (or 'unknown') at boot. Optional so existing boot
   * callers (tests) need not supply it.
   */
  readonly gitSha?: string;
  /** Public web base URL for notification deep links; omitted disables links. */
  readonly publicWebUrl?: string;
  /**
   * Public "Live demo" mode. When true the worker no-ops all notifier dispatch
   * and refuses to boot if any account is on the live Binance environment.
   */
  readonly liveDemo?: boolean;
  /**
   * Per-tick durable `symbol_states` write budget (ms). Omitted falls back to the
   * tick handler's built-in default; raise it on network-replicated storage where
   * a commit fsync is a cross-node round-trip.
   */
  readonly persistTimeoutMs?: number;
}

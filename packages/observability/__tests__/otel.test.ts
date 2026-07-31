import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { CountingExporter, startOtel } from '../src/otel.js';

class StubExporter implements SpanExporter {
  public exports = 0;
  public shutdownCalls = 0;
  constructor(
    private readonly outcome: ExportResult,
    private readonly delayMs = 0,
  ) {}
  export(_spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    this.exports += 1;
    if (this.delayMs === 0) {
      cb(this.outcome);
      return;
    }
    setTimeout(() => cb(this.outcome), this.delayMs);
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('startOtel — env gating', () => {
  it('returns a no-op handle when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    const handle = startOtel({ service: 'api', env: {} });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('returns a no-op handle when the endpoint is the empty string', async () => {
    const handle = startOtel({
      service: 'api',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: '' },
    });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('does not call onDrop on the unset-env path', () => {
    const onDrop = vi.fn();
    startOtel({ service: 'api', env: {}, onDrop });
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('CountingExporter', () => {
  it('passes through SUCCESS results and does not call onDrop', async () => {
    const onDrop = vi.fn();
    const inner = new StubExporter({ code: ExportResultCode.SUCCESS });
    const wrapped = new CountingExporter(inner, onDrop, 1000);
    const result = await new Promise<ExportResult>((resolve) =>
      wrapped.export([] as unknown as ReadableSpan[], resolve),
    );
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(onDrop).not.toHaveBeenCalled();
    expect(inner.exports).toBe(1);
  });

  it('calls onDrop("export_error") when the inner exporter returns FAILED', async () => {
    const onDrop = vi.fn();
    const inner = new StubExporter({ code: ExportResultCode.FAILED });
    const wrapped = new CountingExporter(inner, onDrop, 1000);
    const result = await new Promise<ExportResult>((resolve) =>
      wrapped.export([] as unknown as ReadableSpan[], resolve),
    );
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('export_error');
  });

  it('fires onDrop("export_timeout") and resolves FAILED when the inner exporter hangs past timeout', async () => {
    const onDrop = vi.fn();
    // Inner never settles within the timeout window.
    const inner = new StubExporter({ code: ExportResultCode.SUCCESS }, 1000);
    const wrapped = new CountingExporter(inner, onDrop, 25);
    const result = await new Promise<ExportResult>((resolve) =>
      wrapped.export([] as unknown as ReadableSpan[], resolve),
    );
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('export_timeout');
  });

  it('forwards shutdown to the inner exporter', async () => {
    const inner = new StubExporter({ code: ExportResultCode.SUCCESS });
    const wrapped = new CountingExporter(inner, vi.fn(), 1000);
    await wrapped.shutdown();
    expect(inner.shutdownCalls).toBe(1);
  });
});

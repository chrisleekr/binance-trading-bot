import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { startAll, stopAll, type Component } from '../../src/lib/component.js';

const silentLogger = pino({ level: 'silent' });

const buildComponent = (
  name: string,
  events: string[],
  opts: { startThrows?: Error; stopThrows?: Error } = {},
): Component => ({
  name,
  start: vi.fn(async () => {
    events.push(`start:${name}`);
    if (opts.startThrows) throw opts.startThrows;
  }),
  stop: vi.fn(async () => {
    events.push(`stop:${name}`);
    if (opts.stopThrows) throw opts.stopThrows;
  }),
});

describe('startAll', () => {
  it('starts each component sequentially in declared order', async () => {
    const events: string[] = [];
    const cs = [
      buildComponent('a', events),
      buildComponent('b', events),
      buildComponent('c', events),
    ];
    await startAll(cs, silentLogger);
    expect(events).toEqual(['start:a', 'start:b', 'start:c']);
  });

  it('aborts boot on the first throw (does not start later components)', async () => {
    const events: string[] = [];
    const cs = [
      buildComponent('a', events),
      buildComponent('b', events, { startThrows: new Error('boom') }),
      buildComponent('c', events),
    ];
    await expect(startAll(cs, silentLogger)).rejects.toThrow('boom');
    expect(events).toEqual(['start:a', 'start:b']);
  });
});

describe('stopAll', () => {
  it('stops each component sequentially in REVERSE declared order; returns empty failure list', async () => {
    const events: string[] = [];
    const cs = [
      buildComponent('a', events),
      buildComponent('b', events),
      buildComponent('c', events),
    ];
    const failed = await stopAll(cs, silentLogger);
    expect(events).toEqual(['stop:c', 'stop:b', 'stop:a']);
    expect(failed).toEqual([]);
  });

  it('continues the drain when one component.stop() throws, returns its name', async () => {
    const events: string[] = [];
    const cs = [
      buildComponent('a', events),
      buildComponent('b', events, { stopThrows: new Error('stuck') }),
      buildComponent('c', events),
    ];
    // Does NOT reject — a stuck subsystem cannot starve the rest of the drain.
    const failed = await stopAll(cs, silentLogger);
    expect(events).toEqual(['stop:c', 'stop:b', 'stop:a']);
    expect(failed).toEqual(['b']);
  });
});

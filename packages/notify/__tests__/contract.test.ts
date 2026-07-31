import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createNotifyRegistry } from '../src/index.js';
import type { NotifyProvider } from '../src/index.js';

const makeProvider = (name: string): NotifyProvider => ({
  name,
  version: '1.0.0',
  displayName: name,
  secretFields: [],
  configSchema: z.object({}),
  send: async () => undefined,
});

describe('createNotifyRegistry', () => {
  it('registers, gets, and lists providers', () => {
    const r = createNotifyRegistry();
    const slack = makeProvider('slack');
    r.register(slack);
    expect(r.get('slack')).toBe(slack);
    expect(r.get('missing')).toBeUndefined();
    expect(r.list()).toEqual([slack]);
  });

  it('throws on duplicate name', () => {
    const r = createNotifyRegistry();
    r.register(makeProvider('slack'));
    expect(() => r.register(makeProvider('slack'))).toThrow(/duplicate notify provider: slack/);
  });

  it('describeAll projects metadata in registration order, never exposes send()', () => {
    const r = createNotifyRegistry();
    const slack: NotifyProvider = {
      ...makeProvider('slack'),
      displayName: 'Slack',
      secretFields: ['webhookUrl'],
    };
    const tg: NotifyProvider = {
      ...makeProvider('telegram'),
      displayName: 'Telegram',
      secretFields: ['botToken'],
    };
    r.register(slack);
    r.register(tg);

    const descriptors = r.describeAll();
    expect(descriptors.map((d) => d.name)).toEqual(['slack', 'telegram']);
    expect(descriptors[0]).toMatchObject({
      name: 'slack',
      version: '1.0.0',
      displayName: 'Slack',
      secretFields: ['webhookUrl'],
    });
    for (const d of descriptors) {
      expect(d).not.toHaveProperty('send');
    }
  });
});

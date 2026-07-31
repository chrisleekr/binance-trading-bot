import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StreamReq {
  system: { type: string; text: string; cache_control?: unknown }[];
  tools: { name: string; description: string; input_schema: unknown }[];
  tool_choice: { type: string; name: string };
  max_tokens: number;
  messages: { role: string; content: string }[];
}

const streamCalls: StreamReq[] = [];
const ctorArgs: unknown[] = [];
let nextFinal: unknown;

class MockAnthropic {
  constructor(args: unknown) {
    ctorArgs.push(args);
  }
  messages = {
    stream: (req: StreamReq) => {
      streamCalls.push(req);
      return { finalMessage: async () => nextFinal };
    },
  };
}

vi.mock('@anthropic-ai/sdk', () => ({ default: MockAnthropic }));

import {
  buildSystemBlocks,
  CLAUDE_CODE_IDENTIFIER,
  createAnthropicClient,
} from '../../src/providers/anthropic.js';

const req = {
  name: 'emit',
  description: 'produce the thing',
  systemText: 'sys',
  user: 'u',
  schema: { type: 'object' },
  maxTokens: 128,
};

beforeEach(() => {
  streamCalls.length = 0;
  ctorArgs.length = 0;
  nextFinal = { stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { ok: 1 } }] };
});

describe('buildSystemBlocks', () => {
  it('emits a single cached caller block on the API-key path', () => {
    expect(buildSystemBlocks('apikey', 'do the thing')).toEqual([
      { type: 'text', text: 'do the thing', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('prepends the Claude Code identifier as a standalone first block on the OAuth path', () => {
    const blocks = buildSystemBlocks('oauth', 'do the thing');
    expect(blocks[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTIFIER });
    expect(blocks[1]).toEqual({
      type: 'text',
      text: 'do the thing',
      cache_control: { type: 'ephemeral' },
    });
  });
});

describe('createAnthropicClient', () => {
  it('is unavailable with no credential and rejects', async () => {
    const client = createAnthropicClient({ apiKey: '', oauthToken: '', model: 'm' });
    expect(client.available).toBe(false);
    await expect(client.generateStructured(req)).rejects.toThrow(/no credential/);
  });

  it('forces the tool call and returns its input on the API-key path', async () => {
    const client = createAnthropicClient({ apiKey: 'sk-test', oauthToken: '', model: 'm' });
    const out = await client.generateStructured(req);
    expect(out).toEqual({ ok: 1 });
    expect(ctorArgs[0]).toEqual({ apiKey: 'sk-test' });
    const call = streamCalls[0];
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    expect(call.tools[0].input_schema).toEqual({ type: 'object' });
    expect(call.max_tokens).toBe(128);
    // API-key path: no identifier block, just the cached caller block.
    expect(call.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('uses the OAuth token and prepends the identifier block', async () => {
    const client = createAnthropicClient({ apiKey: '', oauthToken: 'oat', model: 'm' });
    await client.generateStructured(req);
    expect(ctorArgs[0]).toEqual({ authToken: 'oat' });
    expect(streamCalls[0].system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTIFIER });
  });

  it('throws a clear error when the response is truncated at max_tokens', async () => {
    nextFinal = { stop_reason: 'max_tokens', content: [] };
    const client = createAnthropicClient({ apiKey: 'sk-test', oauthToken: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow(/truncated/);
  });

  it('throws when the model returns no tool call', async () => {
    nextFinal = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] };
    const client = createAnthropicClient({ apiKey: 'sk-test', oauthToken: '', model: 'm' });
    await expect(client.generateStructured(req)).rejects.toThrow(/did not return the forced tool/);
  });
});

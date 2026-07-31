// Shared, syntax-agnostic shaping of a NotifyMessage into ordered display parts.
// Providers call this to agree on WHAT to show (title, a "profile · symbol"
// context line, body, fields, link) and then each owns HOW to render it —
// escaping and decorating for Slack mrkdwn / Telegram HTML. Keeping the shaping
// here stops the three providers drifting on the context-line rule.

import type { NotifyMessage } from './contract.js';

/** Ordered, unescaped parts derived from a message; each provider escapes + styles them. */
export interface MessageParts {
  readonly title: string;
  /** "profile · symbol", or whichever single side is present; absent when neither is. */
  readonly context?: string;
  readonly body?: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly link?: string;
}

/** Derive the display parts. Pure: no escaping, no provider syntax. */
export const messageParts = (m: NotifyMessage): MessageParts => {
  const context = [m.profile, m.symbol].filter((s): s is string => Boolean(s)).join(' · ');
  return {
    title: m.title,
    ...(context ? { context } : {}),
    ...(m.body ? { body: m.body } : {}),
    fields: m.fields ?? [],
    ...(m.link ? { link: m.link } : {}),
  };
};

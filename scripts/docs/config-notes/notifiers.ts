// Operator guidance for the notifier-provider config tables. Provider configs
// are flat and share a namespace here, so the keys are bare field names.
import type { FieldNotes } from '@app/contracts';

export const notifierNotes: FieldNotes = {
  webhookUrl: {
    when: 'Always, for Slack. Create it under api.slack.com → Incoming Webhooks for the workspace and channel you want alerts in.',
    expect:
      'This URL is a credential: anyone holding it can post to that channel. It is stored write-once and never shown back, and never appears in any API response. Rotate it in Slack if it leaks.',
  },
  channel: {
    when: 'Only if you want messages somewhere other than the channel the webhook was created for.',
    expect:
      "Leave blank and messages go to the webhook's own channel. Note that Slack ignores a channel override on newer webhook types, so this may have no effect.",
  },
  username: {
    when: 'Set it when several bots post to the same channel and you need to tell them apart at a glance.',
    expect:
      'The name shown as the message sender. Cosmetic only; it changes nothing about delivery.',
  },
  botToken: {
    when: 'Always, for Telegram. Send `/newbot` to @BotFather and copy the token it gives you.',
    expect:
      'A credential — anyone with it controls the bot. Stored write-once and never returned by the API. If it leaks, revoke it via @BotFather.',
  },
  chatId: {
    when: 'Always, for Telegram. Message @userinfobot for your personal numeric id; for a group, add the bot to the group and use the group id.',
    expect:
      'Group ids are usually negative — dropping the minus sign is the most common reason messages silently never arrive. The bot must have been started (or added to the group) before it can message you.',
  },
  url: {
    when: 'Always, for the generic webhook notifier. Point it at an HTTPS endpoint you control.',
    expect:
      'Receives a JSON body carrying the notification payload. Treated as a credential-equivalent value and never returned by the API, since the URL itself is often the only authentication.',
  },
  method: {
    when: 'Only if your endpoint requires PUT. Leave at POST otherwise.',
    expect: 'Changes the HTTP verb only. The body is identical either way.',
  },
  authHeader: {
    when: 'Set it when your endpoint requires authentication, e.g. `Bearer <token>`.',
    expect:
      'Sent verbatim as the Authorization header on every notification. Stored write-once and never shown back. Leave blank for an unauthenticated endpoint.',
  },
};

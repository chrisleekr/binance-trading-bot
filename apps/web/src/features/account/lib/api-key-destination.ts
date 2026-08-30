// The account's Binance API-key page as a NAV DESTINATION, distinct from the route itself.
//
// It has no nav-registry entry — the sidebar and bottom bar reach it through the account settings hub — but two in-page call-to-actions link straight at it (the dashboard's "awaiting first tick" hint and the symbol tick strip). Those are nav surfaces too, and `GET /api-key` 403s for the demo operator, so the declaration lives here where both can share one answer instead of each restating a path.

import type { DemoVisible } from '@/shared/lib/demo-visibility';

export const API_KEY_DESTINATION = { demoHidden: true } as const satisfies DemoVisible;

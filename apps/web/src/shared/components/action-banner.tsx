import { useEffect } from 'react';
import { toast } from 'sonner';

/**
 * A one-shot result banner for a mutation surface.
 *
 * `info` exists because some answers are neither. Cancelling an override the bot
 * has already claimed comes back 409: nothing broke, and nothing the operator
 * asked for happened either. `err` would tell them to retry an action that needs
 * waiting out; `ok` would claim the queue is clear when a dispatch is in flight.
 */
export interface ActionBannerState {
  readonly kind: 'ok' | 'err' | 'info';
  readonly message: string;
}

/**
 * Shared mutation-result surface. Fires a centred Sonner toast when `banner`
 * becomes non-null and renders nothing inline, so call sites keep passing their
 * state directly while the feedback lives in the global toaster.
 */
export function ActionBanner({ banner }: { banner: ActionBannerState | null }): null {
  useEffect(() => {
    if (!banner) return;
    if (banner.kind === 'err') toast.error(banner.message);
    else if (banner.kind === 'info') toast.info(banner.message);
    else toast.success(banner.message);
  }, [banner]);
  return null;
}

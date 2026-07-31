// WS URL helper shared across per-profile routes. Both the profile dashboard
// and the per-symbol detail page upgrade to the same
// `/accounts/:accountId/profiles/:id/ws` endpoint; centralising the URL
// construction keeps the protocol switch (http→ws / https→wss) and the optional
// `since` cursor in one place.

import { encodePathSegment, getApiBaseUrl } from '@/shared/lib/api';

/**
 * Builds the WS upgrade URL from the API base. The account is named in the path
 * (the ws route mounts under `/accounts/:accountId`). `since` is appended only
 * when the caller has a previous server-assigned sequence to resume from; the
 * worker accepts the same path with or without it.
 */
export const buildProfileWsUrl = (
  accountId: string,
  profileId: string,
  since?: number | null,
): string => {
  const base = getApiBaseUrl();
  const absolute = base.startsWith('http')
    ? base
    : `${typeof window === 'undefined' ? 'http://localhost' : window.location.origin}${base}`;
  const url = new URL(
    `${absolute.replace(/\/$/, '')}/accounts/${encodePathSegment(accountId)}/profiles/${encodePathSegment(profileId)}/ws`,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (since !== null && since !== undefined && since > 0) {
    url.searchParams.set('since', String(since));
  }
  return url.toString();
};

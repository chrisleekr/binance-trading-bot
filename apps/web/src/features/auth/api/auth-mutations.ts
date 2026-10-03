import {
  SingleSignOnRedirect,
  type SignInRequest,
  type SignUpRequest,
  type SingleSignOnStartRequest,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch } from '@/shared/lib/api';

const EmptyResponse = z.unknown();

export const signUp = (body: SignUpRequest): Promise<unknown> =>
  apiFetch('/auth/sign-up', EmptyResponse, { method: 'POST', body });

export const signIn = (body: SignInRequest): Promise<unknown> =>
  apiFetch('/auth/sign-in/email', EmptyResponse, { method: 'POST', body });

/**
 * Asks the server where to send the browser to sign in with the identity provider. The server builds the address, so the provider, the return path and whether a new operator may be created are decided there, not by this page.
 *
 * @param body - Where to land afterwards, the pending agent authorization if any, and whether this is a re-authentication.
 * @returns The provider address to navigate to.
 */
export const startSingleSignOn = (body: SingleSignOnStartRequest): Promise<SingleSignOnRedirect> =>
  apiFetch('/auth/single-sign-on/start', SingleSignOnRedirect, { method: 'POST', body });

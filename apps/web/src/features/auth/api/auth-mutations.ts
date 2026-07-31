import type { SignInRequest, SignUpRequest } from '@app/contracts';
import { z } from 'zod';

import { apiFetch } from '@/shared/lib/api';

const EmptyResponse = z.unknown();

export const signUp = (body: SignUpRequest): Promise<unknown> =>
  apiFetch('/auth/sign-up', EmptyResponse, { method: 'POST', body });

export const signIn = (body: SignInRequest): Promise<unknown> =>
  apiFetch('/auth/sign-in/email', EmptyResponse, { method: 'POST', body });

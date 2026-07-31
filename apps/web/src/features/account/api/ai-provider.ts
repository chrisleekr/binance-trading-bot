import {
  AiProviderConfigView,
  AiProviderTestResult,
  type AiProviderConfigUpdate,
} from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

const fetchAiProvider = (): Promise<AiProviderConfigView> =>
  apiFetch('/account/ai-provider', AiProviderConfigView);

/** Query key for the system-wide AI provider config; one row, no params. */
export const aiProviderQueryKey = ['ai-provider'] as const;

export const aiProviderQueryOptions = {
  queryKey: aiProviderQueryKey,
  queryFn: fetchAiProvider,
} as const;

/** Persist the provider selection — `PATCH /account/ai-provider`. A blank secret keeps the stored one. */
export const updateAiProvider = (body: AiProviderConfigUpdate): Promise<AiProviderConfigView> =>
  apiFetch('/account/ai-provider', AiProviderConfigView, { method: 'PATCH', body });

/** Probe the stored provider's reachability — `POST /account/ai-provider/test`. */
export const testAiProvider = (): Promise<AiProviderTestResult> =>
  apiFetch('/account/ai-provider/test', AiProviderTestResult, { method: 'POST', body: {} });

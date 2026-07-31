// System-wide AI-assist provider. One master account, so this is a single global
// setting that powers "Ask AI" (the backtest advisor).
// Secrets are write-only: the server returns whether a key is set, never the key,
// so a blank key field on save means "keep the stored one".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ApiError } from '@/shared/lib/api';
import {
  aiProviderQueryKey,
  aiProviderQueryOptions,
  testAiProvider,
  updateAiProvider,
} from '@/features/account/api/ai-provider';

import type { AiProvider } from '@app/contracts';

const SELECT_CLASS =
  'border-border bg-bg-elevated text-fg w-full rounded-md border px-3 py-2 text-sm sm:w-72';

/** Placeholder that tells the operator whether a secret is already stored. */
const secretPlaceholder = (isSet: boolean): string =>
  isSet ? '•••••••• set — leave blank to keep' : 'not set';

export function AiProviderCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery(aiProviderQueryOptions);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [anthropicModel, setAnthropicModel] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicOauth, setAnthropicOauth] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');

  const view = q.data;
  // Seed the non-secret fields from the server on load and after a save. Secret
  // inputs stay as typed; they are cleared explicitly on a successful save.
  useEffect(() => {
    if (!view) return;
    setProvider(view.provider);
    setAnthropicModel(view.anthropic.model);
    setOpenaiBaseUrl(view.openai.baseUrl);
    setOpenaiModel(view.openai.model);
  }, [view]);

  const save = useMutation({
    mutationFn: () =>
      updateAiProvider({
        provider,
        anthropic: {
          model: anthropicModel,
          ...(anthropicApiKey ? { apiKey: anthropicApiKey } : {}),
          ...(anthropicOauth ? { oauthToken: anthropicOauth } : {}),
        },
        openai: {
          baseUrl: openaiBaseUrl,
          model: openaiModel,
          ...(openaiApiKey ? { apiKey: openaiApiKey } : {}),
        },
      }),
    onSuccess: async () => {
      setAnthropicApiKey('');
      setAnthropicOauth('');
      setOpenaiApiKey('');
      await queryClient.invalidateQueries({ queryKey: aiProviderQueryKey });
      setBanner({ kind: 'ok', message: 'AI provider saved.' });
    },
    onError: (err) =>
      setBanner({
        kind: 'err',
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'save failed',
      }),
  });

  const test = useMutation({
    mutationFn: testAiProvider,
    onSuccess: (res) =>
      setBanner(
        res.ok
          ? { kind: 'ok', message: `Connection OK — ${res.detail}` }
          : { kind: 'err', message: `Not reachable — ${res.detail}` },
      ),
    onError: (err) =>
      setBanner({
        kind: 'err',
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'test failed',
      }),
  });

  const busy = save.isPending || test.isPending;

  return (
    <Panel
      title="AI assistant"
      description="Which AI service powers Ask AI (the backtest advisor). Keys are stored on your server and never shown again — leave a key blank to keep the saved one. Save, then Test."
      testId="ai-provider-card"
    >
      <div className="space-y-4">
        {q.isLoading ? <p className="text-muted-fg text-sm">Loading…</p> : null}

        <div className="space-y-1">
          <Label htmlFor="ai-provider-select">Provider</Label>
          <select
            id="ai-provider-select"
            data-testid="ai-provider-select"
            value={provider}
            disabled={busy}
            onChange={(e) => setProvider(e.target.value as AiProvider)}
            className={SELECT_CLASS}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai-compatible">OpenAI-compatible (Ollama, vLLM, OpenAI)</option>
          </select>
        </div>

        {provider === 'anthropic' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ai-anthropic-model">Model</Label>
              <Input
                id="ai-anthropic-model"
                value={anthropicModel}
                disabled={busy}
                onChange={(e) => setAnthropicModel(e.target.value)}
                placeholder="claude-sonnet-5"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-anthropic-key">API key</Label>
              <Input
                id="ai-anthropic-key"
                type="password"
                autoComplete="off"
                value={anthropicApiKey}
                disabled={busy}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                placeholder={secretPlaceholder(view?.anthropic.hasApiKey ?? false)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-anthropic-oauth">Claude Code OAuth token (optional)</Label>
              <Input
                id="ai-anthropic-oauth"
                type="password"
                autoComplete="off"
                value={anthropicOauth}
                disabled={busy}
                onChange={(e) => setAnthropicOauth(e.target.value)}
                placeholder={secretPlaceholder(view?.anthropic.hasOauthToken ?? false)}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ai-openai-base">Base URL</Label>
              <Input
                id="ai-openai-base"
                value={openaiBaseUrl}
                disabled={busy}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                placeholder="http://host.docker.internal:11434/v1"
              />
              <p className="text-muted-fg text-xs">
                For a local Ollama, use http://host.docker.internal:11434/v1
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-openai-model">Model</Label>
              <Input
                id="ai-openai-model"
                value={openaiModel}
                disabled={busy}
                onChange={(e) => setOpenaiModel(e.target.value)}
                placeholder="qwen2.5"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-openai-key">API key (optional)</Label>
              <Input
                id="ai-openai-key"
                type="password"
                autoComplete="off"
                value={openaiApiKey}
                disabled={busy}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder={secretPlaceholder(view?.openai.hasApiKey ?? false)}
              />
            </div>
          </div>
        )}

        <ActionBanner banner={banner} />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="default"
            disabled={busy}
            data-testid="ai-provider-save"
            onClick={() => save.mutate()}
            className="w-full sm:w-40"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="ai-provider-test"
            onClick={() => test.mutate()}
            className="w-full sm:w-40"
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// "Confirm it's you": the proof every credential-changing action sends, collected once per page. The server enforces it; this only gathers the current password, or points the operator at a fresh single sign-on login, which the server accepts for five minutes.

import type { Reauthentication } from '@app/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { errorMessage } from '@/shared/lib/api';
import { onboardingStatusQueryOptions } from '@/features/auth/api/auth';
import { startSingleSignOn } from '@/features/auth/api/auth-mutations';
import { fetchSession, securityQueryKeys } from '@/features/account/api/security';

/** Collects the proof once; each action asks for it and gets null (with a prompt) when it is missing. */
export interface Proof {
  readonly get: () => Reauthentication | null;
  /** Points the operator at "Confirm it's you" with this explanation. An action far down the page otherwise only raises a toast, and the button that fixes it is off screen. */
  readonly ask: (message: string) => void;
}

/** What {@link ConfirmPanel} renders from; produced by {@link useConfirmIdentity}. */
export interface ConfirmPanelState {
  readonly passwordUsable: boolean;
  readonly singleSignOnReady: boolean;
  readonly password: string;
  readonly onPassword: (value: string) => void;
  /** Why an action just asked for confirmation, with a counter so the same message scrolls the panel into view again; null until one does. */
  readonly prompt: { readonly message: string; readonly count: number } | null;
}

/**
 * Holds one page's confirmation: which methods can work, the typed password, and the latest prompt.
 *
 * @returns The proof the page's actions read, and the state its {@link ConfirmPanel} renders.
 */
export const useConfirmIdentity = (): { proof: Proof; panel: ConfirmPanelState } => {
  const { data: session } = useQuery({
    queryKey: securityQueryKeys.session,
    queryFn: fetchSession,
  });
  const { data: status } = useQuery(onboardingStatusQueryOptions);
  const [password, setPassword] = useState('');
  const [prompt, setPrompt] = useState<{ message: string; count: number } | null>(null);
  // The server refuses a password as proof while password sign-in is switched off, so the field is only offered when it can work.
  const passwordUsable = (session?.hasPassword ?? true) && status?.passwordSignIn !== false;
  const singleSignOnReady =
    session?.singleSignOnLinked === true && status?.singleSignOn?.available === true;
  const proof: Proof = {
    get: () => {
      if (passwordUsable && password.length > 0) return { method: 'password', password };
      // A single sign-on proof is the session itself; the server checks it was made interactively in the last five minutes.
      if (!passwordUsable || singleSignOnReady) return { method: 'singleSignOn' };
      return null;
    },
    ask: (message) => setPrompt((prev) => ({ message, count: (prev?.count ?? 0) + 1 })),
  };
  return {
    proof,
    panel: { passwordUsable, singleSignOnReady, password, onPassword: setPassword, prompt },
  };
};

/**
 * The "Confirm it's you" panel.
 *
 * @param props - The state from {@link useConfirmIdentity}, plus where the identity provider returns the operator after a fresh single sign-on; that login, not this page, is what the server accepts as proof.
 * @returns The panel.
 */
export function ConfirmPanel({
  passwordUsable,
  singleSignOnReady,
  password,
  onPassword,
  prompt,
  returnTo,
  description,
}: ConfirmPanelState & {
  readonly returnTo: string;
  readonly description: string;
}): React.JSX.Element {
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prompt !== null) panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [prompt]);
  const reauthenticate = async (): Promise<void> => {
    try {
      const { url } = await startSingleSignOn({ reauthenticate: true, returnTo });
      window.location.href = url;
    } catch (err) {
      setBanner({ kind: 'err', message: errorMessage(err) });
    }
  };
  return (
    <div ref={panelRef} className="scroll-mt-4">
      <Panel title="Confirm it's you" description={description}>
        <div className="space-y-3">
          {prompt !== null && (
            <Alert variant="danger" data-testid="security-confirm-prompt" aria-live="assertive">
              <AlertDescription>{prompt.message}</AlertDescription>
            </Alert>
          )}
          {passwordUsable ? (
            <div className="space-y-1">
              <Label htmlFor="security-confirm-password">Current password</Label>
              <Input
                id="security-confirm-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => onPassword(e.target.value)}
                className="w-full sm:w-72"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-fg">
              Confirm by signing in again with single sign-on. The confirmation lasts five minutes.
            </p>
          )}
          {singleSignOnReady && (
            <Button
              variant="outline"
              className="w-full sm:w-72"
              onClick={() => void reauthenticate()}
            >
              Sign in again with single sign-on
            </Button>
          )}
          <ActionBanner banner={banner} />
        </div>
      </Panel>
    </div>
  );
}

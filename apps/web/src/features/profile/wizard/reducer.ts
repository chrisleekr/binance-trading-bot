import type { Dispatch } from 'react';

export const TOTAL_STEPS = 2;

export interface WizardState {
  step: 1 | 2;
  name: string;
  strategy: {
    name: string;
    version: string;
    displayName: string;
    defaultConfig: unknown;
    configSchema: Record<string, unknown>;
  } | null;
  creating: boolean;
  profileId: string | null;
  error: string | null;
}

export type WizardAction =
  | { type: 'set-name'; name: string }
  | { type: 'set-strategy'; strategy: WizardState['strategy'] }
  | { type: 'goto'; step: WizardState['step'] }
  | { type: 'set-creating'; creating: boolean }
  | { type: 'set-profile-id'; profileId: string | null }
  | { type: 'set-error'; error: string | null };

/** Props every wizard step receives: current state plus the reducer dispatch. */
export interface StepProps {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

export const initialState: WizardState = {
  step: 1,
  name: '',
  strategy: null,
  creating: false,
  profileId: null,
  error: null,
};

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set-name':
      return {
        ...state,
        name: action.name,
      };
    case 'set-strategy':
      return { ...state, strategy: action.strategy };
    case 'goto':
      return { ...state, step: action.step, error: null };
    case 'set-creating':
      return { ...state, creating: action.creating };
    case 'set-profile-id':
      return { ...state, profileId: action.profileId };
    case 'set-error':
      return { ...state, error: action.error };
  }
}

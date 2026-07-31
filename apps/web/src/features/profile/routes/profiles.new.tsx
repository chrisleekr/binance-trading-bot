import { createRoute } from '@tanstack/react-router';

import { ProfileWizardPage } from '@/features/profile/wizard';
import { accountScopeRoute } from '@/features/account/routes/account-scope';

/**
 * `/accounts/$accountId/profiles/new` route binding for the profile-creation
 * wizard. A new profile is created under the account named in the URL.
 */
export const profileNewRoute = createRoute({
  staticData: { title: 'New profile' },
  getParentRoute: () => accountScopeRoute,
  path: '/profiles/new',
  component: ProfileWizardPage,
});

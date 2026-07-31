import { bootstrapEnv } from '@app/core/env';

import { cliMain } from './migrate.js';

bootstrapEnv(import.meta.url);

await cliMain();

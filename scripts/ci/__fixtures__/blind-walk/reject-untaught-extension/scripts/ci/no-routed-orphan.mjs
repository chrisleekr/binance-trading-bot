// Fixture stub: routes through the shared helper in a language this gate has no recogniser for. It calls no directory primitive, so a vocabulary-shaped check answers "does not walk" and never reports it.
import { collectOrExit } from './lib/walk.mjs';
export const files = collectOrExit({ root: '.' });

Both roots are populated, both carry their `.ts` anchors, and `apps/web` is
gone — which is also the tree a walk that stopped scanning `.tsx` produces.

Without a `.tsx` anchor the gate reports a confident count here having examined
zero `.tsx` files, so this fixture is what pins the extension widening.

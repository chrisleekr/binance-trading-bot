A KNOWN GAP, pinned as current behaviour rather than as a fix.

Line-anchored block-comment stripping cannot tell a comment from a
template-literal continuation line that begins with `/*`, so the unclosed
opener inside the template blanks the live violation below it and the gate
exits 0. Closing it needs a real tokeniser, not a wider regex; flipping this
case to a reject is how that work announces itself.

Paired with `known-gap-template-literal-control/`, which carries the same cast
without the template literal and is rejected. The pair is what makes this a pin
rather than a second copy of `pass/`.

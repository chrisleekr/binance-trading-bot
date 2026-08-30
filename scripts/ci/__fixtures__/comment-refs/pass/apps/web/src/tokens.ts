// Colour literals are the false positive this gate must never produce. A
// six-digit hex (#1a2b3c) and a short one (#fff) both survive: the short form
// does not start with a digit, and every backtrack through the long one lands
// on a hex character.
export const ACCENT = '#fff';

// The literal below sits on a code line with no comment leader, which is the
// other half of the anchor: only leader-anchored lines are in scope.
export const ISSUE_LABEL = '(#123)';

// The charter's numbered-invariant idiom is not an issue reference: invariant #1
// is the extensibility rule, not a ticket.
export const EXTENSIBILITY = 1;

/**
 * A hard-wrapped comment splits the same idiom over two lines, so the carve-out
 * has to look one line back or it fires on the wrap: core invariant
 * #1 again, and the number here must still be spared.
 */
export const WRAPPED = 1;

/**
 * A JSDoc block ahead of the violation, so the reported line number is only
 * right if comment bodies are blanked in place rather than deleted.
 */
export const bad = sum.toString() as DecimalString;

// The same cast, reflowed so the annotation sits on the next line. Matching
// across the newline is the property; reporting the line the value is BUILT on
// rather than the line the annotation landed on is the other half.
export const wrapped = someReceiverWithAVeryLongNameThatForcesAReflow.toString() as
  DecimalString;

The CONTROL half of the known-gap pair. Byte-identical to
`known-gap-template-literal/` except that the template literal is gone, and it
is REJECTED on the cast's exact `file:line`.

The accepting half cannot prove anything alone: delete the hidden cast from it
and the case stays green forever as a second copy of `pass/`. Together the two
say "this cast is a violation, and the template literal is what hides it", and
this half goes red the moment the cast is edited out of either tree.

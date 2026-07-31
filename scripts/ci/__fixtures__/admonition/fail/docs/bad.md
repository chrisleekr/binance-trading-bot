# Bad fixture

A collapsible admonition whose first body line is flush-left. The `???+`
marker must be recognized so this real breakage is flagged.

???+ note "z"
This body line is flush-left at the marker's own indent, so it renders OUTSIDE
the box and must be flagged.

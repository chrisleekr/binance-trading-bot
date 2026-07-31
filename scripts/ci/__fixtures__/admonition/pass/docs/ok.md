# OK fixture

The fenced block below literally contains an admonition marker. It is code, not
an admonition, and must NOT be flagged once the gate tracks fences.

```yaml
!!! note "x"
flush-left body inside the fence
```

A correctly-indented collapsible-expanded admonition follows. Its body is
indented four spaces past the marker, so it renders inside the box and must
never be flagged.

???+ note "y"
    This body line is indented four spaces past the marker.

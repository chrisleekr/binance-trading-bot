# Environment variables

Process-level configuration lives in `.env`. Copy `.env.example` to `.env`, edit the values, and restart the stack.

Per-profile trading settings — grid levels, indicators, notifiers, technical gates — are **not** environment variables. They live in the database and are edited in the app. See [Configure](../get-started/configure.md).

**How to set any variable.** Add a `KEY=value` line to `.env`, one per line, then restart. Values are validated at boot: an invalid or missing required value stops startup with a precise error rather than starting in a broken state.

**Where the defaults come from.** The table below is generated from the env catalogue in the code, and every default is asserted against the schema the process actually parses with, so this page cannot claim a default the app does not apply. A variable marked _required_ has no default — boot fails without it.

A few variables are read by Docker Compose or baked into the web bundle at build time rather than parsed by the application; their rows say so.

--8<-- "docs/\_generated/config/env.md"

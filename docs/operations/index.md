# Operations

Runbooks for running the bot in production: deploying, stopping it fast, tuning the process environment, and fixing what breaks.

| Runbook | Use it to |
| --- | --- |
| [Production deploy](deploy.md) | Run the production overlay, TLS, migrations, and day-to-day commands. |
| [Kill switch](kill-switch.md) | Stop new trading immediately — at coin, profile, or account scope. |
| [Sign-in and security](sign-in-and-security.md) | Set up single sign-on, recover from a lockout, and respond to a security alert. |
| [Environment variables](env-vars.md) | Configure the process-level `.env` (ports, database, retention). |
| [Metrics reference](metrics.md) | Look up any series the worker exports. |
| [Troubleshooting](troubleshooting.md) | Diagnose common symptoms and follow step-by-step playbooks. |

New to the bot? Start with [Get started](../get-started/index.md); this section assumes a running deployment.

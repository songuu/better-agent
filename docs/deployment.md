# Server deployment

The production foundation follows the Agent project's immutable-release pattern. A successful CI run on `main` triggers `.github/workflows/deploy-foundation.yml`, uploads the accepted commit, provisions the isolated database, installs the independently managed Web runtime, and atomically switches `/opt/better-agent/current`.

## GitHub configuration

Configure these repository Actions secrets:

- `BETTER_AGENT_SSH_PRIVATE_KEY` (required): private key authorized for the deployment user.
- `BETTER_AGENT_SSH_KNOWN_HOSTS` (required): reviewed `known_hosts` line for the deployment host; runtime TOFU is rejected.

Set the repository variable `BETTER_AGENT_DEPLOY_ENABLED=true` only after the protected environment is ready. Configure the required `BETTER_AGENT_DEPLOY_HOST` and `BETTER_AGENT_DEPLOY_USER` production environment variables explicitly; there are no authority-bearing defaults. Put both SSH secrets in the protected `production` environment. Without the enable variable the production workflow is intentionally skipped instead of failing for absent credentials. The workflow has no manual branch dispatch: it accepts only the current `main` SHA after successful CI, re-runs the clean-checkout architecture gate without secrets, then passes a checksummed artifact to the protected deployment job.

The database is bound only to `127.0.0.1:55435`. Persistent data and generated credentials live under `/opt/better-agent/shared/postgres`, outside immutable releases. Releases live under `/opt/better-agent/releases`, `/opt/better-agent/current` is switched only after health and migration verification, and the latest five releases are retained.

The Web runtime is a dedicated `better-agent-web` system user and systemd unit. It reads only the accepted release through `/opt/better-agent/web-current`, binds to `127.0.0.1:4310`, and is exposed by the isolated `/etc/nginx/snippets/better-agent.location.conf` route at `/better-agent/`. Installation validates the exact accepted SHA, preserves the URI through Nginx, checks loopback health before reload, and checks TLS-routed health afterward. A failure restores the prior Web release and host configuration.

The public deployment job finally verifies `https://songuu.top/better-agent/api/healthz` and the application HTML from the GitHub runner. The gateway directory must not advertise the route until those checks pass.

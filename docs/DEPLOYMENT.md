# Deployment

The GitHub Actions workflows run checks only; they do not deploy the application.

The guided installer in the [main README](../README.md#quick-start) is intended for local evaluation. It binds services to the local machine and does not configure TLS, calling, browser push, backups, or production hosting.

For a network deployment, configure your own domain, TLS, authentication secrets, backups, storage, and optional LiveKit and Firebase services. Review [backend configuration](../backend/README.md) and [frontend configuration](../frontend/README.md) before building. `NEXT_PUBLIC_*` frontend settings are build-time values. Protect database, cache, storage, and administrative endpoints from public access.

Existing installations must retain their configured database URL and media storage when upgrading. Back up data and configuration and test upgrades in an isolated environment first.

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability within dsh-memory-connect, please send an email to the maintainers. All security vulnerabilities will be promptly addressed.

## Security Considerations

This plugin:

- Stores memory data in a local SQLite database
- Does not transmit any data to external servers
- Uses DSH's built-in LLM service for semantic consolidation (no external API calls)
- Memory extraction is rule-based and does not execute arbitrary code

## Permissions

The plugin requires:

- Read/write access to the configured database path
- Access to DSH's session events (read-only)
- Access to DSH's LLM service (optional, for semantic consolidation)

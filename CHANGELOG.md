# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.2.0] - 2026-08-19

- Startup, pre-flight and reactive diagnostics now go to opencode's log
  (`client.app.log`) instead of `console.log`, which plugins cannot reach
  from the TUI or opencode's own log file. The deferred `startupNotice`
  toast workaround, needed only because that was wrongly assumed
  unreachable from the `config` hook, is gone; toasts remain for states
  the user has to act on.
- `ReauthResult` no longer overloads `"not-stale"` for the circuit-breaker
  and no-profile cases, so the reactive "the token looks valid" message no
  longer appears when the token was never checked — including for users on
  bearer tokens, static keys or container credentials, who have no token
  at all.
- Corrected the comment above `tokenState`: an unreadable cache file reads
  as stale, not unknown, and does drive a login.
- Added plugin options: `marginMs`, `toastMs`, `loginTimeoutMs`,
  `awsCommand`, `providerID` and `profile`. Every default matches 0.1.0
  behaviour, so an existing install is unaffected unless it opts in.
  `loginTimeoutMs` defaults to 0 (no timeout), because `aws sso login` is
  already bounded by the device code expiry and killing it mid-flow risks
  a partial token cache write.


## [0.1.0] - 2026-08-19

First release. An opencode plugin that keeps the AWS SSO token behind the
Amazon Bedrock provider valid, so a session does not stall on an expired
token mid-conversation.

- Reads `expiresAt` from the AWS CLI's own SSO token cache, locating the
  cache file by hashing the profile's `sso-session` name or, for legacy
  profiles, its `sso_start_url` — matching botocore's own config parsing and
  cache-key derivation.
- Re-authenticates five minutes ahead of expiry, at three points: on
  startup, pre-flight before each Bedrock request, and reactively on the
  credential error that slips past pre-flight.
- Resolves the profile from `provider.amazon-bedrock.options.profile`, then
  `AWS_PROFILE`, then `AWS_DEFAULT_PROFILE`.
- Skips entirely when another AWS credential source opencode's Bedrock
  provider would prefer — a bearer token, a static key pair, container
  credentials, or web identity federation — is present.
- Keys the single-flight login by profile, so overlapping requests for
  different profiles cannot receive each other's result.

[Unreleased]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rjw1/opencode-bedrock-sso-refresh/releases/tag/v0.1.0

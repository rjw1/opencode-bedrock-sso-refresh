# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.2.1] - 2026-08-19

### Fixed

- **Login timeout no longer releases the single-flight mutex while `aws sso
  login` is still running.** A caller that lost the race against
  `loginTimeoutMs` previously deleted the mutex entry immediately, so a
  second caller arriving in that window — the ordinary
  pre-flight-then-reactive flow whenever `loginTimeoutMs` is set — found the
  map empty and started its own `aws sso login`. botocore writes the token
  cache in place (truncate, write, no rename, no lock), so the two processes
  could interleave writes and corrupt
  `~/.aws/sso/cache/<sha1>.json` for every AWS SDK and CLI call on the
  machine until a manual login. Anyone running 0.2.0 with `loginTimeoutMs`
  set should upgrade for this fix alone.
- Startup no longer probes with `aws sts get-caller-identity`. It now uses
  the same `tokenState` check that pre-flight and the reactive hook already
  use, so an unrelated STS or network failure can no longer reach `aws sso
  login` for a profile that was never SSO-backed — closing a startup-only
  exception to the tri-state design's central safety property that
  "unknown" must never trigger a browser flow. Server init is also no
  longer blocked on an unbounded network call.
- `parseIni` now accepts `:` as a delimiter, not just `=`, matching
  botocore's `RawConfigParser`. A profile written as `sso_session: name`
  previously lost the key entirely, which read as "not SSO-backed" and
  silently disabled pre-flight checks for that profile.
- Section names are now unquoted the same way `shlex.split` unquotes them,
  stripping a matching pair of single or double quotes. `[profile 'name']`
  previously never matched a `provider.<providerID>.options.profile` of
  `name`.
- `awsCommand` and `providerID` options now reject an empty string instead
  of accepting anything of the right type; an empty `awsCommand` would have
  produced an empty command rather than falling back to `aws`.
- `awsConfigPath` now expands a bare `~`, not just a leading `~/`, matching
  `os.path.expanduser`.
- The circuit-breaker message now distinguishes a wrong cache-path
  derivation from `marginMs` exceeding the token's remaining lifetime, and
  reports the actual time left in the latter case, instead of always
  blaming the derivation.
- A failed `~/.aws/config` read (`EMFILE`, a mid-rewrite file) is no longer
  memoised as "not SSO-backed" for the rest of the session; only a
  completed read is cached, so a transient failure is retried on the next
  call.
- The login mutex and its 30-second result cache are now keyed by the
  resolved token cache path, falling back to the profile name only when no
  cache path exists, because the file being protected is keyed by
  `sso_session`, not by profile.
- `profile` is now cleared before, not after, awaiting the
  credential-source log line, closing a window where a request landing
  during that round-trip could still reach a login attempt for a setup this
  plugin was told to skip.
- The login-timeout timer's handle is now cleared on a successful login
  instead of holding the event loop open for the rest of `loginTimeoutMs`.
- Guarded `event.properties.error?.data?.message` against a payload where
  `data` itself is missing, from an unpinned server version.
- Startup no longer toasts on failure, only logs: the TUI is not confirmed
  to exist that early, and a startup failure now relies on pre-flight's
  toast once a request is made.

### Added

- A 30-second result cache for completed logins, keyed the same way as the
  mutex, so the reactive hook does not repeat a login that just finished —
  browser tab closed, user cancelled — for the same failed message.
- `engines.node` (`>=22.18.0`, the first version with unflagged TypeScript
  type stripping), so an unsupported Node version fails with a clear engine
  mismatch instead of a cryptic syntax error from the test runner.
- A GitHub Actions workflow that runs the typecheck and test suite on push
  and pull request.

### Changed

- Corrected several inaccurate README statements: the profile-resolution
  order and what actually happens for a profile that resolves but is not
  SSO-backed, the comparison against the other two plugins (neither of them
  polls on a timer, and `opencode-aws-bedrock-auth` does not hook
  `chat.params`), and `sso-session` (the config block) versus `sso_session`
  (the key) where the two had been conflated. Also documented the `marginMs`
  ceiling and the minimum supported opencode version.


## [0.2.0] - 2026-08-19

### Added

- Plugin options: `marginMs`, `toastMs`, `loginTimeoutMs`, `awsCommand`,
  `providerID` and `profile`. Every default matches 0.1.0 behaviour, so an
  existing install is unaffected unless it opts in. `loginTimeoutMs`
  defaults to 0 (no timeout), because `aws sso login` is already bounded by
  the device code expiry and killing it mid-flow risks a partial token
  cache write.

### Fixed

- Startup, pre-flight and reactive diagnostics now go to opencode's log
  (`client.app.log`) instead of `console.log`, which plugins cannot reach
  from the TUI or opencode's own log file. The deferred `startupNotice`
  toast workaround, needed only because that was wrongly assumed
  unreachable from the `config` hook, is gone; toasts remain for states the
  user has to act on.
- `ReauthResult` no longer overloads `"not-stale"` for the circuit-breaker
  and no-profile cases, so the reactive "the token looks valid" message no
  longer appears when the token was never checked — including for users on
  bearer tokens, static keys or container credentials, who have no token at
  all.
- Corrected the comment above `tokenState`: an unreadable cache file reads
  as stale, not unknown, and does drive a login.
- Corrected three inaccurate README statements: the no-op overview
  conflated "no SSO-backed profile" with "another credential source is
  configured" into one case with one notice, when the two are different
  and the second is silent by design; the install section implied opencode
  cannot install from npm, when not publishing there was simply this
  project's choice; and "no login timeout, by default" implied a setting
  to change when 0.1.0 had no options at all.


## [0.1.0] - 2026-08-19

First release. An opencode plugin that keeps the AWS SSO token behind the
Amazon Bedrock provider valid, so a session does not stall on an expired
token mid-conversation.

### Added

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

[Unreleased]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rjw1/opencode-bedrock-sso-refresh/releases/tag/v0.1.0

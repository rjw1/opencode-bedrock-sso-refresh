# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rjw1/opencode-bedrock-sso-refresh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rjw1/opencode-bedrock-sso-refresh/releases/tag/v0.1.0

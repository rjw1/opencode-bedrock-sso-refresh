# opencode-bedrock-sso-refresh

An [opencode](https://opencode.ai) plugin that keeps the AWS SSO token behind
the Amazon Bedrock provider valid, so a coding session does not stall on an
expired token mid-conversation.

## What it does

It reads `expiresAt` from the AWS CLI's own SSO token cache — the same file
`aws sso login` writes, located by hashing the profile's `sso-session` name
or, for legacy profiles, its `sso_start_url` — and re-authenticates five
minutes before that timestamp is reached. There are three points of
intervention:

1. **Startup.** On load, it runs `aws sts get-caller-identity` for the
   configured profile and, if that fails, `aws sso login`. This catches a
   token that expired before opencode was even started.
2. **Pre-flight.** Before each request to Bedrock, it checks the cached
   expiry. If the token is stale, it opens the browser and waits for
   `aws sso login` to finish before letting the request proceed.
3. **Reactive.** If a request still fails with a credential error — the
   pre-flight check raced a login from elsewhere, say — it re-checks the
   cache and, if the token really has gone stale, re-authenticates and asks
   you to resend the message.

If neither `provider.amazon-bedrock.options.profile` nor `AWS_PROFILE` names
an SSO-backed profile, the plugin does nothing beyond a one-time notice. If
another AWS credential source is already configured (see below), it steps
aside silently instead.

## Install

This project has not published an npm release. Add it to your opencode
config as a git dependency:

```json
{
  "plugin": [
    "opencode-bedrock-sso-refresh@git+https://github.com/rjw1/opencode-bedrock-sso-refresh.git"
  ]
}
```

## Options

Configure the plugin using the tuple form of opencode's `plugin` config
entry:

```json
{
  "plugin": [
    ["opencode-bedrock-sso-refresh@git+https://github.com/rjw1/opencode-bedrock-sso-refresh.git",
     { "marginMs": 600000 }]
  ]
}
```

| Option           | Type     | Default          | Effect |
| ---------------- | -------- | ---------------- | ------ |
| `marginMs`       | `number` | `300000` (5 min) | How far ahead of the token's expiry to treat it as stale and re-authenticate. |
| `toastMs`        | `number` | `60000` (60 s)   | How long the re-authentication warning toast stays on screen. |
| `loginTimeoutMs` | `number` | `0` (no timeout) | If positive, how long to wait for `aws sso login` before reporting failure. The process is never killed — see [What it deliberately does not do](#what-it-deliberately-does-not-do). |
| `awsCommand`     | `string` | `"aws"`          | The AWS CLI binary to invoke, for setups where it is not on `PATH` under that name. |
| `providerID`     | `string` | `"amazon-bedrock"` | The opencode provider ID to watch and to read `options.profile` from, for setups where Bedrock is registered under another id. |
| `profile`        | `string` | unset            | The AWS profile to use. Takes priority over `provider.<providerID>.options.profile`, `AWS_PROFILE` and `AWS_DEFAULT_PROFILE`. |

Any value of the wrong type, or a number that is not positive, is ignored
and the default is used instead — the plugin never fails to load over a
bad option.

## Requirements

- AWS CLI v2 (for `aws sso login` and the token cache format it produces).
- An SSO-backed profile in `~/.aws/config` — one with `sso_session` (the
  modern, `sso-session`-block style) or the older `sso_start_url` set
  directly on the profile.
- That profile named via `provider.amazon-bedrock.options.profile` in your
  opencode config, or `AWS_PROFILE` in the environment.

## When it no-ops

opencode's Bedrock provider prefers several credential sources over a
profile: a Bedrock bearer token (`AWS_BEARER_TOKEN_BEDROCK`), a static access
key pair, container credentials, or web identity federation. If any of
those is present, the plugin steps aside entirely and does not attempt an
SSO login — that would just interrupt a working setup to fix a problem you
do not have.

## What it deliberately does not do

- **No npm release.** Install from the git repository, as above.
- **No agent-callable refresh tool.** The agent cannot ask the plugin to
  re-authenticate on demand; refresh only happens at the three points above.
- **No login timeout by default.** If `aws sso login` opens a browser and
  nobody completes the flow, the request waits indefinitely unless
  `loginTimeoutMs` is set. The toast includes the equivalent command to run
  by hand if that happens.

## Compared to other plugins

Two other opencode plugins solve a similar problem, and it is worth being
upfront about how this one differs:

- [**opencode-bedrock-sso**](https://www.npmjs.com/package/opencode-bedrock-sso)
  by Mani Sundararajan. Published on npm under the MIT license; no public
  repository. It is well engineered and exposes its own set of plugin
  options.
- [**opencode-aws-bedrock-auth**](https://github.com/favasconcelos/opencode-aws-bedrock-auth)
  by favasconcelos. Available on GitHub and npm.

Both keep the session healthy by polling `aws sts get-caller-identity` and
throttling that check — every five minutes for `opencode-bedrock-sso`, every
twenty for `opencode-aws-bedrock-auth`. That is a reasonable design, but it
means a token that expires shortly after a healthy check leaves a window,
up to the throttle interval wide, in which requests simply fail until the
next poll fires. This plugin reads the expiry timestamp directly out of the
token cache instead of inferring health from a probe request, so there is
no such window: a token due to expire is caught before it does, on every
request. That is a trade the other two made, not a fault in either of
them — polling `sts get-caller-identity` is simpler and needs no knowledge
of the token cache's on-disk format.

This plugin is younger than both. See [Options](#options) above for what it
now exposes.

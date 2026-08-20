# opencode-bedrock-sso-refresh

An [opencode](https://opencode.ai) plugin that keeps the AWS SSO token behind
the Amazon Bedrock provider valid, so a coding session does not stall on an
expired token mid-conversation.

## What it does

It reads `expiresAt` from the AWS CLI's own SSO token cache — the same file
`aws sso login` writes, located by hashing the value of the profile's
`sso_session` key or, for legacy profiles, its `sso_start_url` — and
re-authenticates five minutes before that timestamp is reached. There are
three points of intervention:

1. **Startup.** On load, it checks the cached expiry for the configured
   profile and, if the token is already stale, runs `aws sso login`. This
   catches a token that expired before opencode was even started.
2. **Pre-flight.** Before each request to Bedrock, it checks the cached
   expiry. If the token is stale, it opens the browser and waits for
   `aws sso login` to finish before letting the request proceed.
3. **Reactive.** If a request still fails with a credential error — the
   pre-flight check raced a login from elsewhere, say — it re-checks the
   cache and, if the token really has gone stale, re-authenticates and asks
   you to resend the message.

The profile is resolved in this order: the plugin's own `profile` option,
then `provider.<providerID>.options.profile` (`amazon-bedrock` by default),
then `AWS_PROFILE`, then `AWS_DEFAULT_PROFILE`. If none of these names a
profile, or the profile that is named has no `sso_session` or
`sso_start_url` set, startup logs that fact to opencode's log
(`client.app.log` — there is no toast this early) and does not attempt a
login. That is not quite the end of it for the second case: pre-flight and
the reactive hook stay registered and keep evaluating the same cached-expiry
check on every subsequent request. Finding no cache to read, that check
always comes back "not stale", so nothing further happens — it is a no-op
repeated on every request, not a one-off notice.

If another AWS credential source is already configured (see below), the
plugin also logs that once to opencode's log and does not attempt a login,
for as long as that credential source remains set.

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

`marginMs` has no enforced ceiling, but it must stay shorter than the SSO
session's token lifetime (commonly eight hours, though Identity Center
administrators can set it lower). A margin longer than that makes even a
freshly minted token read as stale, which trips the circuit breaker on the
very first request and disables automatic re-authentication for the rest
of the session.

## Requirements

- opencode `>=1.17.0` — the floor this plugin's tuple-form options,
  `client.app.log` calls and TypeScript-as-`main` all require.
- AWS CLI v2 (for `aws sso login` and the token cache format it produces).
- An SSO-backed profile in `~/.aws/config` — one with `sso_session` (the
  modern, `sso-session`-block style) or the older `sso_start_url` set
  directly on the profile.
- That profile resolved by one of `profile` (the plugin option),
  `provider.<providerID>.options.profile`, `AWS_PROFILE` or
  `AWS_DEFAULT_PROFILE` — see [Options](#options) for the precedence order.

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
  by favasconcelos. Also MIT licensed, with a public repository at that
  address, and available on npm.

Neither of the other two runs a background timer — "polling" overstates
it. Both check lazily on a request path with a throttle, the same shape
this plugin also uses: it too checks on a request path rather than on a
schedule. The real difference is what the check consults, not how often it
fires. `opencode-bedrock-sso` and `opencode-aws-bedrock-auth` both ask AWS
STS whether the current credentials work right now, via
`aws sts get-caller-identity`, and throttle that question to keep it
affordable — every five minutes for `opencode-bedrock-sso`, every twenty
for `opencode-aws-bedrock-auth`. A token that expires shortly after a
healthy check therefore leaves a window, up to the throttle interval wide,
in which requests simply fail until the next check fires. This plugin
reads the expiry timestamp out of the token cache instead of asking STS,
so it needs no throttle and has no such window: a token due to expire is
caught before it does, on every request. That is a trade the other two
made, not a fault in either of them — asking STS is simpler and needs no
knowledge of the token cache's on-disk format.

The two also differ in when the check runs at all. `opencode-bedrock-sso`
hooks `chat.params`, the same point this plugin checks from, so its
throttled STS check fires on every conversational turn against a matching
provider. `opencode-aws-bedrock-auth` does not hook `chat.params`: it
checks once at startup and again only before a `bash` or `task` tool call,
so a plain conversation that never calls one of those tools is not checked
again after startup.

This plugin is younger than both. See [Options](#options) above for what it
now exposes.

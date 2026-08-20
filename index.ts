import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  EXPIRY_MARGIN_MS,
  awsConfigPath,
  cacheKeyForProfile,
  freshness,
  nonEmptyString,
  otherCredentialSource,
  parseIni,
  resolveProfileName,
  tokenCacheFilename,
  type IniSections,
  type TokenState,
} from "./token.ts"

// Keeps the AWS SSO token behind the Bedrock provider valid.
//
// Points of intervention:
//   1. startup    - `aws sso login` if tokenState already reads stale
//   2. pre-flight - before each Bedrock request, if the cached token is stale
//   3. reactive   - on the credential error that slips past pre-flight
//
// The profile is resolved from the plugin's own `profile` option, then
// provider.<providerID>.options.profile, then AWS_PROFILE. If none is set the
// plugin does nothing beyond warning once. tokenState is tri-state, and
// "unknown" -- a profile with no SSO configuration -- must never reach login.

type ReauthResult = "not-stale" | "recovered" | "failed" | "disabled" | "no-profile"

// Toasts default to 5s, but the re-auth warning carries the fallback command for
// a browser that never opens -- a state that leaves the request hanging for
// minutes, long after the default has elapsed.
const WARNING_TOAST_MS = 60_000

// Thrown by @ai-sdk/amazon-bedrock when the credentialProvider opencode hands it
// rejects. Reaches the bus as ProviderAuthError or UnknownError; both carry
// data.message.
const CREDENTIAL_ERROR = "AWS credential provider failed"

type LoginResult = { ok: boolean; detail: string }

// Pre-flight can start a login, have it fail (browser tab closed, network
// blip), let the request through anyway, and then the reactive hook fires on
// the resulting credential error moments later. Without this window the
// reactive hook would open a second browser tab for the same message.
const RESULT_CACHE_WINDOW_MS = 30_000

// `ok: false` means the read itself failed -- EMFILE, the file mid-rewrite, not
// yet created -- which is transient and must not be memoised. `ok: true` with
// path undefined means the read succeeded and this profile has no SSO config,
// which is a stable answer.
const deriveTokenCachePath = (profile: string): { ok: true; path: string | undefined } | { ok: false } => {
  let sections: IniSections
  try {
    sections = parseIni(readFileSync(awsConfigPath(process.env, homedir()), "utf8"))
  } catch {
    return { ok: false }
  }

  const cacheKey = cacheKeyForProfile(sections, profile)
  if (!cacheKey) return { ok: true, path: undefined }
  return { ok: true, path: join(homedir(), ".aws", "sso", "cache", tokenCacheFilename(cacheKey)) }
}

let cachedPath: { profile: string; path: string | undefined } | undefined

// ~/.aws/config does not change mid-session, so a successful read is resolved
// once. A failed read is retried on the next call instead of being remembered
// as "not SSO-backed" for the rest of the session.
const tokenCachePath = (profile: string): string | undefined => {
  if (cachedPath?.profile === profile) return cachedPath.path
  const result = deriveTokenCachePath(profile)
  if (!result.ok) return undefined
  cachedPath = { profile, path: result.path }
  return result.path
}

// A missing or otherwise unreadable cache file for an SSO-backed profile reads as
// stale, because an unusable cache is grounds to re-authenticate. Only a profile
// with no SSO configuration, or a cache whose expiry will not parse, is unknown.
const tokenState = (profile: string, marginMs: number): TokenState => {
  const path = tokenCachePath(profile)
  if (!path) return "unknown"

  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return "stale"
  }

  try {
    return freshness((JSON.parse(contents) as { expiresAt?: unknown }).expiresAt, marginMs, Date.now())
  } catch {
    return "unknown"
  }
}

export default (async ({ $, client }, options) => {
  const positiveNumber = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback

  const marginMs = positiveNumber(options?.["marginMs"], EXPIRY_MARGIN_MS)
  const toastMs = positiveNumber(options?.["toastMs"], WARNING_TOAST_MS)
  // 0 or absent means no timeout, which is the existing behaviour: aws sso login
  // is already bounded by the device code expiry.
  const loginTimeoutMs = positiveNumber(options?.["loginTimeoutMs"], 0)
  const awsCommand = nonEmptyString(options?.["awsCommand"]) ?? "aws"
  const providerID = nonEmptyString(options?.["providerID"]) ?? "amazon-bedrock"
  const optionProfile = options?.["profile"]

  let profile: string | undefined
  // Keyed by the resolved token cache path, because that is the file the mutex
  // actually protects; two profiles could in principle share an sso_session and
  // fall back to the profile name only when no cache path exists.
  const inFlightLogins = new Map<string, Promise<LoginResult>>()
  const recentLogins = new Map<string, { result: LoginResult; at: number }>()
  // Set once a login reports success but tokenState still reads stale, meaning
  // the cache-path derivation is wrong on this machine. Without it, a wrong
  // derivation means a browser prompt on every single request, forever.
  let autoReauthDisabled = false

  const login = (target: string): Promise<LoginResult> => {
    const key = tokenCachePath(target) ?? target

    const existing = inFlightLogins.get(key)
    if (existing) return existing

    const cached = recentLogins.get(key)
    if (cached && Date.now() - cached.at < RESULT_CACHE_WINDOW_MS) return Promise.resolve(cached.result)

    const run = $`${awsCommand} sso login --profile ${target}`
      .quiet()
      .nothrow()
      .then((result) => ({
        ok: result.exitCode === 0,
        detail: (result.stderr.toString().trim() || result.stdout.toString().trim()).slice(-300),
      }))
      .then((result) => {
        recentLogins.set(key, { result, at: Date.now() })
        return result
      })

    // Cleanup is tied to `run`, the underlying command, never to the race below.
    // A timeout that wins the race must report failure without releasing the
    // mutex: botocore writes the token cache in place (truncate, write, no
    // rename, no lock), so a second `aws sso login` starting while the first is
    // still running can interleave writes and corrupt the file for every AWS
    // SDK and CLI call on the machine until the user logs in by hand.
    run.finally(() => {
      inFlightLogins.delete(key)
    })

    // Not killed on timeout: aws sso login exits on its own at device-code
    // expiry, and killing it mid-flow could leave a partial token cache write.
    const attempt =
      loginTimeoutMs > 0
        ? Promise.race([
            run,
            new Promise<LoginResult>((resolve) => {
              const timer = setTimeout(
                () => resolve({ ok: false, detail: `timed out after ${loginTimeoutMs}ms` }),
                loginTimeoutMs,
              )
              timer.unref()
            }),
          ])
        : run

    inFlightLogins.set(key, attempt)
    return attempt
  }

  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error",
    duration?: number,
  ) => {
    await client.tui.showToast({ body: { title: "AWS SSO", message, variant, duration } }).catch(() => {})
  }

  // Plugin console output reaches neither the TUI nor opencode's log file, but
  // app.log does, which is where anything diagnostic rather than actionable goes.
  const log = async (level: "debug" | "info" | "warn" | "error", message: string) => {
    await client.app
      .log({ body: { service: "opencode-bedrock-sso-refresh", level, message } })
      .catch(() => {})
  }

  const reauthenticateIfStale = async (resend: boolean): Promise<ReauthResult> => {
    if (!profile) return "no-profile"
    if (autoReauthDisabled) return "disabled"
    if (tokenState(profile, marginMs) !== "stale") return "not-stale"

    await log("info", `Token for ${profile} is stale; logging in.`)
    await toast(
      `Token for ${profile} has expired. Opening the browser to re-authenticate... ` +
        `If none opens, run: ${awsCommand} sso login --profile ${profile}`,
      "warning",
      toastMs,
    )
    const result = await login(profile)
    if (!result.ok) {
      await log("error", `aws sso login failed for ${profile}. ${result.detail}`)
      await toast(`aws sso login failed for ${profile}. Run it manually. ${result.detail}`, "error")
      return "failed"
    }

    if (tokenState(profile, marginMs) === "stale") {
      autoReauthDisabled = true
      await log("error", `Circuit breaker tripped for ${profile}; disabling automatic re-authentication.`)
      await toast(
        `aws sso login for ${profile} succeeded but the token still reads as stale. ` +
          `Automatic re-authentication is disabled for the rest of this session.`,
        "error",
      )
      return "failed"
    }

    await toast(
      resend ? `Re-authenticated ${profile}. Resend your message.` : `Re-authenticated ${profile}.`,
      "success",
    )
    return "recovered"
  }

  return {
    // Logs only, never toasts: the TUI is not confirmed to exist this early, so
    // a startup failure relies on pre-flight's toast once a request is made,
    // by which point the TUI definitely exists. Login is gated on tokenState,
    // not an sts probe: that also reaches "stale", but cheaper, without the
    // false positives an unrelated network or IAM fault would produce, and
    // without blocking server init on an unbounded call to a possibly
    // unreachable network.
    config: async (cfg) => {
      const credentialSource = otherCredentialSource(process.env)
      if (credentialSource) {
        // Cleared before the await below, not after, so a request landing
        // during that round-trip cannot still see a profile set and reach
        // reauthenticateIfStale for a setup this plugin was told to skip.
        profile = undefined
        await log("info", `${credentialSource} is set, so this plugin is not managing credentials.`)
        return
      }

      profile = resolveProfileName(optionProfile, cfg.provider?.[providerID]?.options?.["profile"], process.env)
      if (!profile) {
        await log("warn", "No AWS profile configured for Bedrock, so SSO checks are disabled.")
        return
      }
      if (!tokenCachePath(profile)) {
        await log(
          "warn",
          `${profile} sets neither sso_session nor sso_start_url, so pre-flight token checks are disabled.`,
        )
        return
      }
      if (tokenState(profile, marginMs) !== "stale") return

      const result = await login(profile)
      if (!result.ok) {
        await log("error", `aws sso login failed for ${profile} at startup. Run it manually. ${result.detail}`)
      }
    },

    // Awaited, so the message visibly waits on the browser flow. That is the
    // point: the request then proceeds against a fresh token instead of failing.
    "chat.params": async (input) => {
      if (input.model.providerID !== providerID) return
      await reauthenticateIfStale(false)
    },

    event: async ({ event }) => {
      if (event.type !== "session.error") return

      const message = event.properties.error?.data?.message
      if (typeof message !== "string" || !message.includes(CREDENTIAL_ERROR)) return

      // Re-check before logging in. A valid token means the failure was not
      // expiry -- a wrong profile, a missing aws-sso-util, a network fault --
      // and opening a browser would loop on every retry. The failed request
      // cannot be resumed from a plugin, hence the request to resend.
      const result = await reauthenticateIfStale(true)
      if (result === "not-stale") {
        await log("warn", `Bedrock credentials failed despite a fresh token. ${message}`)
        await toast(`Bedrock credentials failed, but the token looks valid. ${message}`, "error")
      } else if (result === "no-profile") {
        // No profile means no token, so "the token looks valid" is meaningless to
        // a user on bearer-token, static-key or container credentials.
        await toast(
          `Bedrock credentials failed. This plugin is not managing credentials ` +
            `for this setup, so it cannot help. ${message}`,
          "error",
        )
      } else if (result === "disabled") {
        await toast(
          `Bedrock credentials failed and automatic re-authentication is disabled ` +
            `for this session. Run: ${awsCommand} sso login --profile ${profile}. ${message}`,
          "error",
          toastMs,
        )
      }
    },
  }
}) satisfies Plugin

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  EXPIRY_MARGIN_MS,
  awsConfigPath,
  cacheKeyForProfile,
  freshness,
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
//   1. startup    - `sts get-caller-identity`, and `aws sso login` if it fails
//   2. pre-flight - before each Bedrock request, if the cached token is stale
//   3. reactive   - on the credential error that slips past pre-flight
//
// The profile is resolved from provider.amazon-bedrock.options.profile, then
// AWS_PROFILE. If neither is set the plugin does nothing beyond warning once.

type ReauthResult = "not-stale" | "recovered" | "failed" | "disabled" | "no-profile"

// Toasts default to 5s, but the re-auth warning carries the fallback command for
// a browser that never opens -- a state that leaves the request hanging for
// minutes, long after the default has elapsed.
const WARNING_TOAST_MS = 60_000

// Thrown by @ai-sdk/amazon-bedrock when the credentialProvider opencode hands it
// rejects. Reaches the bus as ProviderAuthError or UnknownError; both carry
// data.message.
const CREDENTIAL_ERROR = "AWS credential provider failed"

const deriveTokenCachePath = (profile: string): string | undefined => {
  let sections: IniSections
  try {
    sections = parseIni(readFileSync(awsConfigPath(process.env, homedir()), "utf8"))
  } catch {
    return undefined
  }

  const cacheKey = cacheKeyForProfile(sections, profile)
  if (!cacheKey) return undefined
  return join(homedir(), ".aws", "sso", "cache", tokenCacheFilename(cacheKey))
}

let cachedPath: { profile: string; path: string | undefined } | undefined

// ~/.aws/config does not change mid-session, so resolve the path once.
const tokenCachePath = (profile: string): string | undefined => {
  if (cachedPath?.profile !== profile) cachedPath = { profile, path: deriveTokenCachePath(profile) }
  return cachedPath.path
}

// A missing or otherwise unreadable cache file for an SSO-backed profile reads as
// stale, because an unusable cache is grounds to re-authenticate. Only a profile
// with no SSO configuration, or a cache whose expiry will not parse, is unknown.
const tokenState = (profile: string): TokenState => {
  const path = tokenCachePath(profile)
  if (!path) return "unknown"

  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    return "stale"
  }

  try {
    return freshness((JSON.parse(contents) as { expiresAt?: unknown }).expiresAt, EXPIRY_MARGIN_MS, Date.now())
  } catch {
    return "unknown"
  }
}

export default (async ({ $, client }) => {
  let profile: string | undefined
  const inFlightLogins = new Map<string, Promise<{ ok: boolean; detail: string }>>()
  // Set once a login reports success but tokenState still reads stale, meaning
  // the cache-path derivation is wrong on this machine. Without it, a wrong
  // derivation means a browser prompt on every single request, forever.
  let autoReauthDisabled = false

  const login = (target: string) => {
    const existing = inFlightLogins.get(target)
    if (existing) return existing

    const attempt = $`aws sso login --profile ${target}`
      .quiet()
      .nothrow()
      .then((result) => ({
        ok: result.exitCode === 0,
        detail: (result.stderr.toString().trim() || result.stdout.toString().trim()).slice(-300),
      }))
      .finally(() => {
        inFlightLogins.delete(target)
      })

    inFlightLogins.set(target, attempt)
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
    if (tokenState(profile) !== "stale") return "not-stale"

    await log("info", `Token for ${profile} is stale; logging in.`)
    await toast(
      `Token for ${profile} has expired. Opening the browser to re-authenticate... ` +
        `If none opens, run: aws sso login --profile ${profile}`,
      "warning",
      WARNING_TOAST_MS,
    )
    const result = await login(profile)
    if (!result.ok) {
      await log("error", `aws sso login failed for ${profile}. ${result.detail}`)
      await toast(`aws sso login failed for ${profile}. Run it manually. ${result.detail}`, "error")
      return "failed"
    }

    if (tokenState(profile) === "stale") {
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

  const ensureSession = async (target: string) => {
    const check = await $`aws sts get-caller-identity --profile ${target}`.quiet().nothrow()
    if (check.exitCode === 0) return

    const result = await login(target)
    if (!result.ok) {
      const notice = `aws sso login failed for ${target} at startup. Run it manually. ${result.detail}`
      await log("error", notice)
      await toast(notice, "warning", WARNING_TOAST_MS)
    }
  }

  return {
    config: async (cfg) => {
      profile = resolveProfileName(undefined, cfg.provider?.["amazon-bedrock"]?.options?.["profile"], process.env)
      const credentialSource = otherCredentialSource(process.env)
      if (credentialSource) {
        await log("info", `${credentialSource} is set, so this plugin is not managing credentials.`)
        profile = undefined
        return
      }
      if (!profile) {
        await log("warn", "No AWS profile configured for Bedrock, so SSO checks are disabled.")
        return
      }
      if (!tokenCachePath(profile)) {
        await log(
          "warn",
          `${profile} sets neither sso_session nor sso_start_url, so pre-flight token checks are disabled.`,
        )
      }
      await ensureSession(profile)
    },

    // Awaited, so the message visibly waits on the browser flow. That is the
    // point: the request then proceeds against a fresh token instead of failing.
    "chat.params": async (input) => {
      if (input.model.providerID !== "amazon-bedrock") return
      await reauthenticateIfStale(false)
    },

    event: async ({ event }) => {
      if (event.type !== "session.error") return

      const message = event.properties.error?.data.message
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
            `for this session. Run: aws sso login --profile ${profile}. ${message}`,
          "error",
          WARNING_TOAST_MS,
        )
      }
    },
  }
}) satisfies Plugin

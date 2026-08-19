import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  EXPIRY_MARGIN_MS,
  awsConfigPath,
  cacheKeyForProfile,
  freshness,
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

type ReauthResult = "not-stale" | "recovered" | "failed"

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

// A missing cache file for an SSO-backed profile is stale; anything unreadable
// is unknown, which never drives a login.
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
  let inFlightLogin: Promise<{ ok: boolean; detail: string }> | undefined
  // Set once a login reports success but tokenState still reads stale, meaning
  // the cache-path derivation is wrong on this machine. Without it, a wrong
  // derivation means a browser prompt on every single request, forever.
  let autoReauthDisabled = false
  // The config hook runs before the TUI attaches, so anything startup wants to
  // say has to wait for a request to carry it.
  let startupNotice: string | undefined

  // Single-flight, so overlapping callers await one browser flow instead of
  // opening two and racing on the token cache.
  const login = (target: string) => {
    if (!inFlightLogin) {
      inFlightLogin = $`aws sso login --profile ${target}`
        .quiet()
        .nothrow()
        .then((result) => ({
          ok: result.exitCode === 0,
          detail: (result.stderr.toString().trim() || result.stdout.toString().trim()).slice(-300),
        }))
        .finally(() => {
          inFlightLogin = undefined
        })
    }
    return inFlightLogin
  }

  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error",
    duration?: number,
  ) => {
    await client.tui.showToast({ body: { title: "AWS SSO", message, variant, duration } }).catch(() => {})
  }

  const reauthenticateIfStale = async (resend: boolean): Promise<ReauthResult> => {
    if (!profile || autoReauthDisabled) return "not-stale"
    if (tokenState(profile) !== "stale") return "not-stale"

    await toast(
      `Token for ${profile} has expired. Opening the browser to re-authenticate... ` +
        `If none opens, run: aws sso login --profile ${profile}`,
      "warning",
      WARNING_TOAST_MS,
    )
    const result = await login(profile)
    if (!result.ok) {
      await toast(`aws sso login failed for ${profile}. Run it manually. ${result.detail}`, "error")
      return "failed"
    }

    if (tokenState(profile) === "stale") {
      autoReauthDisabled = true
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
      startupNotice = `aws sso login failed for ${target} at startup. Run it manually. ${result.detail}`
    }
  }

  return {
    config: async (cfg) => {
      profile = resolveProfileName(undefined, cfg.provider?.["amazon-bedrock"]?.options?.["profile"], process.env)
      if (!profile) {
        startupNotice = "No AWS profile configured for Bedrock, so SSO checks are disabled."
        return
      }
      if (!tokenCachePath(profile)) {
        startupNotice =
          `${profile} sets neither sso_session nor sso_start_url, ` +
          `so pre-flight token checks are disabled.`
      }
      await ensureSession(profile)
    },

    // Awaited, so the message visibly waits on the browser flow. That is the
    // point: the request then proceeds against a fresh token instead of failing.
    "chat.params": async (input) => {
      if (input.model.providerID !== "amazon-bedrock") return
      if (startupNotice) {
        const notice = startupNotice
        // Cleared before awaiting so overlapping requests cannot both toast it.
        startupNotice = undefined
        await toast(notice, "warning", WARNING_TOAST_MS)
      }
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
      if ((await reauthenticateIfStale(true)) === "not-stale") {
        await toast(`Bedrock credentials failed, but the token looks valid. ${message}`, "error")
      }
    },
  }
}) satisfies Plugin

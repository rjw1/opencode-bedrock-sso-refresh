import { createHash } from "node:crypto"

export type IniSections = Record<string, Record<string, string>>
export type TokenState = "fresh" | "stale" | "unknown"

// Re-authenticate this far ahead of expiry so a token cannot lapse between the
// check and the request it guards.
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000

// botocore parses ~/.aws/config with Python's RawConfigParser, which strips
// whole-line comments and keeps inline ones in the value. This must match,
// because the token cache filename is a hash of that exact value: an
// sso_start_url of `https://example.awsapps.com/start#/` has to survive intact.
export const parseIni = (text: string): IniSections => {
  const sections: IniSections = {}
  let current: Record<string, string> | undefined

  for (const rawLine of text.split("\n")) {
    const line = /^\s*[#;]/.test(rawLine) ? "" : rawLine.trim()
    if (line.length === 0) continue

    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      // botocore strips surrounding quotes from section names, so
      // [profile "with space"] and [profile with space] are the same profile.
      const name = header[1].trim().replace(/^(profile\s+)?"(.*)"$/, "$1$2")
      if (!sections[name]) sections[name] = {}
      current = sections[name]
      continue
    }

    if (!current) continue
    const separator = line.indexOf("=")
    if (separator < 0) continue
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  return sections
}

// The AWS CLI names its token cache after the sha1 of the sso-session name for
// session-style profiles, or of sso_start_url for legacy ones. Returning
// undefined means the profile is not SSO-backed, which callers must treat as
// "do not attempt a login" rather than "expired".
// botocore accepts both [default] and [profile default], preferring the former.
export const sectionNameForProfile = (profile: string): string[] =>
  profile === "default" ? ["default", "profile default"] : [`profile ${profile}`]

export const cacheKeyForProfile = (sections: IniSections, profile: string): string | undefined => {
  for (const name of sectionNameForProfile(profile)) {
    const section = sections[name]
    if (!section) continue
    const cacheKey = section["sso_session"] ?? section["sso_start_url"]
    if (cacheKey) return cacheKey
  }
  return undefined
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

// AWS_DEFAULT_PROFILE is honoured by botocore and was previously ignored here.
export const resolveProfileName = (
  pluginProfile: unknown,
  providerProfile: unknown,
  env: Record<string, string | undefined>,
): string | undefined =>
  nonEmptyString(pluginProfile) ??
  nonEmptyString(providerProfile) ??
  nonEmptyString(env["AWS_PROFILE"]) ??
  nonEmptyString(env["AWS_DEFAULT_PROFILE"])

export const awsConfigPath = (env: Record<string, string | undefined>, home: string): string => {
  const configured = nonEmptyString(env["AWS_CONFIG_FILE"])
  if (!configured) return `${home}/.aws/config`
  // The shell expands ~ before a program sees it, but a value read from a config
  // file or a systemd unit arrives literally.
  return configured.startsWith("~/") ? `${home}/${configured.slice(2)}` : configured
}

export const tokenCacheFilename = (cacheKey: string): string =>
  `${createHash("sha1").update(cacheKey).digest("hex")}.json`

// "unknown" rather than "stale" for anything unreadable, so a malformed cache
// cannot drive a browser flow on every request.
export const freshness = (expiresAt: unknown, marginMs: number, now: number): TokenState => {
  if (typeof expiresAt !== "string") return "unknown"
  const expiry = Date.parse(expiresAt)
  if (Number.isNaN(expiry)) return "unknown"
  return expiry - now > marginMs ? "fresh" : "stale"
}

// opencode's own Bedrock provider prefers these over a profile, so when any is
// present an SSO login is pointless and would just interrupt a working setup.
// Returns the variable that decided it, so callers can say which one without
// duplicating these rules.
export const otherCredentialSource = (env: Record<string, string | undefined>): string | undefined => {
  if (env["AWS_BEARER_TOKEN_BEDROCK"]) return "AWS_BEARER_TOKEN_BEDROCK"
  if (env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) return "AWS_ACCESS_KEY_ID"
  if (env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]) return "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"
  if (env["AWS_CONTAINER_CREDENTIALS_FULL_URI"]) return "AWS_CONTAINER_CREDENTIALS_FULL_URI"
  if (env["AWS_WEB_IDENTITY_TOKEN_FILE"] && env["AWS_ROLE_ARN"]) return "AWS_WEB_IDENTITY_TOKEN_FILE"
  return undefined
}

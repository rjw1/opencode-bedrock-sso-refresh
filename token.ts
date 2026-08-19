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
      const name = header[1].trim()
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
export const cacheKeyForProfile = (sections: IniSections, profile: string): string | undefined => {
  const section = sections[profile === "default" ? "default" : `profile ${profile}`]
  if (!section) return undefined
  return section["sso_session"] ?? section["sso_start_url"]
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

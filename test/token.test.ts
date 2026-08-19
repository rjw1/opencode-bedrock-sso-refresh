import test from "node:test"
import assert from "node:assert/strict"
import {
  awsConfigPath,
  cacheKeyForProfile,
  freshness,
  hasOtherCredentialSource,
  parseIni,
  resolveProfileName,
  tokenCacheFilename,
} from "../token.ts"

test("parseIni keeps an inline hash in a value", () => {
  const sections = parseIni("[profile p]\nsso_start_url = https://x.awsapps.com/start#/\n")
  assert.equal(sections["profile p"]?.["sso_start_url"], "https://x.awsapps.com/start#/")
})

test("parseIni strips whole-line comments, indented or not", () => {
  const sections = parseIni("[profile p]\n# a comment\n  ; another\nregion = eu-west-2\n")
  assert.deepEqual(sections["profile p"], { region: "eu-west-2" })
})

test("parseIni keeps a trailing inline comment, matching botocore", () => {
  const sections = parseIni("[profile p]\nregion = eu-west-2 ; trailing\n")
  assert.equal(sections["profile p"]?.["region"], "eu-west-2 ; trailing")
})

test("parseIni ignores keys before any section header", () => {
  assert.deepEqual(parseIni("stray = 1\n[profile p]\nregion = eu-west-2\n"), {
    "profile p": { region: "eu-west-2" },
  })
})

test("cacheKeyForProfile prefers sso_session over sso_start_url", () => {
  const sections = parseIni("[profile p]\nsso_session = s\nsso_start_url = https://x/start\n")
  assert.equal(cacheKeyForProfile(sections, "p"), "s")
})

test("cacheKeyForProfile falls back to sso_start_url", () => {
  const sections = parseIni("[profile p]\nsso_start_url = https://x/start\n")
  assert.equal(cacheKeyForProfile(sections, "p"), "https://x/start")
})

test("cacheKeyForProfile reads default from an unprefixed section", () => {
  const sections = parseIni("[default]\nsso_start_url = https://x/start\n")
  assert.equal(cacheKeyForProfile(sections, "default"), "https://x/start")
})

test("cacheKeyForProfile returns undefined for a non-SSO profile", () => {
  const sections = parseIni("[profile p]\naws_access_key_id = AKIA\n")
  assert.equal(cacheKeyForProfile(sections, "p"), undefined)
})

test("cacheKeyForProfile returns undefined for a missing profile", () => {
  assert.equal(cacheKeyForProfile(parseIni("[profile p]\n"), "absent"), undefined)
})

// Pins the derivation against a digest taken from a real AWS CLI cache file.
test("tokenCacheFilename matches the AWS CLI naming", () => {
  assert.equal(
    tokenCacheFilename("https://dxw.awsapps.com/start#/"),
    "3b9326b7e0ac9a055f072e3f9f3bc46d819644ed.json",
  )
})

test("freshness is fresh well beyond the margin", () => {
  const now = Date.parse("2026-08-19T12:00:00Z")
  assert.equal(freshness("2026-08-19T20:00:00Z", 5 * 60_000, now), "fresh")
})

test("freshness is stale inside the margin", () => {
  const now = Date.parse("2026-08-19T12:00:00Z")
  assert.equal(freshness("2026-08-19T12:04:00Z", 5 * 60_000, now), "stale")
})

test("freshness is stale exactly on the margin boundary", () => {
  const now = Date.parse("2026-08-19T12:00:00Z")
  assert.equal(freshness("2026-08-19T12:05:00Z", 5 * 60_000, now), "stale")
})

test("freshness is stale for an already expired token", () => {
  const now = Date.parse("2026-08-19T12:00:00Z")
  assert.equal(freshness("2026-08-19T11:00:00Z", 5 * 60_000, now), "stale")
})

test("freshness is unknown for a missing, non-string or unparseable expiry", () => {
  const now = Date.parse("2026-08-19T12:00:00Z")
  assert.equal(freshness(undefined, 5 * 60_000, now), "unknown")
  assert.equal(freshness(1_755_000_000_000, 5 * 60_000, now), "unknown")
  assert.equal(freshness("not a date", 5 * 60_000, now), "unknown")
})

test("cacheKeyForProfile accepts [profile default] as a synonym for [default]", () => {
  const sections = parseIni("[profile default]\nsso_start_url = https://x/start\n")
  assert.equal(cacheKeyForProfile(sections, "default"), "https://x/start")
})

test("cacheKeyForProfile prefers [default] when both spellings exist", () => {
  const sections = parseIni("[default]\nsso_start_url = https://a/start\n[profile default]\nsso_start_url = https://b/start\n")
  assert.equal(cacheKeyForProfile(sections, "default"), "https://a/start")
})

test("cacheKeyForProfile matches a quoted section name", () => {
  const sections = parseIni('[profile "with space"]\nsso_start_url = https://x/start\n')
  assert.equal(cacheKeyForProfile(sections, "with space"), "https://x/start")
})

test("resolveProfileName prefers the plugin option over everything", () => {
  const env = { AWS_PROFILE: "env", AWS_DEFAULT_PROFILE: "envdefault" }
  assert.equal(resolveProfileName("opt", "provider", env), "opt")
})

test("resolveProfileName prefers provider options over the environment", () => {
  const env = { AWS_PROFILE: "env" }
  assert.equal(resolveProfileName(undefined, "provider", env), "provider")
})

test("resolveProfileName prefers AWS_PROFILE over AWS_DEFAULT_PROFILE", () => {
  const env = { AWS_PROFILE: "env", AWS_DEFAULT_PROFILE: "envdefault" }
  assert.equal(resolveProfileName(undefined, undefined, env), "env")
})

test("resolveProfileName falls back to AWS_DEFAULT_PROFILE, which botocore honours", () => {
  assert.equal(resolveProfileName(undefined, undefined, { AWS_DEFAULT_PROFILE: "envdefault" }), "envdefault")
})

test("resolveProfileName ignores empty and non-string values", () => {
  assert.equal(resolveProfileName("", "  ", { AWS_PROFILE: "" }), undefined)
  assert.equal(resolveProfileName(7, null, {}), undefined)
})

test("awsConfigPath expands a leading tilde in AWS_CONFIG_FILE", () => {
  assert.equal(awsConfigPath({ AWS_CONFIG_FILE: "~/custom/config" }, "/home/b"), "/home/b/custom/config")
})

test("awsConfigPath uses AWS_CONFIG_FILE verbatim when absolute", () => {
  assert.equal(awsConfigPath({ AWS_CONFIG_FILE: "/etc/aws/config" }, "/home/b"), "/etc/aws/config")
})

test("awsConfigPath defaults to ~/.aws/config", () => {
  assert.equal(awsConfigPath({}, "/home/b"), "/home/b/.aws/config")
})

test("hasOtherCredentialSource detects a Bedrock bearer token", () => {
  assert.equal(hasOtherCredentialSource({ AWS_BEARER_TOKEN_BEDROCK: "t" }), true)
})

test("hasOtherCredentialSource needs both halves of a static key pair", () => {
  assert.equal(hasOtherCredentialSource({ AWS_ACCESS_KEY_ID: "AKIA" }), false)
  assert.equal(hasOtherCredentialSource({ AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s" }), true)
})

test("hasOtherCredentialSource detects either container credential variable", () => {
  assert.equal(hasOtherCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/x" }), true)
  assert.equal(hasOtherCredentialSource({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://x" }), true)
})

test("hasOtherCredentialSource needs both halves of web identity", () => {
  assert.equal(hasOtherCredentialSource({ AWS_WEB_IDENTITY_TOKEN_FILE: "/f" }), false)
  assert.equal(hasOtherCredentialSource({ AWS_WEB_IDENTITY_TOKEN_FILE: "/f", AWS_ROLE_ARN: "arn" }), true)
})

test("hasOtherCredentialSource is false for a plain SSO setup", () => {
  assert.equal(hasOtherCredentialSource({ AWS_PROFILE: "p" }), false)
})

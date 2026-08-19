import test from "node:test"
import assert from "node:assert/strict"
import { cacheKeyForProfile, freshness, parseIni, tokenCacheFilename } from "../token.ts"

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

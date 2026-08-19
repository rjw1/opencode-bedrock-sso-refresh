import type { Plugin } from "@opencode-ai/plugin"

// Probe build. Establishes two things before any real work: whether opencode can
// load TypeScript through package `main`, and whether client.app.log reaches the
// server log from each hook.
export default (async ({ client }) => {
  const log = async (message: string) => {
    await client.app
      .log({ body: { service: "opencode-bedrock-sso-refresh", level: "info", message } })
      .catch(() => {})
  }

  return {
    config: async () => {
      await log("probe: config hook reached")
    },
    "chat.params": async () => {
      await log("probe: chat.params hook reached")
    },
  }
}) satisfies Plugin

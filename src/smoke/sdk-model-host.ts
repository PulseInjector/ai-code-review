import { OpenCode } from "@opencode/sdk"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const runDirectory = process.argv[2]
const providerID = process.env.REVIEW_MODEL_PROVIDER_ID
const modelID = process.env.REVIEW_MODEL_ID
const baseURL = process.env.REVIEW_MODEL_BASE_URL
const apiKey = process.env.REVIEW_MODEL_API_KEY

if (!runDirectory || !providerID || !modelID || !baseURL || !apiKey) {
  throw new Error("missing model smoke configuration")
}
if (
  process.cwd() !== realpathSync(runDirectory) ||
  homedir() !== runDirectory ||
  ["CONFIG", "CACHE", "DATA", "STATE"].some(
    (name) => process.env[`XDG_${name}_HOME`] !== join(runDirectory, name.toLowerCase()),
  )
) {
  throw new Error("model smoke process is not isolated")
}

const host = await OpenCode.create({
  config: {
    directory: runDirectory,
    project: false,
    claude: false,
    content: JSON.stringify({
      providers: {
        [providerID]: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL, apiKey },
          models: { [modelID]: {} },
        },
      },
    }),
  },
  models: { fetch: false },
  fs: { filewatcher: false },
})

try {
  const deadline = Date.now() + 60_000
  let available = false
  while (Date.now() < deadline) {
    const models = await host.model.list({ location: { directory: runDirectory } })
    available = models.data.some((model) => model.providerID === providerID && model.id === modelID)
    if (available) break
    await Bun.sleep(100)
  }
  if (!available) throw new Error("configured model was not loaded")

  const session = await host.sessions.create({
    location: { directory: runDirectory },
    model: { providerID, id: modelID },
  })
  await host.sessions.prompt({ sessionID: session.id, text: "Reply with the single word OK. Do not use tools." })

  let completed = false
  while (Date.now() < deadline) {
    const messages = (await host.message.list({ sessionID: session.id, order: "asc" })).data
    const idle = messages.find((message) => message.type === "idle")
    if (idle) {
      const answered = messages.some(
        (message) =>
          message.type === "assistant" &&
          message.model.providerID === providerID &&
          message.model.id === modelID &&
          !message.error &&
          message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
      )
      if (idle.outcome !== "succeeded" || !answered) throw new Error("model session did not complete successfully")
      console.log(JSON.stringify({ smoke: "sdk-model", status: "passed", providerID, modelID }))
      completed = true
      break
    }
    await Bun.sleep(250)
  }
  if (!completed) throw new Error("model session timed out")
} finally {
  await host.close()
}

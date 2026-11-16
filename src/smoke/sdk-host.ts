import { OpenCode } from "@opencode/sdk"

const runDirectory = process.argv[2]
if (!runDirectory) throw new Error("missing run directory")

const host = await OpenCode.create({
  config: {
    directory: runDirectory,
    project: false,
    claude: false,
  },
  fs: { filewatcher: false },
})

await host.close()

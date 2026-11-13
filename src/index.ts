import type { Plugin } from "@opencode-ai/plugin"
import { createRouter } from "./router.ts"

// Keep this module's exports callable for OpenCode V1 loaders predating 1.18.29.
export const server: Plugin = async (input, options) => (await createRouter(input, options)).hooks

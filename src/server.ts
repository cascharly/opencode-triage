import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { tool } from "@opencode-ai/plugin/tool"
import { resolve } from "node:path"
import { createRouter } from "./router.ts"

const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)

// OpenCode V2 resolves ./server before the package root. V1 keeps the original
// callable export without loading this module or requiring the V2 SDK.
export default {
  id: "opencode-triage",
  async setup(ctx) {
    const registrations: Registration[] = []
    const nativeIds = new Map<string, string>()
    async function refreshNativeIds() {
      const { data: skills } = await ctx.skill.list()
      nativeIds.clear()
      for (const skill of skills) nativeIds.set(pathKey(skill.path), skill.id)
    }
    await refreshNativeIds()
    const worktree = ctx.location.project.canonical || ctx.location.directory
    const router = await createRouter({
      worktree,
      client: { tui: { showToast: async ({ body }) => { console.info(`[opencode-triage] ${body.message}`) } } },
    }, ctx.options, { nativeHooks: true, nativeSkillId: skill => nativeIds.get(pathKey(skill.path)) })
    const active = await router.state() === "on"
    const cleanup = async () => {
      await Promise.allSettled(registrations.map(registration => registration.dispose()))
      await router.hooks.dispose?.()
    }
    try {
      registrations.push(await ctx.tool.transform(editor => {
        if (active) editor.update("skill", skill => {
          skill.description = "Load a discovered native skill by ID. Use triage to search or list-skills to browse."
        })
        for (const [name, definition] of Object.entries(router.hooks.tool ?? {})) {
          editor.add({
            name,
            description: definition.description,
            input: tool.schema.object(definition.args),
            async execute(input, context) {
              const signal = context.signal
              if (signal.aborted) return { content: "Triage cancelled." }
              if (name === "load-skill") {
                await ctx.permission.assert({
                  sessionID: context.sessionID, agent: context.agent,
                  action: "skill", resources: [await router.permissionResource(String(input.name))],
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
              }
              const result = await definition.execute(input, {
                sessionID: context.sessionID, messageID: context.messageID,
                agent: context.agent, directory: ctx.location.directory,
                worktree, abort: signal,
                metadata() {},
                ask: async () => { throw new Error("Permission requests must use the V2 permission API") },
              })
              if (name === "rescan") {
                await ctx.skill.reload()
                await refreshNativeIds()
              }
              return typeof result === "string"
                ? { content: result }
                : { content: result.output, metadata: { ...result.metadata, title: result.title } }
            },
          })
        }
      }))
      // Hide automatic catalog exposure while retaining native skill lookup and
      // its permission checks. Transforms are synchronous and replayable.
      registrations.push(await ctx.skill.transform(editor => {
        if (active) for (const skill of editor.list()) editor.update(skill.id, item => { item.autoinvoke = false })
      }))
      const injected = new WeakSet<object>()
      registrations.push(await ctx.session.hook("context", async event => {
        const system = event.system.map(part => part.text)
        await router.transformSystem(system)
        event.system = system.map((text, index) => ({ ...event.system[index], type: "text", text }))
        let index = event.messages.length - 1
        while (index >= 0 && event.messages[index].role !== "user") index--
        const message = event.messages[index]
        if (!message || message.role !== "user") return
        const content = message.content.filter(part => !injected.has(part))
        const query = content.filter(part => part.type === "text").map(part => part.text).join(" ").trim()
        if (!query) return
        const suggestion = await router.suggest(query)
        if (!suggestion) return
        const part = { type: "text" as const, text: suggestion.block }
        injected.add(part)
        event.messages[index] = { ...message, content: [part, ...content] }
      }))
      // Auxiliary requests must not accidentally expose the full native catalog.
      for (const kind of ["compaction", "generate", "title"] as const) {
        registrations.push(await ctx.session.hook(kind, async event => {
          const system = event.system.map(part => part.text)
          await router.transformSystem(system, false)
          event.system = system.map((text, index) => ({ ...event.system[index], type: "text", text }))
        }))
      }
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
} satisfies Plugin.Plugin

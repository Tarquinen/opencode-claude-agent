export * as ClaudeProvider from "./provider.js"

import { Model, Provider } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { ClaudeStatus } from "../claude/status.js"
import type { ClaudeProbe } from "../claude/probe.js"
import { SdkPlaceholder } from "../language-model/sdk-placeholder.js"

export const ID = Provider.ID.make("claude-code")

// The model list we keep between starts, so models show before the login check finishes
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Number),
})
type CatalogModel = typeof CatalogModel.Type
const Catalog = Schema.Array(CatalogModel)
const CATALOG_KEY = "models"

const FALLBACK: readonly CatalogModel[] = [
  { id: "opus", name: "Opus", efforts: [] },
  { id: "sonnet", name: "Sonnet", efforts: [] },
  { id: "haiku", name: "Haiku", efforts: [] },
]

export const Plugin = define<Scope.Scope | ClaudeStatus.Service>({
  id: "claude-code.provider",
  effect: Effect.fn("ClaudeProvider.Plugin")(function* (ctx) {
    const status = yield* ClaudeStatus.Service
    const saved = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(CATALOG_KEY))
    let catalog = Option.getOrElse(saved, () => FALLBACK)

    yield* ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: ID,
          name: "Claude Agent",
          activation: "auto",
          package: `aisdk:${SdkPlaceholder.url}`,
        },
        models: catalog.map(toModel),
      })
    })

    yield* SubscriptionRef.changes(status.state).pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          if (state.type !== "ready") return
          const next = fromClaude(state.probe.models)
          if (JSON.stringify(next) === JSON.stringify(catalog)) return
          catalog = next
          yield* ctx.storage.set(CATALOG_KEY, catalog)
          yield* ctx.provider.reload()
        }),
      ),
      Effect.forkScoped,
    )
  }),
})

function fromClaude(models: readonly ClaudeProbe.Model[]): CatalogModel[] {
  const catalog: CatalogModel[] = []
  for (const model of models) {
    // "default" follows Claude Code's own default, which can change under a running opencode session
    if (model.value === "default") continue
    catalog.push({ id: model.value, name: model.displayName, efforts: model.supportedEffortLevels ?? [], contextWindow: model.contextWindow })
  }
  return catalog
}

function toModel(model: CatalogModel): Model.Info {
  const defaults = Model.Info.default(ID, Model.ID.make(model.id))
  return {
    ...defaults,
    name: model.name,
    // The SDK exposes capacity before a prompt, but not output limits. Zero means unknown in OpenCode.
    limit: { context: model.contextWindow ?? defaults.limit.context, output: 0 },
    // opencode picks the title model by family (Model.small in packages/core/src/model.ts)
    family: model.id.includes("haiku") ? Model.Family.make("claude-haiku") : undefined,
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
    // Covered by the subscription
    cost: [],
  }
}

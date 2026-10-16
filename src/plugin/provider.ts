export * as ClaudeProvider from "./provider.js"

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import { Model, Provider } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { ClaudeStatus } from "../claude/status.js"
import { SdkPlaceholder } from "../language-model/sdk-placeholder.js"

export const ID = Provider.ID.make("claude-code")

// The model list we keep between starts, so models show before the login check finishes
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
})
type CatalogModel = typeof CatalogModel.Type
const Catalog = Schema.Array(CatalogModel)
const CATALOG_KEY = "models"

// Shown on a new install until the first login check finishes
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
    const current = { catalog: Option.getOrElse(saved, () => FALLBACK) }

    yield* ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: ID,
          name: "Claude Code",
          activation: "auto",
          package: `aisdk:${SdkPlaceholder.url}`,
        },
        models: current.catalog.map(toModel),
      })
    })

    // Replace the saved list with what `claude` reports, and save it for the next start
    yield* SubscriptionRef.changes(status.state).pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          if (state.type !== "ready") return
          const catalog = fromClaude(state.probe.models)
          if (JSON.stringify(catalog) === JSON.stringify(current.catalog)) return
          current.catalog = catalog
          yield* ctx.storage.set(CATALOG_KEY, catalog)
          yield* ctx.provider.reload()
        }),
      ),
      Effect.forkScoped,
    )
  }),
})

function fromClaude(models: readonly ModelInfo[]): CatalogModel[] {
  const catalog: CatalogModel[] = []
  for (const model of models) {
    // "default" follows Claude Code's own default, which can change under a running opencode session
    if (model.value === "default") continue
    catalog.push({ id: model.value, name: model.displayName, efforts: model.supportedEffortLevels ?? [] })
  }
  return catalog
}

function toModel(model: CatalogModel): Model.Info {
  return {
    ...Model.Info.default(ID, Model.ID.make(model.id)),
    name: model.name,
    // opencode picks the title model by family (Model.small in packages/core/src/model.ts)
    family: model.id.includes("haiku") ? Model.Family.make("claude-haiku") : undefined,
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    // Each effort level is a variant, sent to our model as a provider option
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
    // Covered by the subscription
    cost: [],
  }
}

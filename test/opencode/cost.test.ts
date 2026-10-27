import { describe, expect } from "bun:test"
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { Model, Provider } from "@opencode/plugin/effect"
import { define } from "@opencode/plugin/effect/plugin"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeProvider } from "../../src/plugin/provider.js"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

const usd = Model.Cost.fields.input.make
const price = [{ input: usd(3), output: usd(15), cache: { read: usd(0.3), write: usd(3.75) } }]

const apiKey: AccountInfo = { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }

// Stands in for models.dev, which lists prices before the plugin loads. It replaces opencode's bundled list, so the
// expected price doesn't change with opencode's version.
function listPrice(providerID: Provider.ID, modelID: string) {
  return define({
    id: `price-${providerID}`,
    effect: (ctx) =>
      ctx.provider.transform((editor) => {
        editor.add({
          info: Provider.Info.empty(providerID),
          models: [{ ...Model.Info.default(providerID, Model.ID.make(modelID)), cost: price }],
        })
      }),
  })
}

const sonnetCost = Effect.fn(function* (opencode: TestOpenCode.Client) {
  const models = yield* opencode.model.list()
  const sonnet = models.data.find((model) => model.providerID === ClaudeProvider.ID && model.id === "sonnet")
  if (!sonnet) throw new Error("Expected the sonnet model")
  return sonnet.cost
})

// Connects with the given login, as Claude reports it, and returns sonnet's cost once the model list fills
const connectedCost = Effect.fn(function* (input: {
  readonly account: AccountInfo
  readonly prices: ReturnType<typeof listPrice>
  readonly env?: Record<string, string>
  readonly directory?: string
  readonly database?: string
}) {
  const onConnect = FakeClaude.expectStartup({ account: input.account })
  const claude = FakeClaude.make([onConnect])
  const test = yield* TestOpenCode.start({
    io: FakeIO.make({ claude, env: input.env }),
    directory: input.directory,
    database: input.database,
    before: [input.prices],
  })
  yield* TestOpenCode.connect(test.opencode)
  yield* Effect.promise(() => claude.reached(onConnect))
  yield* TestOpenCode.waitUntil(TestOpenCode.models(test.opencode), (ids) => ids.length > 0)
  claude.check()
  return yield* sonnetCost(test.opencode)
})

describe("model costs", () => {
  it.live("shows no cost for a subscription", () =>
    Effect.gen(function* () {
      const cost = yield* connectedCost({
        account: { subscriptionType: "Claude Team", apiProvider: "firstParty" },
        prices: listPrice(Provider.ID.anthropic, "claude-sonnet-5-5"),
      })
      expect(cost).toEqual([])
    }),
  )

  it.live("shows Anthropic's prices for an API key login", () =>
    Effect.gen(function* () {
      const cost = yield* connectedCost({
        account: apiKey,
        prices: listPrice(Provider.ID.anthropic, "claude-sonnet-5-5"),
      })
      expect(cost).toEqual(price)
    }),
  )

  it.live("shows no cost through a custom base URL, which bills in its own way", () =>
    Effect.gen(function* () {
      const cost = yield* connectedCost({
        account: apiKey,
        prices: listPrice(Provider.ID.anthropic, "claude-sonnet-5-5"),
        env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      })
      expect(cost).toEqual([])
    }),
  )

  it.live("shows a cloud account its cloud's prices", () =>
    Effect.gen(function* () {
      const cost = yield* connectedCost({
        account: { apiProvider: "vertex" },
        prices: listPrice(Provider.ID.googleVertex, "claude-sonnet-5-5@default"),
      })
      expect(cost).toEqual(price)
    }),
  )

  it.live("restarts with the saved prices without running claude", () =>
    Effect.gen(function* () {
      const directory = yield* TestOpenCode.tempDirectory
      const database = path.join(directory, "opencode.db")
      const prices = listPrice(Provider.ID.anthropic, "claude-sonnet-5-5")
      yield* connectedCost({ account: apiKey, prices, directory, database }).pipe(Effect.scoped)

      const claude = FakeClaude.make([])
      const test = yield* TestOpenCode.start({ io: FakeIO.make({ claude }), directory, database, before: [prices] })
      expect(yield* sonnetCost(test.opencode)).toEqual(price)
      expect(claude.runs).toHaveLength(0)
    }),
  )
})

// A small copy of opencode's packages/core/test/lib/effect.ts, which opencode doesn't publish.
// `it.effect` runs with TestClock, so time only moves when the test moves it. `it.live` uses the real clock.
import { test } from "bun:test"
import { Cause, Effect, Exit, Layer, type Scope } from "effect"
import { TestClock, TestConsole } from "effect/testing"

const TIMEOUT = 10_000

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

function run<A, E>(value: Body<A, E, Scope.Scope>, layer: Layer.Layer<never>) {
  return Effect.gen(function* () {
    const body = Effect.suspend(() => (typeof value === "function" ? value() : value))
    const exit = yield* body.pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const error of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(error)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)
}

function make(layer: Layer.Layer<never>) {
  const effect = <A, E>(name: string, value: Body<A, E, Scope.Scope>, timeout = TIMEOUT) =>
    test(name, () => run(value, layer), timeout)
  effect.only = <A, E>(name: string, value: Body<A, E, Scope.Scope>, timeout = TIMEOUT) =>
    test.only(name, () => run(value, layer), timeout)
  effect.skip = <A, E>(name: string, value: Body<A, E, Scope.Scope>, timeout = TIMEOUT) =>
    test.skip(name, () => run(value, layer), timeout)
  return effect
}

export const it = {
  effect: make(Layer.mergeAll(TestConsole.layer, TestClock.layer())),
  live: make(TestConsole.layer),
}

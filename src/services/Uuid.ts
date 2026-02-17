import { Context, type Effect } from "effect"

export class Uuid extends Context.Tag("UuidService")<
  Uuid,
  {
    readonly generate: Effect.Effect<string>
    readonly generateShort: Effect.Effect<string>
  }
>() {}

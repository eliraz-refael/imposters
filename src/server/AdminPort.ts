import * as Context from "effect/Context"

// The admin server's port, so an imposter's own pages can link back to the admin UI. Undefined
// where no admin server is known (tests, or an embedding that serves none): the link is left out.
export const AdminPort = Context.Reference<number | undefined>("imposters/AdminPort", { defaultValue: () => undefined })

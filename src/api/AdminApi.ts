import { HttpApi } from "@effect/platform"
import { ImpostersGroup } from "./ImpostersGroup.js"
import { SystemGroup } from "./SystemGroup.js"

export const AdminApi = HttpApi.make("admin")
  .add(ImpostersGroup)
  .add(SystemGroup)

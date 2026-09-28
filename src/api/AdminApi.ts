import { HttpApi } from "effect/unstable/httpapi"
import { ImpostersGroup } from "./ImpostersGroup"
import { SystemGroup } from "./SystemGroup"

export const AdminApi = HttpApi.make("admin")
  .add(ImpostersGroup)
  .add(SystemGroup)

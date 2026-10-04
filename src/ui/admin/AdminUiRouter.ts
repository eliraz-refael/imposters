import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { version } from "../../cli/version.js"
import { PortNumber } from "../../schemas/common.js"
import { DEFAULT_HOST } from "../../server/ServerFactory.js"
import { assetRoute } from "../assets/serve.js"
import { faviconResponse } from "../favicon.js"
import { html, type SafeHtml } from "../html.js"
import { formString } from "../htmx.js"
import { themeFromCookie } from "../theme.js"
import {
  decodeHealth,
  decodeImposterPage,
  decodeInfo,
  type ImposterRow,
  type Overview,
  summarize,
  toRow
} from "./OverviewData.js"
import { type CreateFormState, emptyCreateForm, overviewFragment, overviewPage } from "./pages/Overview.js"

export interface AdminUiDeps {
  readonly apiHandler: (request: Request) => Promise<Response>
  readonly adminPort: number
  // The address the servers bind, shown in the header and the footer
  readonly host?: string
}

const UI_PREFIX = "/_ui"
const PAGE_SIZE = 100
// ui.js sends this with every data-action and data-poll request: answer with a fragment, not a page
const FRAGMENT_HEADER = "x-imposters-fragment"

const decodeCreated = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String, name: Schema.String }))
const decodeApiError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))
const decodePortDigits = Schema.decodeUnknownOption(Schema.String.check(Schema.isPattern(/^\d{1,5}$/)))
const decodePort = Schema.decodeUnknownOption(PortNumber)

const parseJson = (text: string): unknown => {
  try {
    const body: unknown = JSON.parse(text)
    return body
  } catch {
    return undefined
  }
}

const readJson = async (resp: Response): Promise<unknown> => parseJson(await resp.text())

// The message of an admin API error answer, e.g. "Port 3000 is already allocated"
const apiErrorMessage = async (resp: Response): Promise<string> => {
  const text = await resp.text()
  return Option.match(decodeApiError(parseJson(text)), {
    onNone: () => text.trim() || `HTTP ${String(resp.status)}`,
    onSome: (err) => err.message
  })
}

// "Port 3000 is already allocated" → "Port 3000 is already allocated."
const sentence = (text: string): string => /[.!?]$/.test(text) ? text : `${text}.`

// The host the browser reached the admin UI through, so links to an imposter's UI work from
// another machine too (the Node server rewrites request.url to localhost)
const browserHost = (request: Request): string => {
  const header = request.headers.get("host")
  if (header !== null && URL.canParse(`http://${header}`)) return new URL(`http://${header}`).hostname
  return new URL(request.url).hostname
}

const NO_STORE = { "cache-control": "no-store" }

const htmlAnswer = (body: SafeHtml, status = 200): Response =>
  new Response(body.value, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } })

// After a form post without JS: back to the page, as a GET
const seeOther = (location: string): Response => new Response(null, { status: 303, headers: { location, ...NO_STORE } })

// A failed action: the plain-English message and the status it is sent with. `form` is the
// create form to show again (with what was typed) when JS is off.
interface Failure {
  readonly message: string
  readonly status: number
  readonly form?: CreateFormState
  // The change was made (the imposter exists) but did not finish (it could not start): with JS,
  // answer like a success, so the live region shows it and the form resets, with the message
  readonly madeChange?: boolean
}

const failed = (message: string, status: number, form?: CreateFormState): Failure =>
  form === undefined ? { message, status } : { message, status, form }

const isFailure = (value: Failure | null): value is Failure => value !== null

type Action = "start" | "stop" | "delete"

const ACTION_PATH = /^\/imposters\/([^/]+)\/(start|stop|delete)$/

const actionOf = (verb: string | undefined): Action | null =>
  verb === "start" || verb === "stop" || verb === "delete" ? verb : null

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

const NOT_FOUND = "That imposter no longer exists; it may have been deleted elsewhere."

// A form post is a "simple" request, so a page on another site could send one to a loopback
// admin server without a CORS preflight. Browsers mark such a request `Sec-Fetch-Site:
// cross-site`; refuse it. (An imposter's own /_admin, on another port of the same host, is
// same-site.) Browsers send Sec-Fetch-Site only to a trustworthy origin (https or loopback), so
// an admin server bound to a LAN address over http gets none: there, an Origin whose host is
// not the one the request was sent to (or an opaque "null" one) is refused too. `same-site` gets
// the same Origin check, since it also covers a sibling subdomain (blog.corp.example posting to
// imposters.corp.example). Tools that send neither header are unaffected.
const isCrossSite = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site")
  if (site === "cross-site") return true
  if (site !== null && site !== "same-site") return false
  const origin = request.headers.get("origin")
  if (origin === null) return false
  if (!URL.canParse(origin)) return true
  return new URL(origin).hostname !== browserHost(request)
}

export const makeAdminUiRouter = (deps: AdminUiDeps) => {
  const bindHost = deps.host ?? DEFAULT_HOST

  const api = (path: string, init?: RequestInit): Promise<Response> =>
    deps.apiHandler(new Request(`http://localhost${path}`, init))

  const sendJson = (method: string, path: string, body: unknown): Promise<Response> =>
    api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  // Every page of the list, with statistics: the overview shows all imposters, not the first page
  const fetchRows = async (host: string, offset = 0): Promise<ReadonlyArray<ImposterRow>> => {
    const resp = await api(`/imposters?limit=${String(PAGE_SIZE)}&offset=${String(offset)}&stats=true`)
    if (!resp.ok) return []
    const page = decodeImposterPage(await readJson(resp))
    if (Option.isNone(page)) return []
    const here = page.value.imposters.map((imp) => toRow(imp, host))
    if (!page.value.pagination.hasMore || here.length === 0) return here
    return [...here, ...await fetchRows(host, offset + PAGE_SIZE)]
  }

  const fetchDecoded = async <A>(
    path: string,
    decode: (input: unknown) => Option.Option<A>
  ): Promise<Option.Option<A>> => {
    const resp = await api(path)
    return resp.ok ? decode(await readJson(resp)) : Option.none()
  }

  const loadOverview = async (host: string): Promise<Overview> => {
    const [imposters, health, info] = await Promise.all([
      fetchRows(host),
      fetchDecoded("/health", decodeHealth),
      fetchDecoded("/info", decodeInfo)
    ])
    return {
      imposters,
      summary: summarize(imposters),
      health: Option.map(health, (h) => ({ nowMs: DateTime.toEpochMillis(h.timestamp), uptime: h.uptime })),
      protocols: Option.match(info, { onNone: () => ["HTTP"], onSome: (i) => i.server.protocols }),
      portRange: Option.map(info, (i) => i.configuration.portRange),
      bindHost,
      adminPort: deps.adminPort,
      version
    }
  }

  // ---------------------------------------------------------------- create

  const createFormState = (form: FormData): CreateFormState => ({
    name: formString(form, "name")?.trim() ?? "",
    port: formString(form, "port")?.trim() ?? "",
    protocol: formString(form, "protocol")?.trim() || "HTTP",
    start: formString(form, "start") === "on"
  })

  // The form's fields, checked before anything is created; null when they are fine
  const validate = (state: CreateFormState, protocols: ReadonlyArray<string>): Failure | null => {
    if (state.port !== "") {
      const digits = decodePortDigits(state.port)
      if (Option.isNone(digits) || Option.isNone(decodePort(Number(digits.value)))) {
        return failed(
          `The port must be a whole number from 1024 to 65535, like 3000. Leave it blank to pick a free one.`,
          400,
          state
        )
      }
    }
    if (!protocols.includes(state.protocol)) {
      return failed(
        `There is no "${state.protocol}" protocol here. Choose one of: ${protocols.join(", ")}.`,
        400,
        state
      )
    }
    return null
  }

  const create = async (request: Request): Promise<Failure | null> => {
    const form = await request.formData().catch(() => null)
    if (form === null) return failed("Expected a form submission.", 400, emptyCreateForm)
    const state = createFormState(form)

    const protocols = Option.match(await fetchDecoded("/info", decodeInfo), {
      onNone: () => [state.protocol],
      onSome: (info) => info.server.protocols
    })
    const invalid = validate(state, protocols)
    if (isFailure(invalid)) return invalid

    const createResp = await sendJson("POST", "/imposters", {
      ...(state.name !== "" ? { name: state.name } : {}),
      ...(state.port !== "" ? { port: Number(state.port) } : {}),
      protocol: state.protocol
    })
    if (!createResp.ok) {
      const reason = await apiErrorMessage(createResp)
      return failed(`Could not create the imposter: ${sentence(reason)}`, createResp.status, state)
    }

    const created = decodeCreated(await readJson(createResp))
    if (state.start && Option.isSome(created)) {
      const startResp = await sendJson("PATCH", `/imposters/${encodeURIComponent(created.value.id)}`, {
        status: "running"
      })
      if (!startResp.ok) {
        const reason = await apiErrorMessage(startResp)
        // It exists now, so the form starts over rather than offering to create it again
        return {
          ...failed(
            `Created ${created.value.name}, but it could not start: ${sentence(reason)}`,
            startResp.status,
            emptyCreateForm
          ),
          madeChange: true
        }
      }
    }
    return null
  }

  // ---------------------------------------------------------------- start, stop, delete

  // Start and stop resolve once the port is bound or released, so the overview read after is current
  const act = async (id: string, action: Action): Promise<Failure | null> => {
    const path = `/imposters/${encodeURIComponent(id)}`
    const resp = action === "delete"
      ? await api(`${path}?force=true`, { method: "DELETE" })
      : await sendJson("PATCH", path, { status: action === "start" ? "running" : "stopped" })
    if (resp.ok) return null
    if (resp.status === 404) return failed(NOT_FOUND, 404)
    return failed(`Could not ${action} the imposter: ${sentence(await apiErrorMessage(resp))}`, resp.status)
  }

  // ---------------------------------------------------------------- answers

  const page = async (request: Request, opts?: { readonly failure?: Failure }): Promise<Response> => {
    const failure = opts?.failure
    const data = await loadOverview(browserHost(request))
    const theme = themeFromCookie(request.headers.get("cookie"))
    const form = failure?.form === undefined
      ? { ...emptyCreateForm, protocol: data.protocols[0] ?? "HTTP" }
      : { ...failure.form, error: failure.message }
    const error = failure !== undefined && failure.form === undefined ? failure.message : undefined
    return htmlAnswer(
      overviewPage(data, { theme, form, ...(error !== undefined ? { error } : {}) }),
      failure?.status ?? 200
    )
  }

  // With JS: the refreshed live region, or the message for the error slot (with the live region
  // too when the change was made). Without: back to the page after a success (303), or the page
  // again with the message, at the failure's status.
  const answer = async (request: Request, failure: Failure | null): Promise<Response> => {
    if (request.headers.get(FRAGMENT_HEADER) === "1") {
      if (isFailure(failure) && failure.madeChange !== true) {
        return htmlAnswer(html`${failure.message}`, failure.status)
      }
      const data = await loadOverview(browserHost(request))
      return htmlAnswer(overviewFragment(data, isFailure(failure) ? { formError: failure.message } : undefined))
    }
    if (isFailure(failure)) return page(request, { failure })
    return seeOther(UI_PREFIX)
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname !== UI_PREFIX && !url.pathname.startsWith(`${UI_PREFIX}/`)) return null

    const path = url.pathname.slice(UI_PREFIX.length) || "/"
    const method = request.method.toUpperCase()

    const asset = assetRoute(request, path)
    if (asset !== null) return asset

    if (method === "GET" && path === "/favicon.svg") return faviconResponse()

    if (method === "GET" && path === "/") return page(request)

    if (method === "GET" && path === "/fragments/overview") {
      return htmlAnswer(overviewFragment(await loadOverview(browserHost(request))))
    }

    if (method === "POST" && isCrossSite(request)) {
      return new Response("Cross-site form posts are refused.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE }
      })
    }

    if (method === "POST" && path === "/imposters") return answer(request, await create(request))

    const match = ACTION_PATH.exec(path)
    const action = actionOf(match?.[2])
    const id = match?.[1] === undefined ? null : decodeSegment(match[1])
    if (method === "POST" && action !== null && id !== null) return answer(request, await act(id, action))

    return null
  }
}

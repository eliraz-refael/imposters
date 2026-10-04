// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The browser runtime (ui-assets/ui.ts) on the /_ui overview's markup: one-button forms and the
// create form, all with data-action, and two error slots (the page's and the form's own).

interface Sent {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string
}

const sent: Array<Sent> = []
let answer: () => Response = () => new Response("")

const fakeFetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
  const body = init?.body
  sent.push({
    method: init?.method ?? "GET",
    url: String(input),
    headers: new Headers(init?.headers),
    body: body instanceof URLSearchParams ? body.toString() : ""
  })
  return answer()
}

const page = `
<p id="overview-headline">// 1 of 1 running</p>
<div class="alert" id="page-error" data-error-slot></div>
<div id="overview"><span id="marker">old</span>
  <form id="stop" class="inline-form" method="post" action="/_ui/imposters/a/stop" data-action data-target="#overview"><button id="stop-button" type="submit">stop</button></form>
  <form id="delete" class="inline-form" method="post" action="/_ui/imposters/a/delete" data-action data-target="#overview" data-confirm="Delete a?"><button id="delete-button" type="submit">x</button></form>
</div>
<form id="create" method="post" action="/_ui/imposters" data-action data-target="#overview" data-reset>
  <input id="name" name="name" value="">
  <select name="protocol"><option value="HTTP" selected>HTTP</option><option value="S3">S3</option></select>
  <input type="checkbox" name="start" checked>
  <button id="create-button" type="submit">create</button>
  <div class="alert" id="form-error" data-error-slot></div>
</form>`

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`no #${id}`)
  return el
}

const submit = (formId: string, buttonId: string): void => {
  const form = byId(formId)
  if (!(form instanceof HTMLFormElement)) throw new Error(`#${formId} is not a form`)
  form.requestSubmit(byId(buttonId))
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch)
  document.body.innerHTML = page
  await import("../../ui-assets/ui")
})

beforeEach(() => {
  document.body.innerHTML = page
  sent.length = 0
})

describe("ui.ts actions on the overview", () => {
  it("a one-button form posts to its action as a fragment request and swaps the answer in, with out-of-band parts", async () => {
    answer = () => new Response(`<span id="marker">new</span><p id="overview-headline" data-oob>// 0 of 1 running</p>`)
    submit("stop", "stop-button")
    await vi.waitFor(() => expect(byId("marker").textContent).toBe("new"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe("POST")
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/_ui/imposters/a/stop")
    expect(sent[0]?.headers.get("x-imposters-fragment")).toBe("1")
    expect(byId("overview-headline").textContent).toBe("// 0 of 1 running")
  })

  it("delete asks first: declined sends nothing, accepted posts", async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal("confirm", confirm)
    submit("delete", "delete-button")
    expect(confirm).toHaveBeenCalledWith("Delete a?")
    await Promise.resolve()
    expect(sent).toHaveLength(0)

    vi.stubGlobal("confirm", () => true)
    answer = () => new Response(`<span id="marker">deleted</span>`)
    submit("delete", "delete-button")
    await vi.waitFor(() => expect(byId("marker").textContent).toBe("deleted"))
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/_ui/imposters/a/delete")
  })

  it("the create form posts its fields, and resets after a success", async () => {
    answer = () => new Response(`<span id="marker">created</span>`)
    const name = byId("name")
    if (!(name instanceof HTMLInputElement)) throw new Error("no name input")
    name.value = "orders-api"
    submit("create", "create-button")
    await vi.waitFor(() => expect(byId("marker").textContent).toBe("created"))
    const fields = new URLSearchParams(sent[0]?.body)
    expect(fields.get("name")).toBe("orders-api")
    expect(fields.get("protocol")).toBe("HTTP")
    expect(fields.get("start")).toBe("on")
    expect(name.value).toBe("")
  })

  it("a failed create shows its message in the form's own slot, keeps what was typed, and changes nothing else", async () => {
    answer = () => new Response("The port must be a whole number from 1024 to 65535, like 3000.", { status: 400 })
    const name = byId("name")
    if (!(name instanceof HTMLInputElement)) throw new Error("no name input")
    name.value = "typed"
    submit("create", "create-button")
    await vi.waitFor(() => expect(byId("form-error").textContent).toContain("The port must be a whole number"))
    expect(byId("page-error").textContent).toBe("")
    expect(byId("marker").textContent).toBe("old")
    expect(name.value).toBe("typed")
  })

  it("a failed row action shows in the page's slot, and the next action clears every slot", async () => {
    byId("form-error").textContent = "stale"
    answer = () => new Response("That imposter no longer exists.", { status: 404 })
    submit("stop", "stop-button")
    await vi.waitFor(() => expect(byId("page-error").textContent).toBe("That imposter no longer exists."))
    expect(byId("form-error").textContent).toBe("")

    answer = () => new Response(`<span id="marker">ok</span>`)
    submit("stop", "stop-button")
    await vi.waitFor(() => expect(byId("marker").textContent).toBe("ok"))
    expect(byId("page-error").textContent).toBe("")
  })

  it("a network failure says the server could not be reached", async () => {
    answer = () => {
      throw new TypeError("fetch failed")
    }
    submit("stop", "stop-button")
    await vi.waitFor(() => expect(byId("page-error").textContent).toBe("Could not reach the server."))
  })
})

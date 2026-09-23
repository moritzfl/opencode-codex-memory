import { afterEach, expect, it } from "bun:test"
import { OpenCode } from "@opencode/client"
import { buildV1ClientShim } from "../src/v2/shim.js"
import { fetchServiceStatus, serviceHeaders, setV2ServiceDependenciesForTest, type V2ServiceClient } from "../src/v2/service.js"

afterEach(() => setV2ServiceDependenciesForTest(null))

it("recovers real public-client discovery after local service restart and credential rotation", async () => {
  let password = "first"
  const handler = (req: Request) => {
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    if (req.headers.get("authorization") !== expected) return Response.json({ type: "UnauthorizedError", message: "Unauthorized" }, { status: 401 })
    const pathname = new URL(req.url).pathname
    if (pathname === "/api/info") return Response.json({ version: "2.0.12", pid: process.pid })
    if (pathname === "/api/session") return Response.json({ data: [{ id: "ses_live", parentID: null, time: { updated: 1 } }] })
    return new Response(null, { status: 404 })
  }
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  let active = first
  let discoveries = 0
  const endpoint = () => ({ url: `http://127.0.0.1:${active.port}`, auth: { type: "basic" as const, username: "opencode", password } })
  setV2ServiceDependenciesForTest({
    service: { discover: async () => { discoveries++; return endpoint() }, headers: serviceHeaders },
    make: (options) => OpenCode.make(options) as unknown as V2ServiceClient,
    probe: (ep, signal) => fetchServiceStatus(ep, serviceHeaders(ep), signal),
  })
  try {
    const client = buildV1ClientShim() as any
    const list = () => client._client.get({ url: "/experimental/session" })
    expect((await list()).data[0].id).toBe("ses_live")
    // Bind replacement before closing the first listener, ensuring a new port.
    active = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
    await first.stop(true)
    await expect(list()).rejects.toThrow()
    expect((await list()).data[0].id).toBe("ses_live")
    password = "rotated"
    await expect(list()).rejects.toMatchObject({ type: "UnauthorizedError" })
    expect((await list()).data[0].id).toBe("ses_live")
    expect(discoveries).toBe(3)
  } finally {
    await first.stop(true)
    await active.stop(true)
  }
})

it.each(["/api/info", "/api/status", "/api/health"])("discovers hosts exposing readiness at %s", async (route) => {
  const requested: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const pathname = new URL(req.url).pathname
    requested.push(pathname)
    return pathname === route
      ? Response.json({ version: "2.0.12", pid: process.pid })
      : new Response(null, { status: 404 })
  } })
  try {
    expect(await fetchServiceStatus({ url: server.url.href }, undefined)).toEqual({ version: "2.0.12", pid: process.pid })
    const routes = ["/api/info", "/api/status", "/api/health"]
    expect(requested).toEqual(routes.slice(0, routes.indexOf(route) + 1))
  } finally {
    await server.stop(true)
  }
})

it.each([401, 503])("rejects HTTP %i even when the response body looks ready", async (status) => {
  const requested: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    requested.push(new URL(req.url).pathname)
    return Response.json({ version: "2.0.12", pid: process.pid }, { status })
  } })
  try {
    await expect(fetchServiceStatus({ url: server.url.href }, undefined)).rejects.toThrow(`GET /api/info ${status}`)
    expect(requested).toEqual(["/api/info"])
  } finally {
    await server.stop(true)
  }
})

it("treats IPv6 loopback endpoints as local", () => {
  const { isLoopbackEndpointUrl } = require("../src/v2/service.js")
  expect(isLoopbackEndpointUrl("http://[::1]:4096")).toBe(true)
  expect(isLoopbackEndpointUrl("http://127.0.0.1:4096")).toBe(true)
  expect(isLoopbackEndpointUrl("http://10.0.0.2:4096")).toBe(false)
})

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
    if (new URL(req.url).pathname === "/api/status") return Response.json({ version: "2.0.12", pid: process.pid })
    return Response.json({ data: [{ id: "ses_live", parentID: null, time: { updated: 1 } }] })
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

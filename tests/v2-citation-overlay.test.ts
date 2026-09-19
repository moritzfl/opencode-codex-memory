import { describe, it, expect } from "bun:test"
import { overlayV2CitationInstructions } from "../src/v2/citation-overlay.js"

const V1 = `intro

Memory citation requirements:

- Use XML
<memory-citation>
<citation_entries>
MEMORY.md:1-2|note=[x]
</citation_entries>
<session_ids>
ses_abc123
</session_ids>
</memory-citation>

Updating memories:

keep this
`

describe("overlayV2CitationInstructions", () => {
  it("replaces the V1 XML citation section with the fenced V2 form", () => {
    const out = overlayV2CitationInstructions(V1)
    expect(out).toContain("```memory-citation")
    expect(out).toContain("blank line")
    expect(out).toContain("own line at column 0")
    expect(out).toContain("answer text ends here.\n\n```memory-citation")
    expect(out).toContain("Updating memories:")
    expect(out).toContain("keep this")
    expect(out).not.toContain("<citation_entries>")
  })
})

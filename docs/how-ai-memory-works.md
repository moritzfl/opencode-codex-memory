# How AI Memory Works: Learning, Remembering, and Forgetting

A practical tour of the architecture behind an AI agent that remembers — using
a real, working system as the running example.

## Introduction

Every conversation with a large language model starts from zero. The model has
no idea who you are, what you built last week, or that you already told three
previous sessions *"yes, tests must pass before you commit."* That blank-slate
freshness is fine for a one-off question. It is miserable for a tool you use
every day, where half the value is in not having to repeat yourself.

This writeup explains how a persistent memory system for an AI agent closes
that gap. The running example is a concrete, working implementation: the
memory plugin this repository builds (itself a faithful port of the memory
system inside OpenAI's Codex). You do not need to know TypeScript, JavaScript,
or anything about the specific tooling. The architecture is the interesting
part, and it is expressed here in plain concepts: which components exist, what
data flows between them, which decisions are made where, and why.

Three principles organize everything that follows:

- **Learning**: turning finished conversations into durable knowledge, in the
  background, without slowing anyone down.
- **Remembering**: surfacing the right knowledge at the right moment, at a
  cost small enough to pay on every single turn.
- **Forgetting**: deliberately discarding what stopped being useful, because
  memory that only grows is memory that stops working.

The central design tension is this. A model's context window is the most
expensive resource in the system: every token you put in front of the model is
paid for in latency and money, on every turn, forever. Raw history is huge and
mostly noise. Memory that actually works is therefore not an accumulation
problem; it is a *compression* problem. You distill far more than you keep,
you keep far less than you saw, and you show the model only the thinnest
useful slice by default, with a well-marked path to the rest.

A second principle sits underneath all of it: **memory should be plain files
and an ordinary embedded database on the user's own machine.** Readable,
greppable, editable, deletable. That choice is not just a privacy feature — it
shapes the whole pipeline, because files you can diff are files you can reason
about.

## The Big Picture: A Layered Store and Three Jobs

The system is easiest to understand as two pieces: a set of storage layers
with very different cost and detail levels, and three loosely coupled jobs
that move knowledge between them.

### The memory pyramid

Picture a pyramid, cheapest and least detailed at the top, richest and most
expensive at the bottom:

![The memory pyramid: five storage layers from cheap and small (injected
summary, always in context) to rich and expensive (full transcripts, immutable
raw evidence).](memory-pyramid.jpeg)

- **The injected summary** is the only layer the model pays for on every
  turn. It is deliberately tiny — capped at roughly 2,500 tokens (estimated;
  the cap matters more than the exact number).
- **The handbook** is a single structured document that indexes everything
  worth keeping, grouped by task family, with searchable keywords. The model
  opens it when the summary hints that relevant knowledge exists.
- **Skills** are reusable procedures: things the agent learned to do that are
  worth repeating step by step.
- **Session recaps** are one-per-conversation detailed notes — the reference
  layer you open when you need the full story of *that one time we debugged
  the deploy*.
- **Full transcripts** belong to the host application, not the memory system.
  They are read-only evidence for the learning pipeline and are never edited.

This shape is called **progressive disclosure**: the model always carries the
cheap overview, and descends into more expensive, more detailed layers only
when the overview suggests it. It mirrors how you would use your own notes —
you don't reread every lab notebook every morning; you keep a rough mental map
of what exists and pull the specific page when you need it.

### Three jobs

Around this store, three jobs run, fully decoupled:

```
conversation ends ──► [Phase 1: extraction] ──► per-session records
                                                     │ (hours later)
                                                     ▼
                              [Phase 2: consolidation] ──► rewrites handbook,
                                                           summary, skills

every turn ──► [Read path] ──► inject summary, offer search tools,
                               record citations back into the store
```

1. **Phase 1 — extraction.** After a conversation is finished, one cheap
   model reads the whole transcript and answers one question: *what here is
   worth keeping?* One session in, one structured record out.
2. **Phase 2 — consolidation.** Every few hours, a second, more capable model
   merges many session records into the shared memory files, resolves
   contradictions, and prunes what went stale.
3. **Read path.** On every turn, the small summary is appended to the model's
   system prompt, and the model gets tools to search deeper layers itself.

Nothing learns while the user is waiting for a reply. An assistant that stops
to take notes mid-answer would be slower and more expensive, so all learning
is retrospective, over conversations that are already over. The split between
Phase 1 and Phase 2 exists because the two halves have opposite needs:
extraction is per-session and can run many times in parallel, safely and
independently; consolidation touches the single shared store and must be
strictly serialized. Keeping them apart means one slow or failing extraction
can never corrupt or block the global memory.

## Learning Part 1: Extracting Signal from One Session

Learning starts long after the conversation ended. The trigger is *idleness*:
once a session has been quiet for a configurable time (six hours by default),
it is treated as done.

### What counts as a learnable session

Not every session qualifies. There is an age window — sessions older than a
cutoff (by default ten days) are skipped entirely, on the grounds that very
old transcripts are rarely worth learning from retroactively. Sessions in
which the user explicitly disabled memory, or which were marked as polluted by
external, untrusted content, are excluded too. Discovery of candidate sessions
happens through the host application's own API — the memory system never
opens the host's database files directly, because ownership boundaries matter:
the host owns its data, the memory system owns only its own.

### Sanitizing the evidence

Before any transcript is shown to a learning model, it passes through a
filtering and redaction step:

- Instructions and system-level scaffolding are stripped; what remains is the
  substance of the conversation.
- Secrets — API keys, tokens, passwords, private keys — are replaced with
  redaction markers, both in what is stored and in what is sent to the model.
  Learning should improve the agent, never create a second copy of your
  credentials.
- The transcript is marked clearly as **data, not instructions**: a poisoned
  conversation must not be able to order the learning model around. This is
  enforced structurally, not politely — the extraction model runs in a
  configuration with no tools at all. It cannot read files, cannot run
  commands, cannot touch the network; the transcript arrives inline in its
  input and the only thing it can emit is a structured result. Even a wholly
  malicious transcript hits a wall with no doors.

### The minimum-signal gate

The single most important instruction in the whole extraction step is that
**doing nothing is a first-class outcome**. Before writing anything, the
extractor asks: *will a future agent plausibly act better because of what I
write here?* If the session was a one-off question, a generic status update,
or small talk, the correct output is an empty record — not a polite summary.
Memory that accumulates filler teaches itself that filler is normal, and every
downstream layer gets noisier. The gate is what keeps the bottom of the
pyramid trustworthy.

### What to keep: evidence over abstraction

When something *is* worth keeping, the extractor follows a strict evidence
hierarchy. User messages outrank tool outputs, which outrank the assistant's
own words. The reason is subtle but important: an assistant's summary of what
happened is a claim; a user's correction is a fact. The highest-value signals
are:

1. **Stable user preferences** — things the user repeatedly asks for,
   corrects, or interrupts to enforce. If the user had to spend keystrokes on
   something a better agent could have anticipated, that's a durable default
   worth recording, preserved in near-verbatim wording: *when X, the user
   said "…" → so future sessions should do Y by default.*
2. **High-leverage procedural knowledge** — hard-won shortcuts, exact
   commands, failure shields (symptom → cause → fix), repo facts that took
   real exploration to discover.
3. **Task maps and decision triggers** — where the truth lives in a project,
   and what signal should cause a pivot.
4. **Durable environment facts** — stable tooling habits and conventions.

Equally important is what is *not* memory: generic advice, one-off impressions,
exploratory brainstorming, and assistant proposals that were never adopted.
Each task in the session is also classified by outcome — success, partial,
failure, or uncertain — inferred from explicit user feedback and verification
evidence rather than from the assistant's optimism. A failed task emphasizes
what went wrong and how to avoid repeating it; a successful one preserves the
reproduction path.

### The two outputs of extraction

Each qualifying session produces two artifacts with different jobs:

- **A raw memory**: a compact, frontmatter-tagged record — task, task group,
  outcome, working directory, search keywords — followed by task-grouped
  preference signals, reusable knowledge, and failure shields. This is the
  routing layer for consolidation later.
- **A rollout summary**: a much more permissive, detailed recap of the whole
  session, preserving evidence and epistemic status (*the user said X* vs.
  *the assistant proposed Y* vs. *this was verified*). This becomes one of the
  per-session files in the reference layer.

Both land in the memory system's own embedded database, keyed by session.
Because sessions are independent, extraction is trivially parallelizable and
retrievable: if the model provider is out of quota, the job backs off and
tries again later; failure in one session never affects another.

## Learning Part 2: Consolidating Many Sessions into One Memory

Extraction produces many small, isolated records. Consolidation turns them
into *a memory*. This is where the real intelligence of the system lives, and
it is deliberately given to a more capable model than extraction — cheap model
for the per-session pass, stronger model for the global synthesis.

### Scheduling: rarely, and only one at a time

Consolidation runs at most every few hours, guarded by a persistent lease so
that even with several application windows open, exactly one consolidation is
ever in flight. Serializing matters: the shared memory files are a single
writer's medium. Two concurrent consolidators would interleave edits and
corrupt the very structure they are supposed to maintain.

### The change signal: a diff against the last good state

Here is the elegant part. The entire memory workspace is a private version
control repository. After every successful consolidation, the system commits
a baseline snapshot of all memory files. At the start of the next run, it
computes the diff from that baseline to the current state of the files — and
that diff *is* the consolidation input:

- **Added or modified records and recaps** are the ingestion queue: new
  sessions to integrate.
- **Deleted files** are the forgetting queue: if a session recap disappeared
  (pruned, or removed by an external import channel that stopped syncing), any
  memory that rests solely on that evidence must be surgically removed or
  rewritten. Deletion propagates.
- **Hand-edited files** show up as modifications too. Because memory is plain
  text, a user can just edit it — and a change that appears in the diff
  without any machine provenance is probably a deliberate human edit, which
  the consolidator is instructed to honor and integrate, not revert.

Using a diff as the change feed buys three things at once: incremental updates
(you don't reprocess history), an audit trail (every state the memory has ever
been in is recoverable), and a uniform forgetting channel (any removal from
any source — pruning, user deletion, import withdrawal — arrives in the same
format).

### What the consolidator actually does

The consolidation model is given the diff, the merged raw records, existing
memory files, and a long, strict set of instructions. Its task has two modes:
**init** (build everything from scratch when memory is empty) and
**incremental update** (the normal case). In both modes the work is the same
in kind:

- **Cluster** related records into task families — bounded by working
  directory, workflow, and intent, never by keyword overlap alone. When in
  doubt, keep boundaries. Over-clustered memory is memory that leaks context
  between unrelated projects.
- **Merge duplicates**: ten similar observations collapse into one rule.
  Conflicting evidence is resolved in favor of fresher, better-validated
  sources — and when the truth is genuinely unclear, the uncertainty is
  recorded explicitly instead of being flattened into a false fact.
- **Preserve wording**. This is a deep principle of the system: memory exists
  to be *searched later*, and you can only find phrasing that was actually
  kept. Concrete error strings, exact commands, and the user's own words are
  retrieval handles; abstract paraphrase destroys them. The consolidator is
  told to keep original phrasing and only smooth enough to merge duplicates.
- **Rank by utility and recency**: the most useful, most recently confirmed
  knowledge rises to the top of the handbook and the summary.
- A **no-op is allowed**: if nothing new is worth writing, the correct result
  is unchanged files.

Like the extractor, the consolidator itself runs sandboxed: file tools only,
scoped to the memory folder — no shell, no network, no way to touch the
user's projects. The safety boundary is what the agent can *do*, and it can
only rewrite the memory itself.

### The artifacts it maintains

Consolidation rewrites three kinds of artifacts:

1. **The handbook (`MEMORY.md`)** — the durable middle layer. Organized into
   task-group blocks with scope headers, each block listing the sessions that
   support it and the keywords under which it should be found, followed by
   consolidated user preferences, reusable knowledge, and failure shields.
   Provenance is mandatory: every claim traces back to session recaps, so the
   "delete only what lost its evidence" rule is enforceable.
2. **Skills** — when a procedure has repeated itself (a workflow, a fix with
   verification steps, an exacting format), it graduates into a reusable
   package: trigger conditions, inputs, numbered procedure, pitfalls,
   verification checklist. One-off trivia never becomes a skill.
3. **The injected summary** — rebuilt last, always, from the final state of
   the other artifacts. A version marker on its first line guards the schema:
   if the marker is missing or wrong, the summary is regenerated wholesale
   rather than patched, so a format change never strands stale structure.
   Inside, it carries a short user profile, the highest-leverage preferences,
   general tips, and a routing index — organized by project scope and recency
   — that tells future sessions *what to search for*, not the answers
   themselves.

Note what the summary is *not*: not the full memory, not an executive digest
in flowery abstraction, and not static. It is a dense signpost layer whose job
is to help the model decide, within the size cap, when deeper layers are worth
opening.

## Remembering: The Read Path

All the learning above is wasted if recall is slow, expensive, or intrusive.
The read path is designed around a hard constraint: it executes **on every
turn of every conversation**, so its baseline cost must be tiny and — just as
important — *stable*.

### Always-on: the injected summary

Every turn, the small summary document is appended verbatim to the model's
system prompt. Two properties make this affordable:

- **A hard size cap.** The injection is truncated to a fixed, small token
  budget. Cost per turn is therefore predictable regardless of how much the
  system knows; growth is absorbed by re-ranking the summary, never by
  enlarging the injection.
- **Byte-identical stability.** Every prefix of a model request that stays
  identical can be served from the provider's prompt cache instead of being
  reprocessed. By appending the *same* string every turn — rather than, say,
  a freshly rendered summary with timestamps — the memory block becomes its
  own cacheable segment. An update to memory invalidates just that segment and
  leaves the host application's base prompt cache untouched. The
  implementation even watches the file's modification time and re-reads only
  on change, so the steady-state read path is nearly free.

Along with the summary text, the injected block teaches the model the *policy*
of remembering: when to skip memory entirely (trivial, self-contained
questions), when to do a quick lookup, and a strict budget — a handful of
search steps, not an archaeological expedition. It also encodes epistemic
hygiene: a memory-derived fact that may have drifted should be flagged as such
or verified when verification is cheap, and never presented as confirmed
current knowledge.

### On-demand: searching deeper layers

The summary is a map, not the territory. When a task looks related to past
work, the model descends into deeper layers itself, through a small set of
dedicated tools: read a memory file, search the memory folder by keywords,
list its contents, and append an explicit note. The layout it navigates is
exactly the pyramid from earlier: summary → handbook → recaps and skills.

This is the retrieval-augmentation pattern in its most literal form, with a
deliberate twist: **the store is plain text and the search is keywords**. No
embeddings, no vector database, no similarity indexes. The bet the design
makes is twofold. First, the consolidation layer works hard to keep wording
source-faithful — full of distinctive nouns, exact commands, and error
strings — precisely so that plain text search works. Second, the model
searching is itself intelligent: it reformulates queries, follows pointers
from summary to handbook to recap, and reads structure a grep never could.
Structured distillation plus an intelligent searcher replaces the retrieval
machinery other systems build out of embedding infrastructure — and the whole
thing stays local, inspectable, and dependency-free.

### Writing from the read path

There is one deliberate write door during conversations: the user can say
outright *"remember that …"*, and the agent appends the note as a small file
that the next consolidation picks up through the normal diff channel. The
authority to *integrate* knowledge stays with the consolidator; the
read path's writes are suggestions, not edits. This keeps the shared store
single-writer while still letting users pin facts in real time.

## Forgetting: Entropy as a Feature

An AI memory that only grows degrades quietly: the summary fills with stale
ranking, the handbook with dead projects, the database with notes nobody will
ever read. This system treats forgetting as a first-class, multi-channel
process.

### Age-based pruning of unused extractions

Every extracted session record carries two pieces of bookkeeping that would be
surprising if you hadn't seen the retrieval loop: a **usage count** and a
**last-used timestamp**. Periodically, records that have sat untouched beyond
a configurable horizon — thirty days by default — are pruned. Note the
criterion: not just *old*, but *unproven*. A six-month-old extraction the
agent still cites survives; a one-week-old note nobody needed does not.

### Usage-based ranking in selection

When consolidation selects which extractions to feed into the next pass, it
does not simply take the newest — it ranks by demonstrated usefulness and
recency combined. The same signal shapes the ordering of the handbook and the
summary: knowledge that keeps being used floats; knowledge that doesn't,
sinks. The system quite literally finds out which of its own notes were worth
writing, and its retrieval surface reshapes itself accordingly.

### Deletion propagation through provenance

Because every entry in the handbook is required to cite the session recaps
that support it, forgetting can be *surgical* rather than global. When a
source file disappears — pruned as stale, deleted by the user, withdrawn by an
external import channel — the diff surfaces the deletion, and the
consolidation instructions are explicit: delete only the memory supported by
deleted inputs; if an entry rests on mixed evidence, excise the orphaned part
and keep the rest; then revisit the summary and remove what only the deleted
material supported. Nothing is mass-deleted because nothing is ever
unattributed.

### Hand-delivered forgetting

Because the store is plain files, the user can forget things the brute-force
way: edit or delete a file. The diff channel picks the change up and the next
consolidation honors it. And there is a guarded total-reset operation that
wipes memory entirely — guarded, because a system that lets you accumulate
everything must also let you start over on purpose, safely.

### A worked example

Imagine thirty sessions extracted over a month. Five taught the system that
you want tests run before any commit; those merge into one sharp handbook rule
and a line in the summary. Twelve were one-off questions — mostly no-ops at
extraction, pruned within weeks. A handful of extractions about a project you
archived were never once cited; at the thirty-day mark they vanish from the
input set, the diff shows their recaps deleted, and the consolidator strips
their residue from the handbook before it can mislead a future session. The
summary stays within budget not because someone curates it, but because the
system continuously re-ranks and discards. The memory *improves* with time
instead of merely filling up.

## The Feedback Loop: Citations Close the Circuit

The design has one loose end: usage counts come from somewhere, and that
somewhere is an unusual piece of machinery. The model is instructed —
in the injected read-path guidance — to end any answer that drew on memory
with a small, structured citation block naming which memory files and lines
it used.

The host never shows the user this block. A hook in the application catches
the model's text before it is persisted or rendered, parses the citation,
updates the usage counters in the database, and strips the markup — so neither
history nor UI is polluted with bookkeeping. Fallback cleanup paths handle
older data that might still carry the markers.

This is the system's answer to a question most memory designs never ask: *how
do you know your memories are any good?* Counting what the agent actually used
turns memory quality from vibes into data. Usage feeds the ranking at
selection time, the ordering in the handbook, and the survival decision at
pruning time. The citation also builds a habit of attribution into the
assistant: when it says "I remember you prefer X," the system knows *where* it
remembered that from.

## Safety, Privacy, and Trust

A writing system inside an AI agent needs boundaries that fail closed, and
this one stacks several:

- **Local-only storage.** There is no remote memory service to enable, by
  accident or otherwise. Everything lives under the host's data directory. The
  only thing that ever leaves the machine is the traffic the model provider
  already sees — and even that passes through redaction first.
- **Secrets are scrubbed** from transcripts and extracted notes before they
  are stored or shown to any learning model. Notes you dictate verbatim are
  stored as you said them; everything else goes through the scrubber.
- **Least-privilege learners.** The extraction model is effectively tool-less:
  inline input, structured output, nothing else. The consolidation model gets
  file tools scoped to the memory folder — no shell, no network. Transcript
  content is treated as hostile data, never as instructions.
- **Host data stays the host's.** Session transcripts and session discovery go
  through the host's official API. The memory system's database is its own,
  with its own schema; it never opens the host's internal store even
  read-only. Ownership boundaries make the system robust against the host
  changing storage details — and make it impossible for a memory bug to write
  anywhere it shouldn't.
- **Destructive operations refuse unsafe shapes.** The reset path declines to
  run if the memory folder is a symbolic link, so it can't be tricked into
  deleting something else through indirection.
- **Human authority over content.** You can read, edit, grep, and delete the
  whole memory with ordinary tools, and the consolidation layer is instructed
  to treat unexplained edits as deliberate. Finally, sessions that pulled in
  web or untrusted external content can be excluded from learning altogether
  with one option, for users who want memory shaped only by their own work.

## Design Trade-offs Worth Learning From

Stepping back from the specifics, the architecture embodies a set of choices
any memory system designer will face:

- **Plain text over embeddings.** The system bets that aggressive,
  wording-preserving distillation plus an intelligent searcher beats
  similarity search over raw history. The payoff: zero infrastructure, total
  inspectability, natural provenance, and forgetting-by-deletion that plain
  files make trivial. The cost: retrieval quality depends on the disciplines
  of extraction and consolidation, not on the index.
- **Two writers over one.** Extraction and consolidation need different
  models, different parallelism, different failure semantics, and different
  privilege levels. Folding them into one job would tangle all four.
  The price is a staging database and a scheduling dance.
- **Files as both output and signal.** Committing baselines and diffing the
  workspace turns "what changed?" into a solved problem and gives users the
  simplest possible write access to their own memory. A version control layer
  in a memory system is unusual — and it's what makes incremental
  consolidation, auditing, and deletion propagation cheap.
- **Recency *and* recency-with-use.** Neither alone is right: pure recency
  drowns durable preferences in fresh trivia; pure use-count freezes the
  memory of a past self. Every ranking in the system blends the two, and
  pruning only kills what is old *and* unproven.
- **One global memory — with soft routing.** Earlier iterations of the
  upstream design had per-project memory stores and deliberately abandoned
  them. Scoping forces impossible questions (which project does *"prefers
  table-driven tests"* belong to?) and starves every scope of evidence.
  Instead: one store, one consolidation pass, and project awareness pushed
  into content — each memory carries the working directory and scope it came
  from, as routing metadata rather than a hard partition. Your conventions
  follow you into a brand-new project on day one, while project-specific facts
  stay labeled as such. The accepted cost is that unrelated context can
  occasionally surface; the judged-greater cost of partitioning was lost
  cross-pollination and boundary maintenance forever.
- **Everything tunable, nothing required.** Idle thresholds, age cutoffs,
  unused-days horizons, batch sizes, model choices per phase — all are knobs
  with conservative defaults, because the right forgetting cadence is a
  property of how *you* work.

## Conclusion

Memory for an AI agent is not a database problem; it is an editorial one. The
system described here works because it embraces three disciplines that mirror
how humans manage knowledge:

- **Learning** is retrospective, selective, and evidence-based. It happens in
  the background, passes through a minimum-signal gate that treats "not worth
  writing down" as a first-class answer, and keeps provenance from day one.
- **Remembering** is layered. A tiny, cache-stable, always-on summary acts as
  a map; the model itself walks from map to handbook to session recaps on
  demand; and the deepest layer — the raw past — is never reprocessed, only
  distilled.
- **Forgetting** is continuous and multi-channel. Usage counts make memory
  quality measurable; age without use triggers pruning; deletion of evidence
  propagates surgically into every derived layer; and the human can edit the
  whole thing with a text editor, because it was never anything fancier than
  files.

The deepest idea in the design is also the simplest: **distillation over
accumulation**. A memory system earns its keep not by how much it retains but
by how reliably the cheap, always-on layer points to something worth the
expensive descent — and by how willingly it lets the rest go.

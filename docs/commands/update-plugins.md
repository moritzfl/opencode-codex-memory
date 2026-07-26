---
description: Check pinned plugin versions in global opencode.json against npm and bump them after confirmation
---

Check my global opencode config for outdated pinned plugins and update them after I confirm.

Follow these steps exactly:

1. Read `~/.config/opencode/opencode.json` and extract the `plugin` array.
2. Identify entries with a pinned version: strings of the form `<name>@<version>`, where the version is everything after the LAST `@` (this handles scoped packages like `@scope/pkg@1.2.3`, whose name starts with `@`). For tuple entries `[name, options]`, apply the same check to the first element. Skip entries without a version pin, and skip local plugins (paths starting with `./`, `../`, `/`, or `file://`).
3. For each pinned plugin, look up the latest published version on npm with `npm view <name> version`. Run lookups in parallel where possible.
4. Compare pinned vs latest using semver. If every pin is already at the latest version, report that and stop.
5. Otherwise, present a table with columns: plugin, pinned, latest. Then ask me which updates to apply (all, none, or a subset). Do NOT edit anything before I confirm.
6. After confirmation, update only the confirmed version pins in `~/.config/opencode/opencode.json`. Preserve formatting, entry order, and every other field exactly as-is.
7. Finish by reminding me to restart opencode so the updated plugins are loaded.

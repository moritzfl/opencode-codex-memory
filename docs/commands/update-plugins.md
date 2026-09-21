---
description: Check pinned npm plugins in the global OpenCode config and update them after confirmation
---

Check my global opencode config for outdated pinned plugins and update them after I confirm.

Follow these steps exactly:

1. Locate the global OpenCode config under `$XDG_CONFIG_HOME/opencode` when set, otherwise `~/.config/opencode`. Read `opencode.jsonc`, falling back to `opencode.json`. Read `plugins` (OpenCode 2), falling back to `plugin` (OpenCode 1.x). If both files or fields contain plugin definitions, resolve which entries are active before proposing edits.
2. Identify exact version pins of the form `<name>@<version>`, splitting at the LAST `@` to handle scoped packages. Entries can be strings, OpenCode 2 objects (`package` plus `options`), or OpenCode 1.x tuples (`[package, options]`). Skip unpinned entries, version ranges, local paths, `file://` URLs, and Git sources such as `github:`, `git+`, `git://`, or HTTPS repository URLs.
3. For each pinned npm plugin, look up `npm view <name> dist-tags --json`. Run lookups in parallel where possible. Compare stable pins with `latest`; for prerelease pins use `next` when available. Report missing packages or tags rather than guessing a version.
4. Compare using semver and present a table with plugin, pinned version, published target, and status. A pin ahead of the published target is not an update and must not be downgraded. If nothing is outdated, report that and stop.
5. Ask which updates to apply (all, none, or a subset). Do NOT edit anything before confirmation.
6. Update only confirmed pins in the file that defined them. Preserve formatting, entry order, plugin options, and unrelated settings. Do not convert the OpenCode config format as part of a version update.
7. Remind me to restart the OpenCode server: `opencode service restart` for OpenCode 2's shared service, or restart OpenCode 1.x / an IDE-managed server as appropriate.

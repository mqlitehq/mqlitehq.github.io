# Building and reviewing the documentation site

The Go repository is the normative source. The site build is read-only with
`--check`; it does not install MQLite, change a database, or publish the website.

```sh
node tools/build.mjs /absolute/path/to/mqlite
node tools/build.mjs /absolute/path/to/mqlite --check
cd tools
npm test
```

## Agent entry points and versions

Edit `templates/agents.html`, `templates/index.html`, and `templates/llms.txt`,
not their generated root files. Their English and Simplified Chinese outputs use
one fact set: source version, supported stable documentation baseline, Go source
floor, schema token, broker port, and route/tool/command counts. A version-only
source bump does not require manually editing these facts in each language.
Historical minimum versions, withdrawn releases, and migration boundaries remain
literal history. Translations must preserve each named fact placeholder, not just
its current numerical value.

Install examples use `@latest`. Both command packages are installed in one Go
invocation so they resolve to the same module version. This selects published
module versions rather than the source branch `main`. Check `mqlite version`,
the broker's JSON discovery response, and MCP `initialize.serverInfo.version`.
There is no `mqlite-mcp --version` flag. Use documentation for the installed
release, or the exact source documentation for an unreleased build. The port in
runnable startup examples is configured explicitly; it is not inferred from the
main branch's default for a different installed release.

The documentation baseline is the first supported, dated stable release heading
in canonical `CHANGELOG.md`; release candidates and withdrawn/retracted headings
are excluded. It is not a live Go-proxy or GitHub-release lookup. Historical
version explanations must not be replaced indiscriminately with `latest`.
The Go module version-query and install rules are documented at
<https://go.dev/ref/mod#version-queries> and <https://go.dev/ref/mod#go-install>.

## Reviewing source changes

`tools/agent-contract.json` records the reviewed source behind the agent guidance.
The gate checks the exact file inventory and bytes, including MCP argument
schemas and HTTP mappings, wire definitions, authorization, lease/settlement
logic, CLI behavior, schema/defaults, dependencies, and normative documents.
Same-name/same-count changes and added or removed files do not pass silently.
The version constant and test files are intentionally excluded; version facts
are generated, while behavior changes require an actual review.

When it fails, inspect the changed canonical files and review `agents`, `llms`,
the copyable prompt, and both languages before recording new fingerprints and
the reviewed source revision. Regenerating a hash is not a semantic review.
Update the source/translation pairings only after reviewing their correspondence,
then regenerate the outputs and run the tests. Do not disable the gate or replace
failed evidence with a successful version-only test.

This is conservative: comments and refactors can also require review. Coverage
is the explicit production-directory scope in `agent-contract.mjs`; a new
production package outside that scope requires expanding it. Placeholder identity
checks and source hashes cannot prove the meaning of natural-language prose.
Independent semantic review is still needed.

## Detecting changes in the other repository

The website workflow checks canonical Go `main` on website PRs and updates, and
is scheduled hourly at minute 17. The schedule becomes active only after this
workflow reaches the default branch; GitHub may delay or disable scheduled work,
so it is not an immediate Go-PR gate or a guaranteed one-hour response time.
A Go-only contract change fails the site check even when the number of tools is
unchanged. Before publishing, verify the site check against the intended current
canonical source, rather than relying on an old green run.

Scheduled checks have read-only repository permissions, do not retain checkout
credentials, and never deploy. Deployment keeps the existing main-branch push
or explicit manual workflow policy; PR and schedule events cannot deploy. The
packaging script copies public generated files only, excluding templates,
translation catalogs, tools, and contract-review data.

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
in canonical `CHANGELOG.md` with an existing tag in the canonical checkout;
release candidates and withdrawn/retracted/unsupported headings are excluded.
The checkout must include its tags (CI fetches the complete tag/history set).
Missing Git metadata fails closed; a prepared dated heading is not a published
module tag. Tracked tree differences from that tag also mark the source as
unreleased, even when the version and changelog notes were not updated.
These are read-only local Git checks, not a live Go-proxy or GitHub-release lookup. Historical
version explanations must not be replaced indiscriminately with `latest`.
The Go module version-query and install rules are documented at
<https://go.dev/ref/mod#version-queries> and <https://go.dev/ref/mod#go-install>.

## Reviewing source changes

`tools/agent-contract.json` records the reviewed source behind the whole website
(the filename predates the wider scope).
The gate checks the exact file inventory and bytes, including MCP argument
schemas and HTTP mappings, wire definitions, authorization, lease/settlement
logic, CLI behavior, schema/defaults, dependencies, and normative documents.
It also includes the actual embedded console assets, all website reference
documents, and the build/release/deployment inputs behind toolchain, platform and
container claims. The companion contract separately checks the remote SDK's
production source, source floor and public compatibility inputs.
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

## Whole-site index and version checklist

`tools/site-index.json` maps every public file to its maintained sources, locale,
owner and generation/static-review policy. The same index is the Pages packaging
allowlist. Independent filesystem discovery rejects unregistered pages, new
locale directories and assets; missing files, incomplete language counterparts
and changed unreviewed static files also fail. A new page needs a source mapping,
translation, fact review and tests before it can be packaged.

`tools/version-references.json` classifies literal reference lines in every
indexed content source, including both languages, summaries, artwork labels,
scripts and explanatory figures. It records exact text and repeated occurrences,
so reusing the same old version in a new sentence does not reuse an old review.
The classes are current stable release, current source Go floor, historical
compatibility, and upstream/companion version. Current classes must contain the
actual bound value, as well as a matching reviewed value. The SDK example pinned
to a companion version remains an explicit recorded example; this check does not
claim that every canonical installation example uses `@latest`.

A new stable baseline requires reviewing the whole indexed release checklist,
including production exact-image pins and matching-release links. Changes to
the default port, schema token or Go floor require reviewing literal examples
and figures too. Regenerated banners alone cannot approve old body text. Keep
historical migration boundaries and measured benchmark toolchains literal; read
the context before changing a classification or fingerprint. There is no command
to automatically accept or refresh the review ledger.

Run the same read-only audit as PR CI, using canonical checkouts of both modules:

```sh
node tools/site-audit.mjs /absolute/path/to/mqlite \
  --sdk /absolute/path/to/mqlite-go \
  --report /absolute/path/outside-the-public-site/audit.json
```

The JSON report lists every public source mapping and each reference's actual
line, classification and review reason. CI also writes an index to the job
summary and retains `documentation-audit` separately from the Pages package.
Failures include the offending file and reference position. The tests include
unregistered pages, reverse-order latest-release declarations, stale Chinese
facts, new occurrences of existing versions, forged review-value updates,
changed embedded-console assets and source-floor/release configuration changes.

This is a conservative textual and source-change gate, not a natural-language
proof or an assertion that all release assets are available. Source ranges and
classifications remain reviewable maintenance decisions. A source-version-only
bump can still regenerate facts without rewriting historical references.

## Detecting changes in the source repositories

The website workflow checks canonical broker and remote-SDK `main` on website PRs and updates, and
is scheduled hourly at minute 17. The schedule becomes active only after this
workflow reaches the default branch; GitHub may delay or disable scheduled work,
so it is not an immediate Go-PR gate or a guaranteed one-hour response time.
A Go-only contract change fails the site check even when the number of tools is
unchanged. Before publishing, verify the site check against the intended current
canonical source, rather than relying on an old green run.

Scheduled checks have read-only repository permissions, do not retain checkout
credentials, and never deploy. Deployment keeps the existing main-branch push
or explicit manual workflow policy; PR and schedule events cannot deploy. The
packaging script copies indexed generated and reviewed static files, excluding templates,
translation catalogs, tools, and contract-review data.

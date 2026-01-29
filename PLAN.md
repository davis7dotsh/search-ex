# Plan: Hexdocs Agent Wrapper (Cloudflare Worker)

## Goals
- Provide a Cloudflare Worker that accepts a hexdocs URL (same path/version) on a custom host and returns a **single, machine‑readable Markdown document**.
- The Markdown must start with a **Navigation + Discovery Instructions** block that explains, deterministically, how an agent should traverse modules, functions, types, exceptions, and related pages with **no guesswork**.
- Replace the value of `llms.txt` by serving a richer, consolidated Markdown index at the same path on the wrapper host.

## Inputs & Outputs
- Input: `https://<wrapper-host>/<package>/<version>/<page>.html` (mirrors hexdocs path).
- Output: `text/markdown; charset=utf-8` with:
  1) **Instruction header** (machine‑readable, explicit steps & URL patterns)
  2) **Full content** of the referenced page in Markdown
  3) Optional **related links** section (modules, exceptions, types, callbacks)

## Constraints
- Target only Hex/ExDoc pages (Elixir docs on `hexdocs.pm`).
- Entirely machine‑readable output (no HTML response for agents).
- Must not rely on prior model knowledge; all navigation is defined in output instructions.

## Implementation Steps
1. **Project setup (Cloudflare Workers + Bun)**
   - Use `wrangler` and `bun` for scaffolding and dependency management.
   - Add `check` and `format` scripts appropriate for a Bun/TS Worker.
   - Choose minimal dependencies (ideally none).

2. **Core routing**
   - Parse incoming URL and map to `https://hexdocs.pm/...`.
   - If path ends with `/llms.txt`, serve a **synthetic replacement** (see step 5).
   - Otherwise fetch the upstream page and convert/augment.

3. **Fetch & normalize**
   - If request path ends with `.html`, fetch the HTML and discover “Copy Markdown” link.
   - If request path already ends with `.md`, fetch Markdown directly.
   - For safety, follow the “Copy Markdown” link from the HTML when present.

4. **Markdown extraction**
   - Use direct `.md` endpoints for module pages (`AI.Messages.md`) and README (`readme.md`).
   - Preserve headings and function lists from the Markdown.

5. **Instruction header template**
   - Build a deterministic header block that describes:
     - How to find module pages (from `llms.txt` module list)
     - How to map `{Module}.md` → `{Module}.html` → `{Module}.html#summary`
     - How to discover function lists (`#summary`)
     - How to locate exceptions (from `llms.txt` Exceptions section)
     - How to access full Markdown (`Copy Markdown` link)
     - How to infer related modules via links in Markdown
   - Emit this header at the top of every response.

6. **`llms.txt` replacement**
   - Fetch upstream `llms.txt` (Markdown) and parse:
     - Modules list
     - Exceptions list
   - For each module, build a richer entry with:
     - Module summary (from `llms.txt`)
     - Function list (from `{Module}.md` headings)
     - Optional: Types/Callbacks if present
   - Return as a single Markdown document with clear sections.

7. **Caching**
   - Add edge caching for fetched upstream docs.
   - Configure `Cache-Control` for stable docs (versioned URLs are immutable).

8. **Testing**
   - Add a small test or script that:
     - Validates `readme.html` → Markdown response with instruction header
     - Validates `/llms.txt` returns enriched Markdown
   - Use Bun’s test runner or a minimal node/bun script.

9. **Deployment**
   - Configure `wrangler.toml` with routes for the wrapper host.
   - Document how to deploy and verify.

## Open Questions
- Do we include *all* module Markdown in the `llms.txt` replacement, or just summaries + function lists?
- Should the wrapper also emit a JSON variant for tooling, or Markdown only?
- How aggressive should caching be for “latest” (non‑versioned) docs?

## Acceptance Criteria
- Given `https://<wrapper-host>/ai_sdk_ex/0.1.1/readme.html`, the response is Markdown with a clear instruction header and the README content.
- Given `https://<wrapper-host>/ai_sdk_ex/0.1.1/llms.txt`, the response is a single Markdown document with module/function detail far beyond Hex’s default.
- No guesswork required: all navigation patterns are explicit and actionable.

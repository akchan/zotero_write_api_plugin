# Zotero Write API Plugin

Minimal Zotero plugin that exposes a small set of **write** endpoints on Zotero's local HTTP server (`http://127.0.0.1:23119`). It is a stripped-down fork of [`dzackgarza/zotero-local-write-api`](https://github.com/dzackgarza/zotero-local-write-api), kept just to the operations consumed by the companion MCP server.

> **Intended client:** [`akchan/zotero_mcp_server_write`](https://github.com/akchan/zotero_mcp_server_write) — an MCP server that lets an LLM perform Zotero write operations locally. Direct `curl` use is fine but secondary; the plugin exists to back that server.

For *read* operations (search, fetch, fulltext, collections), the recommended companion is the read-only MCP server [`54yyyu/zotero-mcp`](https://github.com/54yyyu/zotero-mcp).

## Why This Exists

Zotero 7+ ships a built-in HTTP API at `127.0.0.1:23119/api/` that is **read-only**. To let an LLM add items, attach PDFs, and write notes locally — without going through the Zotero Web API — we need a small writeable surface registered as a plugin. Upstream `zotero-local-write-api` ships ~25 write operations; this fork keeps only the four workflows the MCP server actually uses.

## Endpoints

| Endpoint  | Method | Purpose |
|-----------|--------|---------|
| `/attach`  | POST   | Attach a file (path or base64 bytes) to an existing item as a stored attachment |
| `/write`   | POST   | Operation dispatcher; see operations below |
| `/version` | GET    | Plugin version, supported operations, capability probe |

### `/write` operations

| Operation              | Payload                                                                              | Result |
|------------------------|---------------------------------------------------------------------------------------|--------|
| `import_by_identifier` | `{identifier: string, collection_key?: string}`                                       | Creates an item from a DOI / ISBN / arXiv ID / PMID via the matching translator. |
| `attach_note`          | `{item_key: string, note: string}`                                                    | Adds an HTML note as a child of the given item. |
| `import_pdf`           | `{file_path?: string, file_bytes_base64?: string, file_name?: string, collection_key?: string}` | Imports a PDF as a standalone attachment, then runs `Zotero.RecognizeDocument` to extract a DOI/arXiv ID and create a parent item. Returns `status: "recognized"` with `parent_item_key` and `attachment_key`, or `status: "standalone"` if the recognizer could not identify the document. |

For `/attach` and `import_pdf`, payloads with `file_path` are constrained to `FULLTEXT_ALLOWED_DIRS` (`/tmp`, `/var/tmp`). The base64 path has no such constraint.

## Install

1. Download the latest XPI from the [Releases page](https://github.com/akchan/zotero_write_api_plugin/releases).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File...**
3. Restart Zotero. The endpoints come up at startup; check the Zotero debug log for `Zotero Write API: Registered ...`.
4. Probe: `curl http://127.0.0.1:23119/version`.

## Compatibility

- Zotero `7.0` and later
- Tested against Zotero `8.0.1`

## Build from source

Requires `node` (or `bun`) and `python3` with `pyyaml`.

```
npm install     # or: bun install
npx tsc --noEmit
npm run build   # esbuild -> src/bootstrap.js
python3 build.py
```

`just release` (requires [just](https://github.com/casey/just) and `bun`) bumps the version, builds, tags, and pushes — the GitHub Actions workflow then publishes the XPI.

## What was removed from the upstream fork

The upstream plugin handles tags, collections, item-field edits, attachment relinking, item merging, and more. This fork removes every handler except the three listed above, plus the `/attach` and `/version` endpoints. The reasoning is that the consuming MCP server only exposes four tools (`add_by_doi`, `add_pdf`, `attach_pdf_to_item`, `add_note`), so additional surface is dead weight here. If you need the wider surface, use upstream directly.

## License

MIT, matching upstream.

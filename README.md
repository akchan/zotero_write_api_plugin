# Zotero Write API Plugin

Minimal Zotero plugin that exposes a small set of **write** endpoints on Zotero's local HTTP server (`http://127.0.0.1:23119`). It is a stripped-down fork of [`dzackgarza/zotero-local-write-api`](https://github.com/dzackgarza/zotero-local-write-api), kept just to the operations consumed by the companion MCP server.

> **Intended client:** [`akchan/zotero_mcp_server_write`](https://github.com/akchan/zotero_mcp_server_write) — an MCP server that lets an LLM perform Zotero write operations locally. Direct `curl` use is fine but secondary; the plugin exists to back that server.

For *read* operations (search, fetch, fulltext, collections), the recommended companion is the read-only MCP server [`54yyyu/zotero-mcp`](https://github.com/54yyyu/zotero-mcp).

## Why This Exists

Zotero 7+ ships a built-in HTTP API at `127.0.0.1:23119/api/` that is **read-only**. To let an LLM add items, attach PDFs, and write notes locally — without going through the Zotero Web API — we need a small writeable surface registered as a plugin. Upstream `zotero-local-write-api` ships ~25 write operations; this fork keeps only the four workflows the MCP server actually uses.

## Endpoints

| Endpoint  | Method | Purpose |
|-----------|--------|---------|
| `/attach`  | POST   | Attach a file (base64 bytes) to an existing item as a stored attachment. Payload: `{item_key, title, file_name, file_bytes_base64}` |
| `/write`   | POST   | Operation dispatcher; see operations below |
| `/version` | GET    | Plugin version, supported operations, capability probe |

### `/write` operations

| Operation              | Payload                                                                              | Result |
|------------------------|---------------------------------------------------------------------------------------|--------|
| `import_by_identifier` | `{identifier: string, collection_key?: string}`                                       | Creates an item from a DOI / ISBN / arXiv ID / PMID via the matching translator. |
| `attach_note`          | `{item_key: string, note: string}`                                                    | Adds an HTML note as a child of the given item. |
| `import_pdf`           | `{file_name: string, file_bytes_base64: string, collection_key?: string}` | Imports a PDF as a standalone attachment, then runs `Zotero.RecognizeDocument` to extract a DOI/arXiv ID and create a parent item. Returns `status: "recognized"` with `parent_item_key` and `attachment_key`, or `status: "standalone"` if the recognizer could not identify the document. |

The plugin accepts file content only as base64-encoded bytes (`file_bytes_base64` + `file_name`). The previous `file_path` parameter was removed in 0.2.0 to prevent the Zotero process from being directed to read arbitrary files outside the caller's intent (e.g. via symlinks in world-writable `/tmp`, path traversal, or unauthenticated localhost callers). Callers are responsible for reading the file themselves and sending the bytes.

## Security

- **Local-only**: requests are rejected if their `Host`, `Origin`, or `Referer` header points anywhere other than `localhost`/`127.0.0.1`. This defends against DNS-rebinding and cross-origin POSTs from a browser the user happens to have open.
- **Attachment size limit**: `/attach` and `import_pdf` reject base64 payloads decoding to more than **100 MB** by default. Adjust via the Zotero pref `extensions.zotero-write-api.max_attach_mb` (Tools → Developer → Config Editor; type Number).

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
npm install            # or: bun install
npx tsc --noEmit
python3 build.py       # writes everything to dist/
```

`build.py` runs esbuild (via `bun run build` if `bun` is on `$PATH`, otherwise `npm run build`) and emits:

```
dist/
├── bootstrap.js                       # esbuild output
├── manifest.json                      # generated from config.yml
└── zotero-write-api-<VERSION>.xpi     # final installable
```

`dist/` is gitignored.

`just release` (requires [just](https://github.com/casey/just) and `bun`) bumps the version, builds, tags, and pushes — the GitHub Actions workflow then publishes the XPI.

## What was removed from the upstream fork

The upstream plugin handles tags, collections, item-field edits, attachment relinking, item merging, and more. This fork removes every handler except the three listed above, plus the `/attach` and `/version` endpoints. The reasoning is that the consuming MCP server only exposes four tools (`add_by_doi`, `add_pdf`, `attach_pdf_to_item`, `add_note`), so additional surface is dead weight here. If you need the wider surface, use upstream directly.

## License

MIT, matching upstream.

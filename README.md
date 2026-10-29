# @pipeworx/hi-dmv

Hawaii vehicle-registration MCP — the statewide cumulative count of hybrid and electric
vehicles registered in Hawaii, as an annual series from 1999 to the present.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `hi_dmv_ev_registrations(year?, limit?)` — hybrid and battery-electric counts per year with a
  combined total, plus the year-over-year change and growth rate. Answers "how many electric
  vehicles are in Hawaii", "how many EVs were registered in Hawaii in 2020", "EV adoption trend
  in Hawaii".

## Auth

Keyless.

## Hawaii has no state DMV

Vehicle registration in Hawaii is administered by the **four counties** — Honolulu, Hawaii,
Maui and Kauai — not by a state motor-vehicle agency. The statewide statistics are compiled and
published by **DBEDT**, the state Department of Business, Economic Development and Tourism.
That is why this pack has one statewide series and no office locator, and why the series
carries no county split: the counties register, DBEDT aggregates.

## Grain

A clean annual time series, one row per year, 1999 through 2024 (26 rows). Counts are
**cumulative registered vehicles at the end of each year**, so a rising total means the fleet
grew; the tool computes `change_from_prior_year` and `growth_pct` per row so a trend question
needs no arithmetic from the caller. Rows are never summed across years — they are cumulative
snapshots of largely the same vehicles.

Verified live 2026-07-29: 2024 → hybrid 31,284, electric 35,242, total 66,526 · 2023 → 27,658 /
29,239 / 56,897 · 1999 → electric 10.

## Data sources

- `https://opendata.hawaii.gov/api/3/action/datastore_search?resource_id=4d4c0403-8f04-4f74-879d-64669f1437b1`
  — DBEDT "Cumulative Hybrid & Electric Vehicles Registered".

Two shapes worth knowing before touching this resource:

- Counts arrive as **thousands-separated strings** (`"31,284"`), not numbers.
- A missing value arrives as the **padded string `" -   "`**, not null and not zero. 1999 has
  no hybrid figure at all; reading that placeholder as 0 invents a data point, so the pack
  resolves it to `null` and the response note says what null means.
- Column names carry spaces and mixed case: `Year`, `Hybrid Electric Vehicles`,
  `Electric Vehicle`, `Total`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hi-dmv": {
      "url": "https://gateway.pipeworx.io/hi-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hi-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hi_dmv_ev_registrations \
  -H 'Content-Type: application/json' \
  -d '{"year":"2024"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hi_dmv_ev_registrations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-hi-dmv` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/hi-dmv/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "hi-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hi-dmv"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hi Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

# @pipeworx/hi-dmv

Hawaii vehicle-registration MCP — the statewide cumulative count of hybrid and electric
vehicles registered in Hawaii, as an annual series from 1999 to the present.

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

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Hawaii Vehicle Registrations data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

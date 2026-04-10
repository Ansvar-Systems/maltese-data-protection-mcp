# Tool Reference

All tools are prefixed with `mt_dp_` and available via both the stdio (Claude Desktop / npm) and HTTP (Docker / remote) transports.

## mt_dp_search_decisions

Full-text search across IDPC decisions and sanctions.

**Input:**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| query     | string | yes      | Search query (e.g., `cookies`, `employee monitoring`, `data breach`) |
| type      | string | no       | Filter by decision type: `sanction`, `warning`, `reprimand`, `decision` |
| topic     | string | no       | Filter by topic ID (e.g., `consent`, `cookies`, `data_breach`) |
| limit     | number | no       | Maximum results to return (default 20, max 100) |

**Response:** Array of matching decisions with `_citation` per item and `_meta` block.

---

## mt_dp_get_decision

Get a specific IDPC decision by reference number.

**Input:**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| reference | string | yes      | IDPC decision reference (e.g., `IDPC-2022-001`) |

**Response:** Full decision record with `_citation` and `_meta` block.

---

## mt_dp_search_guidelines

Search IDPC guidance documents: recommendations, guidelines, and FAQs on GDPR implementation in Malta.

**Input:**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| query     | string | yes      | Search query (e.g., `DPIA`, `cookies`, `data subject rights`) |
| type      | string | no       | Filter by type: `guide`, `recommendation`, `faq`, `template` |
| topic     | string | no       | Filter by topic ID |
| limit     | number | no       | Maximum results to return (default 20, max 100) |

**Response:** Array of matching guidelines with `_citation` per item and `_meta` block.

---

## mt_dp_get_guideline

Get a specific IDPC guidance document by its database ID.

**Input:**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | number | yes      | Guideline database ID (from `mt_dp_search_guidelines` results) |

**Response:** Full guideline record with `_citation` and `_meta` block.

---

## mt_dp_list_topics

List all covered data protection topics with English names. Use topic IDs to filter decisions and guidelines.

**Input:** None.

**Response:** Array of topic objects (`id`, `name_local`, `name_en`, `description`) with `_meta` block.

---

## mt_dp_about

Return metadata about this MCP server: version, data source, coverage, and tool list.

**Input:** None.

**Response:** Server metadata object with `_meta` block.

---

## mt_dp_list_sources

List the official data sources used by this MCP server, including URLs and coverage descriptions.

**Input:** None.

**Response:**

```json
{
  "sources": [
    {
      "name": "IDPC — Information and Data Protection Commissioner",
      "url": "https://idpc.org.mt/",
      "coverage": "IDPC decisions, sanctions, warnings, reprimands, FAQs, guides, and recommendations on GDPR implementation in Malta",
      "jurisdiction": "Malta",
      "language": "English"
    }
  ],
  "_meta": { ... }
}
```

---

## mt_dp_check_data_freshness

Check when the IDPC data was last ingested, how old it is, and current record counts.

**Input:** None.

**Response:**

```json
{
  "last_updated": "2026-03-23T16:57:08.713Z",
  "data_age": "18 days",
  "record_counts": {
    "decisions": 20,
    "guidelines": 55
  },
  "is_fresh": true,
  "freshness_threshold_days": 30,
  "_meta": { ... }
}
```

---

## Common Response Fields

### `_meta`

Every successful response includes a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "This data is provided for informational purposes only...",
    "data_age": "2026-03-23",
    "copyright": "Source: IDPC (Information and Data Protection Commissioner, Malta). © Government of Malta."
  }
}
```

### `_citation`

Every `get_*` response and every item in search result arrays includes a `_citation` block for deterministic entity linking:

```json
{
  "_citation": {
    "canonical_ref": "IDPC-2022-004",
    "display_text": "IDPC Decision IDPC-2022-004",
    "source_url": "https://idpc.org.mt/...",
    "lookup": {
      "tool": "mt_dp_get_decision",
      "args": { "reference": "IDPC-2022-004" }
    }
  }
}
```

### Error Responses

Errors include `_error_type` and `_meta`:

```json
{
  "error": "Decision not found: IDPC-9999-999",
  "_error_type": "not_found",
  "_meta": { ... }
}
```

Error types: `not_found`, `unknown_tool`, `invalid_input`, `unknown`.

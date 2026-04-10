#!/usr/bin/env node

/**
 * Maltese Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying IDPC decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: mt_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "maltese-data-protection-mcp";

// --- Ingest state + _meta ----------------------------------------------------

const INGEST_STATE_PATH =
  process.env["IDPC_INGEST_STATE_PATH"] ?? "data/crawl-state/ingest-state.json";

interface IngestState {
  last_run: string;
  decisions_count: number;
  guidelines_count: number;
}

let ingestState: IngestState = {
  last_run: "2026-03-23T16:57:08.713Z",
  decisions_count: 20,
  guidelines_count: 55,
};

try {
  ingestState = JSON.parse(
    readFileSync(INGEST_STATE_PATH, "utf8"),
  ) as IngestState;
} catch {
  // use defaults
}

const META = {
  disclaimer:
    "This data is provided for informational purposes only and does not constitute legal or regulatory advice. Always verify against official IDPC sources at https://idpc.org.mt/.",
  data_age: ingestState.last_run.slice(0, 10),
  copyright:
    "Source: IDPC (Information and Data Protection Commissioner, Malta). © Government of Malta.",
};

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "mt_dp_search_decisions",
    description:
      "Full-text search across IDPC (Information and Data Protection Commissioner) decisions and sanctions. Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'cookies', 'employee monitoring', 'data breach')",
        },
        type: {
          type: "string",
          enum: ["sanction", "warning", "reprimand", "decision"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'data_breach'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "mt_dp_get_decision",
    description:
      "Get a specific IDPC decision by reference number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "IDPC decision reference (e.g., 'IDPC-2022-001')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "mt_dp_search_guidelines",
    description:
      "Search IDPC guidance documents: recommendations, guidelines, and FAQs on GDPR implementation in Malta.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'DPIA', 'cookies', 'data subject rights')",
        },
        type: {
          type: "string",
          enum: ["guide", "recommendation", "faq", "template"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "mt_dp_get_guideline",
    description:
      "Get a specific IDPC guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from mt_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "mt_dp_list_topics",
    description:
      "List all covered data protection topics with English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mt_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mt_dp_list_sources",
    description: "List the official data sources used by this MCP server, including URLs and coverage descriptions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "mt_dp_check_data_freshness",
    description: "Check when the IDPC data was last ingested, how old it is, and current record counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["sanction", "warning", "reprimand", "decision"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guide", "recommendation", "faq", "template"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- Helper ------------------------------------------------------------------

function textContent(data: Record<string, unknown> | unknown[]) {
  const enriched = Array.isArray(data)
    ? data
    : { ...(data as Record<string, unknown>), _meta: META };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
    ],
  };
}

function errorContent(message: string, errorType: string = "unknown") {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, _error_type: errorType, _meta: META },
          null,
          2,
        ),
      },
    ],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "mt_dp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((d) => ({
          ...d,
          _citation: buildCitation(
            String(d.reference),
            String(d.title),
            "mt_dp_get_decision",
            { reference: d.reference },
            undefined,
          ),
        }));
        return textContent({ results: resultsWithCitation, count: resultsWithCitation.length });
      }

      case "mt_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`, "not_found");
        }
        const d = decision as Record<string, unknown>;
        return textContent({
          ...decision,
          _citation: buildCitation(
            String(d.reference || parsed.reference),
            String(d.title || d.reference || parsed.reference),
            "mt_dp_get_decision",
            { reference: parsed.reference },
            d.source_url as string | undefined,
          ),
        });
      }

      case "mt_dp_search_guidelines": {
        const parsed = SearchGuidelinesArgs.parse(args);
        const results = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((g) => ({
          ...g,
          _citation: buildCitation(
            String(g.reference || g.title || `guideline-${g.id}`),
            String(g.title || g.reference || `Guideline ${g.id}`),
            "mt_dp_get_guideline",
            { id: String(g.id) },
            undefined,
          ),
        }));
        return textContent({ results: resultsWithCitation, count: resultsWithCitation.length });
      }

      case "mt_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`, "not_found");
        }
        const g = guideline as Record<string, unknown>;
        return textContent({
          ...guideline,
          _citation: buildCitation(
            String(g.reference || g.title || `guideline-${parsed.id}`),
            String(g.title || g.reference || `Guideline ${parsed.id}`),
            "mt_dp_get_guideline",
            { id: String(parsed.id) },
            g.source_url as string | undefined,
          ),
        });
      }

      case "mt_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
      }

      case "mt_dp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "IDPC (Information and Data Protection Commissioner) MCP server. Provides access to Maltese data protection authority decisions, sanctions, and official guidance documents.",
          data_source: "IDPC (https://idpc.org.mt/)",
          coverage: {
            decisions: "IDPC decisions, sanctions, warnings, and reprimands",
            guidelines: "IDPC guides, recommendations, and FAQs",
            topics: "Cookies, employee monitoring, video surveillance, data breach, consent, DPIA, transfers, data subject rights",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "mt_dp_list_sources": {
        return textContent({
          sources: [
            {
              name: "IDPC — Information and Data Protection Commissioner",
              url: "https://idpc.org.mt/",
              coverage:
                "IDPC decisions, sanctions, warnings, reprimands, FAQs, guides, and recommendations on GDPR implementation in Malta",
              jurisdiction: "Malta",
              language: "English",
            },
          ],
        });
      }

      case "mt_dp_check_data_freshness": {
        let currentState = ingestState;
        try {
          currentState = JSON.parse(
            readFileSync(INGEST_STATE_PATH, "utf8"),
          ) as IngestState;
        } catch {
          // use startup-time state
        }
        const lastUpdated = new Date(currentState.last_run);
        const now = new Date();
        const ageDays = Math.floor(
          (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24),
        );
        return textContent({
          last_updated: currentState.last_run,
          data_age: `${ageDays} days`,
          record_counts: {
            decisions: currentState.decisions_count,
            guidelines: currentState.guidelines_count,
          },
          is_fresh: ageDays <= 30,
          freshness_threshold_days: 30,
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`, "unknown_tool");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`, "invalid_input");
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

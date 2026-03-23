#!/usr/bin/env tsx
/**
 * IDPC (idpc.org.mt) ingestion crawler for the Maltese Data Protection MCP.
 *
 * Four-phase pipeline:
 *   Phase 1 — Sitemap discovery: parse WordPress XML sitemaps (post-sitemap.xml
 *             and page-sitemap.xml) to collect post/page URLs.
 *   Phase 2 — Decision listing: crawl /decisions/ and /all-decisions/ to find
 *             additional decision page links and PDF references (CDP/COMP/xxx).
 *   Phase 3 — Decisions: fetch decision and enforcement pages, parse HTML, insert.
 *   Phase 4 — Guidelines: fetch guidance/publication pages, parse HTML, insert.
 *
 * The IDPC site runs WordPress with Visual Composer. Content lives in
 * .vce-text-block, .entry-content, and article elements. Structured metadata
 * comes from og: meta tags and JSON-LD.
 *
 * IDPC decisions follow two publication patterns:
 *   - WordPress posts announcing decisions (HTML, crawled via sitemaps)
 *   - PDF documents at wp-content/uploads/ with CDP/COMP/xxx/yyyy references
 *     (discovered from /decisions/ and /all-decisions/ listing pages)
 *
 * All content is in English.
 *
 * Usage:
 *   npx tsx scripts/ingest-idpc.ts                 # full crawl
 *   npx tsx scripts/ingest-idpc.ts --dry-run       # discover + parse, no DB writes
 *   npx tsx scripts/ingest-idpc.ts --resume        # skip already-ingested URLs
 *   npx tsx scripts/ingest-idpc.ts --force         # drop existing data first
 *   npx tsx scripts/ingest-idpc.ts --limit 20      # process first 20 URLs only
 *
 * Environment:
 *   IDPC_DB_PATH — SQLite database path (default: data/idpc.db)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["IDPC_DB_PATH"] ?? "data/idpc.db";
const STATE_DIR = resolve(__dirname, "../data/crawl-state");
const STATE_PATH = resolve(STATE_DIR, "ingest-state.json");

const BASE_URL = "https://idpc.org.mt";
const POST_SITEMAP_URL = `${BASE_URL}/post-sitemap.xml`;
const PAGE_SITEMAP_URL = `${BASE_URL}/page-sitemap.xml`;

/** Decision listing pages — may contain links to individual decision pages or PDFs. */
const DECISION_LISTING_URLS = [
  `${BASE_URL}/decisions/`,
  `${BASE_URL}/all-decisions/`,
];

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "AnsvarIDPCCrawler/1.0 (+https://ansvar.eu; data-protection-research)";

// ─── URL classification patterns ────────────────────────────────────────────

/** Slug patterns that indicate a decision or enforcement action. */
const DECISION_PATTERNS: RegExp[] = [
  /decision/,
  /sanction/,
  /fine/,
  /penalty/,
  /enforcement/,
  /reprimand/,
  /breach/,
  /infringement/,
  /corrective/,
  /administrative-fine/,
  /investigation/,
  /orders?-to/,
  /prohibition/,
  /compliance-order/,
  /cplanet/,
  /data-breach/,
  /imposed-an-administrative/,
  /commissioner-imposes/,
  /commissioner-orders/,
  /commissioner-issues/,
  /commissioner-finds/,
];

/** Slug patterns that indicate a guideline or guidance document. */
const GUIDELINE_PATTERNS: RegExp[] = [
  /guidance/,
  /guideline/,
  /guide$/,
  /recommendation/,
  /opinion/,
  /faq/,
  /clarification/,
  /note-on/,
  /policy-on/,
  /code-of-conduct/,
  /certification/,
  /self-assessment/,
  /principles/,
  /lawfulness/,
  /definitions-and-applicability/,
  /data-protection-impact-assessment/,
  /international-transfers/,
  /data-protection-officers/,
  /employment-sector/,
  /restrictions/,
  /your-rights/,
  /consent-requirements/,
  /conditions-for-valid-consent/,
  /cctv$/,
  /social-media$/,
  /children$/,
  /security$/,
  /direct-marketing$/,
  /legislation$/,
  /artificial-intelligence/,
  /data-scraping/,
  /data-monetisation/,
  /working-remotely/,
  /street-photography/,
  /vaccination-status/,
  /political-campaigning/,
  /deceptive-design/,
  /pseudonymisation/,
  /right-of-access/,
  /right-to-erasure/,
  /coordinated-enforcement/,
  /data-protection-day/,
  /gdpr-in-your-pocket/,
  /small-business/,
  /processing-of-personal-data/,
  /cookie/,
  /data-protection-principles/,
];

/** URLs or slug patterns to skip (events, admin, recruitment, etc.). */
const SKIP_PATTERNS: RegExp[] = [
  /career/,
  /recruitment/,
  /job/,
  /disclaimer/,
  /copyright/,
  /accessibility-statement/,
  /privacy-policy/,
  /cookies-policy/,
  /data-protection-notice/,
  /data-protection-policy/,
  /subscribe/,
  /suubscribe/,
  /contact$/,
  /our-office$/,
  /mission$/,
  /vision$/,
  /organigram/,
  /annual-report/,
  /newsletter/,
  /linkedin/,
  /follow-us/,
  /cooperation-agreement/,
  /cooperation$/,
  /international-cooperation/,
  /sign[s]?-memorandum/,
  /sign[s]?-mou/,
  /mou-with/,
  /signs-cooperation/,
  /appointment-of/,
  /commissioner-addresses/,
  /conference/,
  /workshop/,
  /seminar/,
  /webinar/,
  /campaign/,
  /awareness/,
  /podcast/,
  /biidpa/,
  /global-privacy-assembly/,
  /call-for-experts/,
  /pool-of-experts/,
  /report-a-breach/,
  /file-a-complaint/,
  /foi_application/,
  /foi_decisions/,
  /all-decisions$/,
  /^\/$/,
  /test-page/,
  /for-organisations\/$/, // landing pages only — sub-pages captured by GUIDELINE_PATTERNS
  /for-individuals\/$/, // same
  /decisions\/$/, // listing page, not individual decision
  /news-latest\/$/, // listing page
  /idpc-publications\/$/, // listing page
  /entry-exit-system/,
  /visa-information-system/,
  /exercise-your-rights-for-sis/,
  /functionalities-of-sis/,
  /gdprights-eu-funded/,
  /taskforce-chatgbt/,
  /form-laucharticle/,
  /memorandum-of-understanding/,
  /philippin/,
  /gibraltar/,
  /albania/,
  /isle-of-man/,
  /united-kingdom/,
  /moldova/,
  /italys-data-protection/,
  /irish-data-protection-commission/,
  /edps-opinion/,
  /edpb-work-programme/,
  /edpb-launches/,
  /edpb-and-edps-support/,
  /digital-omnibus/,
  /whatsapp-ireland/,
  /eu-us-data-privacy/,
  /facebook-data-leak/,
  /edpb-facial/,
  /edpb-public-consultation/,
  /eu-commission-adopts/,
  /european-essential-guarantees/,
  /supplement-transfer-tools/,
  /schrems-ii/,
  /amazon-to-stop/,
  /appeals-tribunal/,
  /annual-reports/,
  /data-protection-notice-workshop/,
];

// ─── CLI args ───────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  limit: number | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    dryRun: false,
    resume: false,
    force: false,
    limit: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--resume") {
      opts.resume = true;
      continue;
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--limit" && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.limit = parsed;
      i++;
      continue;
    }
  }

  return opts;
}

// ─── Crawl state (for --resume) ─────────────────────────────────────────────

interface CrawlState {
  ingested_urls: string[];
  last_run: string;
  decisions_count: number;
  guidelines_count: number;
}

function loadState(): CrawlState {
  if (!existsSync(STATE_PATH)) {
    return {
      ingested_urls: [],
      last_run: "",
      decisions_count: 0,
      guidelines_count: 0,
    };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as CrawlState;
  } catch {
    return {
      ingested_urls: [],
      last_run: "",
      decisions_count: 0,
      guidelines_count: 0,
    };
  }
}

function saveState(state: CrawlState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en,mt;q=0.5",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) return response;

      if (response.status === 429 || response.status >= 500) {
        const wait = RETRY_BACKOFF_MS * attempt;
        console.warn(
          `  WARN: HTTP ${response.status} for ${url}, retry ${attempt}/${retries} in ${wait}ms`,
        );
        await sleep(wait);
        continue;
      }

      // 4xx (not 429) — do not retry
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        console.warn(
          `  WARN: Timeout for ${url}, retry ${attempt}/${retries}`,
        );
      } else {
        console.warn(`  WARN: ${msg}, retry ${attempt}/${retries}`);
      }
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetry(url);
  return response.text();
}

// ─── Phase 1: Sitemap discovery ─────────────────────────────────────────────

interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

async function discoverSitemapUrls(): Promise<SitemapEntry[]> {
  console.log("\n=== Phase 1: Discover URLs from sitemaps ===\n");

  const entries: SitemapEntry[] = [];

  for (const sitemapUrl of [POST_SITEMAP_URL, PAGE_SITEMAP_URL]) {
    console.log(`  Fetching ${sitemapUrl}`);
    try {
      const xml = await fetchText(sitemapUrl);
      const $ = cheerio.load(xml, { xmlMode: true });

      $("url").each((_i, el) => {
        const loc = $(el).find("loc").text().trim();
        const lastmod = $(el).find("lastmod").text().trim() || null;
        if (loc) entries.push({ url: loc, lastmod });
      });

      console.log(`    Found ${entries.length} URLs so far`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  WARN: Failed to fetch sitemap ${sitemapUrl}: ${msg}`,
      );
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(`  Total unique URLs from sitemaps: ${unique.length}`);
  return unique;
}

// ─── Phase 2: Decision listing pages ────────────────────────────────────────

/**
 * Crawl the /decisions/ and /all-decisions/ listing pages to discover
 * additional decision page links and PDF references that may not appear
 * in the sitemap.
 *
 * The IDPC publishes formal decisions as PDFs (CDP/COMP/xxx/yyyy) and
 * sometimes as WordPress posts linking to those PDFs. This phase finds
 * both HTML decision pages and standalone PDF links.
 */
async function discoverDecisionListingLinks(): Promise<{
  pageLinks: SitemapEntry[];
  pdfLinks: string[];
}> {
  console.log("\n=== Phase 2: Discover decisions from listing pages ===\n");

  const pageLinks: SitemapEntry[] = [];
  const pdfLinks: string[] = [];
  const seen = new Set<string>();

  for (const listingUrl of DECISION_LISTING_URLS) {
    console.log(`  Fetching ${listingUrl}`);
    try {
      const html = await fetchText(listingUrl);
      const $ = cheerio.load(html);

      // Find all links on the listing page
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const absolute = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

        // Skip external links
        if (!absolute.startsWith(BASE_URL)) return;

        // PDF links — typically CDP/COMP decisions
        if (/\.pdf$/i.test(absolute)) {
          if (!seen.has(absolute)) {
            seen.add(absolute);
            pdfLinks.push(absolute);
          }
          return;
        }

        // HTML page links that look like decision pages
        if (!seen.has(absolute) && absolute !== listingUrl) {
          // Only add links that look like decision content
          const path = absolute.replace(BASE_URL, "").toLowerCase();
          if (
            /\/idpc-publications\//.test(path) ||
            /\/news-latest\//.test(path) ||
            DECISION_PATTERNS.some((p) => p.test(path))
          ) {
            seen.add(absolute);
            pageLinks.push({ url: absolute, lastmod: null });
          }
        }
      });

      console.log(
        `    Found ${pageLinks.length} page links and ${pdfLinks.length} PDF links so far`,
      );
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  WARN: Failed to fetch listing ${listingUrl}: ${msg}`,
      );
    }

    // Try paginated pages (WordPress ?paged=N or /page/N/)
    for (let page = 2; page <= 20; page++) {
      const pagedUrl = `${listingUrl}page/${page}/`;
      try {
        const html = await fetchText(pagedUrl);
        const $ = cheerio.load(html);

        let foundOnPage = 0;
        $("a[href]").each((_i, el) => {
          const href = $(el).attr("href");
          if (!href) return;

          const absolute = href.startsWith("http")
            ? href
            : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

          if (!absolute.startsWith(BASE_URL)) return;

          if (/\.pdf$/i.test(absolute)) {
            if (!seen.has(absolute)) {
              seen.add(absolute);
              pdfLinks.push(absolute);
              foundOnPage++;
            }
            return;
          }

          if (!seen.has(absolute) && absolute !== pagedUrl) {
            const path = absolute.replace(BASE_URL, "").toLowerCase();
            if (
              /\/idpc-publications\//.test(path) ||
              /\/news-latest\//.test(path) ||
              DECISION_PATTERNS.some((p) => p.test(path))
            ) {
              seen.add(absolute);
              pageLinks.push({ url: absolute, lastmod: null });
              foundOnPage++;
            }
          }
        });

        if (foundOnPage === 0) {
          // No new links found — end of pagination
          break;
        }

        console.log(
          `    Page ${page}: +${foundOnPage} links (total: ${pageLinks.length} pages, ${pdfLinks.length} PDFs)`,
        );
        await sleep(RATE_LIMIT_MS);
      } catch {
        // Pagination page does not exist — stop
        break;
      }
    }
  }

  console.log(
    `  Decision listing discovery complete: ${pageLinks.length} page links, ${pdfLinks.length} PDF links`,
  );
  return { pageLinks, pdfLinks };
}

// ─── URL classification ─────────────────────────────────────────────────────

type ContentType = "decision" | "guideline" | "skip";

function classifyUrl(url: string): ContentType {
  const path = url.replace(BASE_URL, "").toLowerCase();

  // Skip non-content pages first
  if (SKIP_PATTERNS.some((p) => p.test(path))) return "skip";

  // Decisions and enforcement actions
  if (DECISION_PATTERNS.some((p) => p.test(path))) return "decision";

  // Guidelines, guidance, and informational pages
  if (GUIDELINE_PATTERNS.some((p) => p.test(path))) return "guideline";

  // Pages under /for-organisations/ and /for-individuals/ sub-paths are
  // generally guidance content even if not matched above
  if (/\/for-organisations\/[^/]+/.test(path)) return "guideline";
  if (/\/for-individuals\/[^/]+/.test(path)) return "guideline";

  return "skip";
}

// ─── HTML parsing ───────────────────────────────────────────────────────────

interface ParsedPage {
  title: string;
  date: string | null;
  bodyText: string;
  pdfLinks: string[];
}

function parseIdpcPage(html: string, _url: string): ParsedPage {
  const $ = cheerio.load(html);

  // Title: try og:title, then <title>, then h1
  let title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    "";

  // Strip site name suffix
  title = title.replace(/\s*[-\u2013\u2014|]\s*IDPC$/i, "").trim();

  // Date: try article:published_time, then JSON-LD datePublished
  let date: string | null = null;

  const ogDate = $('meta[property="article:published_time"]').attr("content");
  if (ogDate) {
    date = ogDate.slice(0, 10);
  }

  if (!date) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (date) return;
      try {
        const ld = JSON.parse($(el).text()) as Record<string, unknown>;
        if (typeof ld["datePublished"] === "string") {
          date = (ld["datePublished"] as string).slice(0, 10);
        } else if (typeof ld["dateModified"] === "string") {
          date = (ld["dateModified"] as string).slice(0, 10);
        }
      } catch {
        /* skip malformed JSON-LD */
      }
    });
  }

  // Content extraction: Visual Composer uses .vce-text-block, .vce-col-inner
  // Also try .entry-content, .post-content, article, main
  const contentSelectors = [
    ".vce-text-block",
    ".vce-col-inner",
    ".entry-content",
    ".entry-full-content",
    ".post-content",
    "article .content",
    "#main-content",
    "article",
    "main",
  ];

  let bodyText = "";

  for (const selector of contentSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      const parts: string[] = [];
      elements.each((_i, el) => {
        const text = $(el).text().trim();
        if (text.length > 50) {
          parts.push(text);
        }
      });

      if (parts.length > 0) {
        bodyText = parts.join("\n\n");
        break;
      }
    }
  }

  // Fallback: strip nav/footer/header and take full body text
  if (!bodyText) {
    $(
      "nav, footer, header, script, style, noscript, .vce-header, .vce-footer",
    ).remove();
    bodyText = $("body").text().replace(/\s+/g, " ").trim();
  }

  // Extract PDF links
  const pdfLinks: string[] = [];
  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) {
      const absolute = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      pdfLinks.push(absolute);
    }
  });

  return { title, date, bodyText, pdfLinks };
}

// ─── Content extraction helpers ─────────────────────────────────────────────

/** Extract GDPR article references from text. */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();

  const patterns = [
    /article\s+(\d{1,3})/gi,
    /art\.\s*(\d{1,3})/gi,
    /artikolu\s+(\d{1,3})/gi, // Maltese
    /gdpr\s+art(?:icle)?\.?\s*(\d{1,3})/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const num = match[1]!;
      const n = parseInt(num, 10);
      // GDPR articles range 1-99
      if (n >= 1 && n <= 99) {
        articles.add(num);
      }
    }
  }

  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Try to extract entity name from decision text. */
function extractEntityName(text: string): string | null {
  const patterns = [
    // "decision on <entity>" or "decision against <entity>"
    /decision\s+(?:on|against|regarding)\s+(?:the\s+)?(.+?)(?:\s+for\s+|\s+relating\s+to|\s+in\s+relation|\s*[.,;])/i,
    // "fined <entity>" or "fine on <entity>"
    /fin(?:ed?|ing)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+for\s+|\s+a\s+total|\s+of\s+|\s*\u20AC)/i,
    // "imposed on <entity>"
    /imposed\s+(?:on|against)\s+(?:the\s+)?(.+?)(?:\s+for\s+|\s+a\s+|\s+an\s+|\s*[.,;])/i,
    // "sanction against <entity>"
    /sanction\s+(?:on|against)\s+(?:the\s+)?(.+?)(?:\s+for\s+|\s*[.,;])/i,
    // "reprimand to <entity>"
    /reprimand\s+(?:to|against|issued\s+to)\s+(?:the\s+)?(.+?)(?:\s+for\s+|\s*[.,;])/i,
    // "the respondent, <entity>,"
    /respondent[,\s]+(.+?)[,\s]+(?:for|was|is|had)/i,
    // "operator/company/organisation: <entity>"
    /(?:operator|company|organisation|entity|clinic|hospital|school)\s*[:-]\s*(.+?)(?:\s*[.,;(])/i,
    // "fine of €X on <entity>"
    /fine\s+of\s+\u20AC[\d,]+\s+on\s+(?:a\s+)?(.+?)(?:\s+for\s+|\s*[.,;])/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let name = match[1].trim();
      // Clean up common artifacts
      name = name.replace(/^(the|a|an)\s+/i, "");
      name = name.replace(/\s+/g, " ");
      if (name.length > 3 && name.length < 120) return name;
    }
  }

  return null;
}

/** Try to extract fine amount in EUR from text. */
function extractFineAmount(text: string): number | null {
  const patterns = [
    // "€9,000" or "€ 9,000" or "€9000"
    /\u20AC\s*([\d,]+(?:\.\d{2})?)/,
    // "EUR 9,000" or "9,000 EUR"
    /([\d,]+(?:\.\d{2})?)\s*EUR/i,
    /EUR\s*([\d,]+(?:\.\d{2})?)/i,
    // "9,000 euro" or "9000 euros"
    /([\d,]+(?:\.\d{2})?)\s*euro[s]?/i,
    // "fine of 9,000"
    /fine\s+of\s+\u20AC?\s*([\d,]+)/i,
    // "fined 9,000"
    /fined\s+\u20AC?\s*([\d,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const raw = match[1].replace(/,/g, "");
      const val = parseFloat(raw);
      if (Number.isFinite(val) && val > 0) return val;
    }
  }

  return null;
}

/** Classify decision type from text and URL slug. */
function classifyDecisionType(text: string, slug: string): string {
  const lower = text.toLowerCase();
  if (
    /\bfine\b|penalty|\u20AC\s*\d/.test(lower) ||
    /fine|penalty|sanction/.test(slug)
  ) {
    return "sanction";
  }
  if (/reprimand|warning/.test(lower)) return "warning";
  if (/order(?:ed)?\s+to|compliance\s+order|injunction/.test(lower))
    return "order";
  if (/prohibition|ban/.test(lower)) return "prohibition";
  return "decision";
}

/** Classify guideline type from text and URL slug. */
function classifyGuidelineType(_text: string, slug: string): string {
  if (/guidance|guide/.test(slug)) return "guide";
  if (/guideline/.test(slug)) return "guideline";
  if (/opinion/.test(slug)) return "opinion";
  if (/faq/.test(slug)) return "faq";
  if (/recommendation/.test(slug)) return "recommendation";
  if (/policy/.test(slug)) return "policy";
  if (/code-of-conduct/.test(slug)) return "code_of_conduct";
  if (/certification/.test(slug)) return "certification";
  if (/self-assessment/.test(slug)) return "tool";

  // Broader fallback for /for-organisations/ and /for-individuals/ sub-pages
  if (/\/for-organisations\//.test(slug)) return "guide";
  if (/\/for-individuals\//.test(slug)) return "guide";

  return "guide";
}

/** Assign topic IDs based on text content. */
function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: string[] = [];

  const topicSignals: [string, RegExp[]][] = [
    [
      "consent",
      [/\bconsent\b/i, /\bvalid\s+consent\b/i, /pre-ticked/i, /opt-in/i],
    ],
    [
      "cookies",
      [
        /\bcookie[s]?\b/i,
        /tracker[s]?\b/i,
        /tracking\s+technolog/i,
        /cookie\s+banner/i,
      ],
    ],
    [
      "transfers",
      [
        /international\s+transfer/i,
        /data\s+transfer/i,
        /third\s+countr/i,
        /adequacy\s+decision/i,
        /\bscc\b/i,
        /standard\s+contractual/i,
        /\bschrems\b/i,
        /\bbcr\b/i,
      ],
    ],
    [
      "dpia",
      [
        /data\s+protection\s+impact/i,
        /\bdpia\b/i,
        /impact\s+assessment/i,
        /high[- ]risk\s+processing/i,
      ],
    ],
    [
      "data_breach",
      [
        /data\s+breach/i,
        /breach\s+notification/i,
        /personal\s+data\s+breach/i,
        /72[- ]hour/i,
        /ransomware/i,
        /security\s+incident/i,
      ],
    ],
    [
      "data_subject_rights",
      [
        /right\s+of\s+access/i,
        /right\s+to\s+erasure/i,
        /right\s+to\s+rectif/i,
        /right\s+to\s+port/i,
        /right\s+to\s+object/i,
        /right\s+to\s+restrict/i,
        /data\s+subject\s+right/i,
        /subject\s+access\s+request/i,
      ],
    ],
    [
      "employee_monitoring",
      [
        /employee\s+monitor/i,
        /workplace\s+monitor/i,
        /\bgps\s+track/i,
        /\bgps\s+monitor/i,
        /fleet\s+management/i,
        /employee\s+data/i,
        /employment\s+sector/i,
        /employer/i,
      ],
    ],
    [
      "video_surveillance",
      [
        /\bcctv\b/i,
        /video\s+surveillance/i,
        /surveillance\s+camera/i,
        /camera\s+system/i,
      ],
    ],
    [
      "children",
      [
        /children/i,
        /child(?:ren)?'s\s+data/i,
        /minor[s]?\b/i,
        /parental\s+consent/i,
      ],
    ],
    [
      "direct_marketing",
      [
        /direct\s+marketing/i,
        /marketing\s+email/i,
        /unsolicited/i,
        /spam/i,
        /\bunsubscribe\b/i,
        /marketing\s+communication/i,
      ],
    ],
    [
      "health_data",
      [
        /health\s+data/i,
        /medical\s+data/i,
        /patient\s+record/i,
        /healthcare/i,
        /special\s+categor/i,
        /sensitive\s+data/i,
        /clinic/i,
      ],
    ],
    [
      "ai",
      [
        /artificial\s+intelligence/i,
        /\bai\s+act\b/i,
        /machine\s+learning/i,
        /automated\s+decision/i,
        /facial\s+recognition/i,
        /profiling/i,
      ],
    ],
  ];

  for (const [id, patterns] of topicSignals) {
    if (patterns.some((p) => p.test(lower))) {
      topics.push(id);
    }
  }

  return topics;
}

/** Generate a stable reference from a URL slug and date. */
function generateReference(
  url: string,
  date: string | null,
  prefix: string,
): string {
  const slug = url
    .replace(BASE_URL, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "-");
  const year = date ? date.slice(0, 4) : "XXXX";
  // Stable hash from slug for compact IDs
  const hash = slug
    .split("")
    .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0x7fffffff, 0);
  return `${prefix}-${year}-${hash.toString(16).padStart(5, "0").toUpperCase().slice(0, 5)}`;
}

/**
 * Try to extract a CDP reference from a PDF URL.
 * IDPC uses filenames like CDP_COMP_332_2024.pdf or CDP_960_2023.pdf.
 */
function extractCdpReference(pdfUrl: string): string | null {
  // CDP_COMP_332_2024.pdf or CDP_COMP_299_2024.pdf
  const compMatch = /CDP_COMP_(\d+)_(\d{4})/i.exec(pdfUrl);
  if (compMatch) {
    return `CDP/COMP/${compMatch[1]}/${compMatch[2]}`;
  }

  // CDP_960_2023.pdf (no COMP prefix)
  const simpleMatch = /CDP_(\d+)_(\d{4})/i.exec(pdfUrl);
  if (simpleMatch) {
    return `CDP/${simpleMatch[1]}/${simpleMatch[2]}`;
  }

  // CDP_FOI_21_2024.pdf
  const foiMatch = /CDP_FOI_(\d+)_(\d{4})/i.exec(pdfUrl);
  if (foiMatch) {
    return `CDP/FOI/${foiMatch[1]}/${foiMatch[2]}`;
  }

  return null;
}

/** Trim whitespace and collapse runs of blank lines. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract a summary from the first 1-3 sentences of body text. */
function extractSummary(text: string, maxLen = 500): string {
  // Split into sentences, take up to 3, stay within maxLen
  const sentences = text.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences.slice(0, 3)) {
    const candidate = summary ? `${summary} ${sentence}` : sentence;
    if (candidate.length > maxLen) break;
    summary = candidate;
  }
  return summary || text.slice(0, maxLen);
}

// ─── Database helpers ───────────────────────────────────────────────────────

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`  Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function ensureTopics(db: Database.Database): void {
  const topics = [
    {
      id: "consent",
      name_local: "Consent",
      name_en: "Consent",
      description:
        "Obtaining, validity, and withdrawal of consent for personal data processing (GDPR Art. 7).",
    },
    {
      id: "cookies",
      name_local: "Cookies and trackers",
      name_en: "Cookies and trackers",
      description:
        "Use of cookies and other trackers on users' devices (GDPR Art. 6, ePrivacy).",
    },
    {
      id: "transfers",
      name_local: "International data transfers",
      name_en: "International data transfers",
      description:
        "Transfer of personal data to third countries or international organisations (GDPR Art. 44-49).",
    },
    {
      id: "dpia",
      name_local: "Data Protection Impact Assessment",
      name_en: "Data Protection Impact Assessment (DPIA)",
      description:
        "Impact assessment for high-risk processing operations (GDPR Art. 35).",
    },
    {
      id: "data_breach",
      name_local: "Data breach notification",
      name_en: "Data breach notification",
      description:
        "Notification of personal data breaches to the IDPC and data subjects (GDPR Art. 33-34).",
    },
    {
      id: "data_subject_rights",
      name_local: "Data subject rights",
      name_en: "Data subject rights",
      description:
        "Exercise of access, rectification, erasure, and other rights (GDPR Art. 15-22).",
    },
    {
      id: "employee_monitoring",
      name_local: "Employee monitoring",
      name_en: "Employee monitoring",
      description:
        "Processing of employee data and monitoring in the workplace.",
    },
    {
      id: "video_surveillance",
      name_local: "Video surveillance",
      name_en: "Video surveillance",
      description:
        "Use of video surveillance systems and personal data protection (GDPR Art. 6).",
    },
    {
      id: "children",
      name_local: "Children's data",
      name_en: "Children's data",
      description:
        "Protection of minors' personal data in online services (GDPR Art. 8).",
    },
    {
      id: "direct_marketing",
      name_local: "Direct marketing",
      name_en: "Direct marketing",
      description:
        "Processing of personal data for direct marketing and electronic communications.",
    },
    {
      id: "health_data",
      name_local: "Health data",
      name_en: "Health data",
      description:
        "Processing of health data and special categories with enhanced protection (GDPR Art. 9).",
    },
    {
      id: "ai",
      name_local: "Artificial intelligence",
      name_en: "Artificial intelligence",
      description:
        "Data protection considerations in AI, automated decision-making, and profiling (GDPR Art. 22).",
    },
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const t of topics) {
      insert.run(t.id, t.name_local, t.name_en, t.description);
    }
  });
  tx();
}

// ─── Phase 3 & 4: Fetch + parse + insert ────────────────────────────────────

interface IngestStats {
  discovered: number;
  skipped_pattern: number;
  skipped_resume: number;
  decisions_inserted: number;
  decisions_updated: number;
  decisions_skipped_dup: number;
  guidelines_inserted: number;
  guidelines_skipped_dup: number;
  pdf_refs_recorded: number;
  fetch_errors: number;
  parse_errors: number;
  empty_content: number;
}

async function ingestPages(
  entries: SitemapEntry[],
  pdfLinks: string[],
  db: Database.Database | null,
  cli: CliArgs,
  state: CrawlState,
): Promise<IngestStats> {
  const stats: IngestStats = {
    discovered: entries.length,
    skipped_pattern: 0,
    skipped_resume: 0,
    decisions_inserted: 0,
    decisions_updated: 0,
    decisions_skipped_dup: 0,
    guidelines_inserted: 0,
    guidelines_skipped_dup: 0,
    pdf_refs_recorded: 0,
    fetch_errors: 0,
    parse_errors: 0,
    empty_content: 0,
  };

  const ingestedSet = new Set(state.ingested_urls);
  const newlyIngested: string[] = [];

  // Prepared statements (only if not dry-run)
  const insertDecision = db?.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGuideline = db?.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkDecisionRef = db?.prepare(
    "SELECT 1 FROM decisions WHERE reference = ? LIMIT 1",
  );

  const checkGuidelineRef = db?.prepare(
    "SELECT 1 FROM guidelines WHERE reference = ? LIMIT 1",
  );

  // Classify and filter
  interface ClassifiedEntry {
    url: string;
    lastmod: string | null;
    type: ContentType;
  }

  const classified: ClassifiedEntry[] = [];
  for (const entry of entries) {
    const type = classifyUrl(entry.url);
    if (type === "skip") {
      stats.skipped_pattern++;
      continue;
    }
    if (cli.resume && ingestedSet.has(entry.url)) {
      stats.skipped_resume++;
      continue;
    }
    classified.push({ ...entry, type });
  }

  // Sort: decisions first, then guidelines, then by date descending
  classified.sort((a, b) => {
    if (a.type !== b.type) return a.type === "decision" ? -1 : 1;
    return (b.lastmod ?? "").localeCompare(a.lastmod ?? "");
  });

  const toProcess = cli.limit ? classified.slice(0, cli.limit) : classified;

  console.log("\n=== Phase 3 & 4: Fetch and ingest ===");
  console.log(
    `  Classified: ${classified.length} pages (${classified.filter((e) => e.type === "decision").length} decisions, ${classified.filter((e) => e.type === "guideline").length} guidelines)`,
  );
  console.log(
    `  Processing: ${toProcess.length}${cli.limit ? ` (limited to ${cli.limit})` : ""}`,
  );
  console.log(`  Skipped by pattern: ${stats.skipped_pattern}`);
  console.log(`  Skipped by resume: ${stats.skipped_resume}`);
  console.log(`  PDF links discovered: ${pdfLinks.length}`);
  console.log("");

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i]!;
    const progress = `[${i + 1}/${toProcess.length}]`;

    console.log(`${progress} ${entry.type.toUpperCase()} ${entry.url}`);

    // Rate limit
    if (i > 0) await sleep(RATE_LIMIT_MS);

    let html: string;
    try {
      html = await fetchText(entry.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: Failed to fetch: ${msg}`);
      stats.fetch_errors++;
      continue;
    }

    let page: ParsedPage;
    try {
      page = parseIdpcPage(html, entry.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: Failed to parse: ${msg}`);
      stats.parse_errors++;
      continue;
    }

    // Skip pages with no meaningful content
    const text = cleanText(page.bodyText);
    if (text.length < 100) {
      console.log(`  SKIP: content too short (${text.length} chars)`);
      stats.empty_content++;
      continue;
    }

    const slug = entry.url.replace(BASE_URL, "").toLowerCase();
    const gdprArticles = extractGdprArticles(text);
    const topics = detectTopics(text);

    // Track any PDF links found on this page (CDP references)
    for (const pdfUrl of page.pdfLinks) {
      const cdpRef = extractCdpReference(pdfUrl);
      if (cdpRef) {
        console.log(`  -> PDF reference: ${cdpRef} (${pdfUrl})`);
        stats.pdf_refs_recorded++;
      }
    }

    if (entry.type === "decision") {
      const ref = generateReference(entry.url, page.date, "IDPC-DEC");
      const entityName = extractEntityName(text);
      const fineAmount = extractFineAmount(text);
      const decisionType = classifyDecisionType(text, slug);
      const summary = extractSummary(text);

      console.log(
        `  -> Decision: ref=${ref}, type=${decisionType}, entity=${entityName ?? "(unknown)"}, fine=${fineAmount ?? "none"}, topics=[${topics.join(", ")}]`,
      );

      if (!cli.dryRun && db) {
        const existing = checkDecisionRef?.get(ref);
        if (existing) {
          console.log(`  SKIP: duplicate reference ${ref}`);
          stats.decisions_skipped_dup++;
        } else {
          insertDecision?.run(
            ref,
            page.title,
            page.date,
            decisionType,
            entityName,
            fineAmount,
            summary,
            text,
            JSON.stringify(topics),
            JSON.stringify(gdprArticles),
            "final",
          );
          stats.decisions_inserted++;
        }
      } else {
        stats.decisions_inserted++;
      }
    } else {
      // guideline
      const ref = generateReference(entry.url, page.date, "IDPC-GUIDE");
      const guideType = classifyGuidelineType(text, slug);
      const summary = extractSummary(text);

      console.log(
        `  -> Guideline: ref=${ref}, type=${guideType}, topics=[${topics.join(", ")}]`,
      );

      if (!cli.dryRun && db) {
        const existing = checkGuidelineRef?.get(ref);
        if (existing) {
          console.log(`  SKIP: duplicate reference ${ref}`);
          stats.guidelines_skipped_dup++;
        } else {
          insertGuideline?.run(
            ref,
            page.title,
            page.date,
            guideType,
            summary,
            text,
            JSON.stringify(topics),
            "en",
          );
          stats.guidelines_inserted++;
        }
      } else {
        stats.guidelines_inserted++;
      }
    }

    // Track ingested URL
    newlyIngested.push(entry.url);

    // Save state periodically (every 10 pages) for resume support
    if (newlyIngested.length % 10 === 0) {
      state.ingested_urls.push(...newlyIngested.splice(0));
      state.last_run = new Date().toISOString();
      saveState(state);
    }
  }

  // Save final state
  if (newlyIngested.length > 0) {
    state.ingested_urls.push(...newlyIngested);
  }
  state.last_run = new Date().toISOString();
  state.decisions_count += stats.decisions_inserted;
  state.guidelines_count += stats.guidelines_inserted;
  saveState(state);

  return stats;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseArgs();

  console.log("IDPC Ingestion Crawler -- idpc.org.mt");
  console.log(
    `  Options: dryRun=${cli.dryRun}, resume=${cli.resume}, force=${cli.force}, limit=${cli.limit ?? "all"}`,
  );
  console.log(`  DB path: ${DB_PATH}`);

  // Validate incompatible flags
  if (cli.force && cli.resume) {
    console.error("ERROR: --force and --resume are incompatible. Pick one.");
    process.exit(1);
  }

  // Load resume state
  const state = cli.resume
    ? loadState()
    : {
        ingested_urls: [],
        last_run: "",
        decisions_count: 0,
        guidelines_count: 0,
      };

  if (cli.resume && state.ingested_urls.length > 0) {
    console.log(
      `  Resuming: ${state.ingested_urls.length} URLs already ingested (last run: ${state.last_run})`,
    );
  }

  // Init DB (skip in dry-run)
  let db: Database.Database | null = null;
  if (!cli.dryRun) {
    db = initDb(cli.force);
    ensureTopics(db);
    console.log("  Database initialised");
  }

  // Phase 1: discover URLs from sitemaps
  const sitemapEntries = await discoverSitemapUrls();

  // Phase 2: discover additional decision pages from listing pages
  const { pageLinks: listingPageLinks, pdfLinks } =
    await discoverDecisionListingLinks();

  // Merge sitemap entries with listing page links (deduplicate)
  const allEntries = [...sitemapEntries];
  const sitemapUrls = new Set(sitemapEntries.map((e) => e.url));
  let addedFromListing = 0;
  for (const link of listingPageLinks) {
    if (!sitemapUrls.has(link.url)) {
      allEntries.push(link);
      addedFromListing++;
    }
  }
  if (addedFromListing > 0) {
    console.log(
      `\n  Added ${addedFromListing} additional URLs from decision listings`,
    );
  }
  console.log(`  Total URLs to classify: ${allEntries.length}`);

  // Phase 3 & 4: fetch, parse, and insert
  const stats = await ingestPages(allEntries, pdfLinks, db, cli, state);

  // Print summary
  console.log("\n=== Ingestion Summary ===\n");
  console.log(`  URLs discovered:        ${stats.discovered}`);
  console.log(`  Skipped (pattern):      ${stats.skipped_pattern}`);
  console.log(`  Skipped (resume):       ${stats.skipped_resume}`);
  console.log(`  Decisions inserted:     ${stats.decisions_inserted}`);
  console.log(`  Decisions skipped dup:  ${stats.decisions_skipped_dup}`);
  console.log(`  Guidelines inserted:    ${stats.guidelines_inserted}`);
  console.log(`  Guidelines skipped dup: ${stats.guidelines_skipped_dup}`);
  console.log(`  PDF refs recorded:      ${stats.pdf_refs_recorded}`);
  console.log(`  Empty content:          ${stats.empty_content}`);
  console.log(`  Fetch errors:           ${stats.fetch_errors}`);
  console.log(`  Parse errors:           ${stats.parse_errors}`);

  if (!cli.dryRun && db) {
    const dc = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const gc = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;
    const tc = (
      db.prepare("SELECT count(*) as cnt FROM topics").get() as {
        cnt: number;
      }
    ).cnt;
    console.log(
      `\n  Database totals: ${dc} decisions, ${gc} guidelines, ${tc} topics`,
    );
    db.close();
  }

  console.log(`\n  State saved to ${STATE_PATH}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

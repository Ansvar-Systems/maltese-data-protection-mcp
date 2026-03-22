/**
 * Seed the IDPC database with sample decisions and guidelines for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["IDPC_DB_PATH"] ?? "data/idpc.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface TopicRow { id: string; name_local: string; name_en: string; description: string; }

const topics: TopicRow[] = [
  { id: "cookies", name_local: "Cookies and trackers", name_en: "Cookies and trackers", description: "Use of cookies and other trackers on users' devices (GDPR Art. 6)." },
  { id: "employee_monitoring", name_local: "Employee monitoring", name_en: "Employee monitoring", description: "Processing of employee data and monitoring in the workplace." },
  { id: "video_surveillance", name_local: "Video surveillance", name_en: "Video surveillance", description: "Use of video surveillance systems and personal data protection (GDPR Art. 6)." },
  { id: "data_breach", name_local: "Data breach notification", name_en: "Data breach notification", description: "Notification of personal data breaches to the IDPC and data subjects (GDPR Art. 33–34)." },
  { id: "consent", name_local: "Consent", name_en: "Consent", description: "Obtaining, validity, and withdrawal of consent for personal data processing (GDPR Art. 7)." },
  { id: "dpia", name_local: "Data Protection Impact Assessment", name_en: "Data Protection Impact Assessment (DPIA)", description: "Impact assessment for high-risk processing operations (GDPR Art. 35)." },
  { id: "transfers", name_local: "International data transfers", name_en: "International data transfers", description: "Transfer of personal data to third countries or international organisations (GDPR Art. 44–49)." },
  { id: "data_subject_rights", name_local: "Data subject rights", name_en: "Data subject rights", description: "Exercise of access, rectification, erasure and other rights (GDPR Art. 15–22)." },
];

const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)");
for (const t of topics) { insertTopic.run(t.id, t.name_local, t.name_en, t.description); }
console.log(`Inserted ${topics.length} topics`);

interface DecisionRow {
  reference: string; title: string; date: string; type: string;
  entity_name: string; fine_amount: number | null; summary: string;
  full_text: string; topics: string; gdpr_articles: string; status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "IDPC-2022-004",
    title: "IDPC Decision on Cookie Consent Violations",
    date: "2022-07-18",
    type: "sanction",
    entity_name: "E-commerce operator",
    fine_amount: 9000,
    summary: "The IDPC imposed a €9,000 fine on an e-commerce operator for deploying advertising and analytics cookies without prior user consent and providing no simple opt-out mechanism.",
    full_text: "The Information and Data Protection Commissioner conducted an investigation following complaints from users about cookie practices on the respondent's website. The investigation found that the operator activated advertising and analytics cookies immediately when a user visited the site, before any consent had been provided. The cookie banner offered a prominent accept button but the reject option required navigating through multiple sub-menus. The IDPC found: 1) non-essential cookies were activated before obtaining consent; 2) the opt-out process was disproportionately complex compared to opt-in; 3) descriptions of cookie purposes were vague and insufficient. The operator was fined €9,000 and required to remediate within 60 days.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
  {
    reference: "IDPC-2022-011",
    title: "IDPC Decision on GPS Employee Monitoring",
    date: "2022-11-03",
    type: "sanction",
    entity_name: "Logistics company",
    fine_amount: 14000,
    summary: "The IDPC imposed a €14,000 fine on a logistics company for continuous GPS tracking of employees during and outside working hours, breaching the proportionality principle under the GDPR.",
    full_text: "The IDPC received employee complaints regarding continuous GPS tracking via a fleet management system. The investigation revealed: 1) GPS tracking was active 24 hours a day, 7 days a week, including outside working hours and on weekends; 2) employees had not been adequately informed prior to deployment of the system about the scope and purpose of data collection; 3) location data was stored for 2 years without justification. The IDPC held that GPS tracking of employees is only lawful during working hours and for specific legitimate purposes. Continuous tracking outside working hours represents a disproportionate intrusion into private life. The company was fined €14,000.",
    topics: JSON.stringify(["employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "IDPC-2023-003",
    title: "IDPC Decision on Delayed Data Breach Notification",
    date: "2023-03-10",
    type: "sanction",
    entity_name: "Healthcare clinic",
    fine_amount: 25000,
    summary: "The IDPC imposed a €25,000 fine on a healthcare clinic for delayed and incomplete notification of a data breach affecting approximately 6,000 patient records.",
    full_text: "A healthcare clinic experienced a ransomware attack that resulted in the compromise of approximately 6,000 patient records including names, contact details, and medical history. The IDPC found: 1) the breach notification to the IDPC was submitted 9 days after discovery, well beyond the 72-hour deadline; 2) the notification was incomplete, lacking the categories of data affected, the approximate number of individuals, and a risk assessment; 3) affected patients were not notified despite the high risk posed by the medical nature of the data exposed. The IDPC fined the clinic €25,000 and noted that healthcare data requires heightened protection given its sensitive nature.",
    topics: JSON.stringify(["data_breach"]),
    gdpr_articles: JSON.stringify(["33", "34"]),
    status: "final",
  },
  {
    reference: "IDPC-2023-016",
    title: "IDPC Decision on CCTV in Employee Rest Areas",
    date: "2023-07-12",
    type: "warning",
    entity_name: "Retail chain",
    fine_amount: null,
    summary: "The IDPC issued a reprimand to a retail chain for placing CCTV cameras in employee changing rooms and break rooms, and for failing to provide adequate information about the monitoring.",
    full_text: "The IDPC carried out planned inspections at retail chain premises and discovered CCTV cameras installed in employee changing rooms and break rooms. This constitutes a serious breach of the proportionality principle — there is no legitimate basis for surveillance of employees in such private spaces. The IDPC also found that employees had not been properly informed of the camera locations or the extent of data collected. The IDPC issued a reprimand and ordered the company to: 1) immediately remove all cameras from employee rest areas and changing rooms; 2) review its CCTV policy and bring it into compliance with the GDPR; 3) provide employees with clear written notice regarding any remaining monitoring arrangements.",
    topics: JSON.stringify(["video_surveillance", "employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "IDPC-2023-028",
    title: "IDPC Decision on Direct Marketing Without Valid Consent",
    date: "2023-10-20",
    type: "sanction",
    entity_name: "Insurance broker",
    fine_amount: 11000,
    summary: "The IDPC imposed an €11,000 fine on an insurance broker for sending marketing emails to individuals without valid consent and for making opt-out disproportionately difficult.",
    full_text: "The IDPC investigated complaints from multiple consumers who received unsolicited marketing emails from an insurance broker. The investigation found: 1) the broker sent marketing communications to individuals who had not given explicit, affirmative consent — consent was obtained through pre-ticked boxes on a registration form; 2) the unsubscribe mechanism was buried in the email footer in small font; 3) several consumers reported that emails continued for weeks after they had unsubscribed. The IDPC held that consent for marketing must be given through a clear, affirmative act and that pre-ticked boxes do not satisfy this requirement. The company was fined €11,000.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`INSERT OR IGNORE INTO decisions (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertDecisionsAll = db.transaction(() => { for (const d of decisions) { insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status); } });
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface GuidelineRow { reference: string | null; title: string; date: string; type: string; summary: string; full_text: string; topics: string; language: string; }

const guidelines: GuidelineRow[] = [
  {
    reference: "IDPC-GUIDE-COOKIES-2022",
    title: "Guidelines on the Use of Cookies and Similar Technologies",
    date: "2022-04-01",
    type: "guide",
    summary: "IDPC guidelines on cookies and tracking technologies under the GDPR and the Electronic Communications (Regulation) Act. Covers consent, information requirements, and opt-out mechanisms.",
    full_text: "These guidelines explain the rules governing the use of cookies and similar technologies in Malta. Key requirements: 1) Consent before non-essential cookies — advertising and analytics cookies require prior, freely given, specific, informed, and unambiguous consent; strictly necessary cookies are exempt; 2) No cookie walls — access to services may not be made conditional on cookie consent without a genuine alternative; 3) Equal prominence — the option to reject must be presented as prominently as the option to accept; 4) Information — users must be given clear information on the identity of cookie operators, purposes, and duration; 5) Withdrawal — consent must be as easy to withdraw as to give; 6) Proof — controllers must maintain records of consent.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "en",
  },
  {
    reference: "IDPC-GUIDE-DPIA-2021",
    title: "Guidance on Data Protection Impact Assessments",
    date: "2021-10-01",
    type: "guide",
    summary: "IDPC guidance on conducting Data Protection Impact Assessments (DPIAs) under Article 35 of the GDPR. Covers when a DPIA is required, methodology, and documentation.",
    full_text: "A Data Protection Impact Assessment (DPIA) is required under Article 35 of the GDPR where processing is likely to result in a high risk to the rights and freedoms of individuals. DPIAs are mandatory for: large-scale processing of special categories of data; systematic monitoring of a publicly accessible area; processing resulting in automated decisions with legal or similarly significant effects. The IDPC recommends a three-stage approach: 1) Describe the processing — data categories, purposes, recipients, transfers, retention, security measures; 2) Assess necessity and proportionality — lawful basis, data minimisation, purpose limitation, rights of individuals; 3) Manage the risks — identify privacy threats, assess likelihood and severity, implement supplementary measures. The DPIA must be documented and reviewed when the processing changes. The IDPC must be consulted where residual risks remain high after mitigation.",
    topics: JSON.stringify(["dpia"]),
    language: "en",
  },
  {
    reference: "IDPC-GUIDE-RIGHTS-2022",
    title: "Guide on Data Subject Rights Under the GDPR",
    date: "2022-08-01",
    type: "guide",
    summary: "IDPC guide on how organisations must handle data subject rights requests under the GDPR, including timelines, exemptions, and practical procedures.",
    full_text: "The GDPR grants individuals significant rights over the processing of their personal data. Organisations must have clear procedures for handling rights requests. Key rights: 1) Right of access (Art. 15) — individuals may request confirmation of processing and a copy of their data; response due within 1 month, extendable by 2 months for complex requests; 2) Right to rectification (Art. 16) — inaccurate data must be corrected without undue delay; 3) Right to erasure (Art. 17) — data must be deleted where no longer necessary, consent is withdrawn, or the individual objects and there are no overriding grounds; 4) Right to restriction (Art. 18) — processing may be restricted pending rectification or while an objection is considered; 5) Right to data portability (Art. 20) — where processing is based on consent or contract, individuals may receive their data in a machine-readable format; 6) Right to object (Art. 21) — individuals may object to processing for direct marketing (absolute right) or based on legitimate interests. Organisations must not charge for responding to requests and must not require excessive information to verify identity.",
    topics: JSON.stringify(["data_subject_rights"]),
    language: "en",
  },
];

const insertGuideline = db.prepare(`INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertGuidelinesAll = db.transaction(() => { for (const g of guidelines) { insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language); } });
insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

const dc = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const gc = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
const tc = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
console.log(`\nDatabase summary:\n  Topics: ${tc}\n  Decisions: ${dc}\n  Guidelines: ${gc}\n\nDone. Database ready at ${DB_PATH}`);
db.close();

# Data Coverage

This document describes the data coverage of the Maltese Data Protection MCP server.

## Summary

| Category   | Count | Last Ingested  | Source              |
|------------|-------|----------------|---------------------|
| Decisions  | 20    | 2026-03-23     | https://idpc.org.mt/ |
| Guidelines | 55    | 2026-03-23     | https://idpc.org.mt/ |

## Data Source

**IDPC — Information and Data Protection Commissioner**
- URL: https://idpc.org.mt/
- Jurisdiction: Malta
- Language: English

## Decisions

20 IDPC decisions, sanctions, warnings, and reprimands are currently indexed. Coverage includes:

- Sanctions with administrative fines
- Formal warnings issued to controllers and processors
- Reprimands for GDPR violations
- IDPC decisions on data subject complaint investigations

## Guidelines

55 IDPC guidance documents are currently indexed. Coverage includes:

- Guidance notes and FAQs on specific topics (cookies, DPIA, data subject rights, etc.)
- IDPC publications and recommendations
- Sector-specific guidance (employment, healthcare, online services)
- EDPB guidelines republished by IDPC
- Data protection impact assessment templates

## Topics Covered

| Topic ID              | Description                          |
|-----------------------|--------------------------------------|
| cookies               | Cookies and tracking technologies    |
| employee_monitoring   | Employee monitoring and surveillance |
| video_surveillance    | CCTV and video surveillance          |
| data_breach           | Data breach notification and response|
| consent               | Conditions for valid consent         |
| dpia                  | Data Protection Impact Assessments   |
| transfers             | International data transfers         |
| data_subject_rights   | Data subject rights (access, erasure, etc.) |

## Freshness

Data is ingested periodically from the IDPC website. The `mt_dp_check_data_freshness` tool returns the exact timestamp of the last ingest run and current record counts.

A GitHub Actions workflow (`check-freshness.yml`) runs weekly and fails if data is older than 30 days.

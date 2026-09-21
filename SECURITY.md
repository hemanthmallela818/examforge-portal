# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Contact the project owner through a private, access-controlled channel and include:

- the affected version or commit;
- the smallest reproducible sequence;
- the expected and observed authorization boundary;
- sanitized logs or screenshots; and
- the possible impact.

Never include passwords, access tokens, refresh tokens, service-role keys, database credentials, TOTP secrets, candidate answers, or personal information. Revoke any credential that was accidentally exposed before continuing the report.

## High-priority issues

Treat any of these as urgent:

- answer-key or pre-start paper disclosure;
- cross-candidate access to sessions, responses, or results;
- administrator actions possible without a current AAL2 session;
- bypass of server-owned timing, grading, lifecycle, or immutable-result controls;
- public access to private `exam-assets` objects;
- public account creation or privilege escalation;
- credential or personal-data exposure; or
- a way to create duplicate or conflicting academic records.

## Safe handling

Test only against the isolated local stack or an explicitly disposable staging project. Do not test destructive behavior against production or real candidate data. Store secrets only in approved environment/secret stores, never in the repository or a `VITE_` variable.

The maintainers should acknowledge a private report, preserve evidence, rotate exposed credentials, assess affected data and exams, prepare a forward-only correction, and follow the incident and recovery procedures in `docs/OPERATIONS_AND_DISASTER_RECOVERY.md`.

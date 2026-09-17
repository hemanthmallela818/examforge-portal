# CBT Operations, Backup & Disaster Recovery Guide

## 1. Overview & Architecture Invariants

The Computer Based Test (CBT) portal relies on an authoritative, server-owned state model hosted on PostgreSQL (Supabase). This document defines operational standards for backups, monitoring, disaster recovery, and student exam continuity.

### Core Guarantees:
- **Server-Authoritative Evaluation**: All grading occurs in PostgreSQL via `submit_exam`. Private answer keys are never delivered to the candidate browser.
- **AAL2 Administrative Security**: All administrative actions and operational APIs require mandatory TOTP Multi-Factor Authentication.
- **Offline & Reconnection Resilience**: Student responses are synchronized to `active_sessions` and also kept in account-bound browser storage (`cbt_recovery_*`). Browser storage is not encrypted; shared exam devices must use managed OS accounts, disk encryption, and a post-exam data-clearing procedure.

---

## 2. Backup & Point-in-Time Recovery (PITR)

### 2.1 Logical Database Backups (`pg_dump`)
Automated daily logical backups must be taken before and after active testing windows.

```bash
# Full schema + data dump excluding private JWT secrets
pg_dump -h <SUPABASE_DB_HOST> \
        -U postgres \
        -d postgres \
        -F c \
        -b \
        -v \
        -f "cbt_backup_$(date +%Y%m%d_%H%M%S).dump"
```

### 2.2 Physical Point-in-Time Recovery (PITR)
- In production, enable physical Write-Ahead Logging (WAL) archiving with a minimum **7-day PITR retention window**.
- In the event of catastrophic data corruption or accidental table modification, restore to the exact timestamp immediately preceding the incident:
  1. Navigate to the Supabase project dashboard -> **Database** -> **Backups**.
  2. Select **Point in Time**.
  3. Specify target recovery point (e.g. `2026-09-10 14:15:00 UTC`).
  4. Initiate clone/restore to staging before pointing DNS/application traffic.

### 2.3 Storage Bucket Assets (`exam-assets`)
- The `exam-assets` bucket stores all question figures and option diagrams.
- Image files are named with cryptographically secure UUIDs (`questions/<uuid>.jpg`).
- Use the AWS CLI or Supabase storage CLI to synchronize bucket snapshots:
```bash
aws s3 sync s3://exam-assets s3://cbt-backup-vault/exam-assets-$(date +%Y%m%d)/
```

### 2.4 Repeatable Local Restore Proofs

The repository includes local-only recovery checks. They refuse remote Supabase hosts and clean up their temporary restore artifacts:

```bash
npm run ops:prove-restore:local
npm run ops:prove-storage-restore:local
```

The database proof creates a custom logical dump, restores it into a uniquely named temporary database, compares counts and content digests for critical application relations, verifies the public constraint state, and then drops the temporary database. Managed owner and ACL metadata are intentionally omitted during the portable restore; schema permissions are rebuilt from the reviewed migration history.

The Storage proof exports a temporary object from the private `exam-assets` bucket, verifies its SHA-256 hash, removes and restores it, confirms anonymous reads remain denied and signed reads succeed, and cleans up the object.

Passing locally is not the production restore drill. Repeat both procedures in an isolated staging recovery project using an actual production-format backup, measure recovery point/time objectives, verify object counts and representative signed downloads, and record the responsible operator before launch.

---

## 3. Disaster Recovery & Emergency Runbooks

### Runbook 1: Campus-Wide Internet Outage During Active Exam
**Symptom**: Candidates see `"Network Connection Lost"` banner on top of the exam screen.
1. **Candidate Instructions**: Instruct candidates **NOT** to close browser tabs. The application automatically falls back to offline caching in `localStorage`.
2. **Timer Continuity**: Time calculation uses the immutable server deadline (`sessionEndTimeRef`). Sleep and network drops do not award extra time.
3. **Recovery on Reconnection**:
   - Once connectivity is restored, candidates can continue answering.
   - When the candidate clicks "Submit", pending offline answers are synchronized to the server.
4. **Permanent Offline Scenario**:
   - If connectivity cannot be restored before the deadline, candidates' saved answers remain in `localStorage` under `cbt_recovery_<studentId>_<examId>`.
   - Keep the same device and browser profile powered on and preserve it for incident handling. The current application has no administrator export tool for browser-local records, and those records do not follow the student to another device.
   - Reconnect that same device before the server grace window ends. After the grace window, the server finalizes only its last confirmed response snapshot; an invigilator must document the incident under the institution's approved retake policy.

### Runbook 2: Candidate Machine Hardware Failure / Power Cut
**Symptom**: Candidate's computer crashes or loses power.
1. Seat the student at a backup workstation.
2. The student signs in with their standard `student_id` and credentials.
3. The server restores the exact jumbled questions and server-confirmed responses while the attempt remains valid. Answers that existed only in the failed device's browser cannot be recovered on the replacement workstation.
4. Signing in on the replacement device automatically claims the single active session and invalidates the earlier device. The portal records a `STUDENT_SESSION_TAKEOVER` audit event without session identifiers or exam content. Record the swap, verify the remaining server time, and follow the approved invigilator/retake policy if unconfirmed work was lost.

### Runbook 3: Unreferenced Storage Asset Purge
**Symptom**: Storage capacity warnings or orphaned test images.
1. Sign in to the Admin Portal with TOTP MFA (AAL2).
2. Navigate to **Operations & Audit** tab.
3. Click **Scan Unreferenced Assets**.
4. Review the detected orphaned files (assets uploaded during question drafts but never saved or committed to an exam).
5. Click **Purge Unreferenced Files**. The Storage API re-checks references, removes object bytes and metadata, then records an audit event. This is a guarded multi-step operation, not a single database transaction; rescan afterward and investigate any partial-failure message.

---

## 4. Monitoring & Telemetry

### 4.1 Automated CLI Health Checks
Run the operational health script periodically or integrate with monitoring agents (e.g. Datadog, Prometheus, CloudWatch):
```bash
# Human-readable status
node scripts/operational-health-check.mjs

# Machine-readable JSON output for automated alerts
node scripts/operational-health-check.mjs --json
```

### 4.2 Key Health Metrics to Monitor
| Metric | Healthy Range | Alert Threshold | Action |
| :--- | :--- | :--- | :--- |
| `expired_sessions_pending_finalization` | `0` | `> 5` | Run `admin_finalize_expired_sessions` |
| `questions_missing_required_media` | `0` | `> 0` | Check preflight validation before activating exams |
| `unreferenced_storage_assets` | `< 50` | `> 200` | Trigger storage maintenance cleanup |
| `db_size_bytes` | `< 400 MB` | `> 450 MB` | Clean up question bank drafts / archive old classes |
| Client Incident Rate | `0/min` | `> 5/min` | Inspect client incident logs (`[CLIENT_INCIDENT]`) |

---

## 5. Security & Access Control Maintenance

### Administrator MFA Key Rotation
If an administrator loses their TOTP device:
1. A separately authorized recovery operator verifies the administrator's identity using the institution's documented out-of-band process.
2. Use the supported Supabase Dashboard or server-side Auth Admin MFA unenrollment API to remove only the verified factor. Do not modify `auth.mfa_factors` with direct SQL.
3. Revoke the administrator's existing sessions, require password reset where policy demands it, and record the recovery incident.
4. On next sign-in, require fresh TOTP enrollment and AAL2 verification before restoring dashboard access.

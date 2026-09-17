# Administrator Multi-Factor Authentication (TOTP) Recovery Runbook

This document defines the emergency recovery and device replacement procedures for administrative accounts in the Computer-Based Testing (CBT) portal.

> [!IMPORTANT]
> This runbook contains operational workflows and commands only. Never store, transmit, or commit credentials, TOTP secrets, passwords, or service-role keys into version control or documentation.

---

## 1. Architecture & Security Invariants

1. **Mandatory MFA (AAL2) Enforcement**:
   - Every administrative database mutation (exam updates, question bank, class management, student deletion) and data access (private exam answers, student results) strictly requires an `aal = 'aal2'` JWT claim.
   - Even if an administrator account's primary password is leaked, an attacker cannot mutate exams or read answer keys without completing TOTP verification.

2. **Zero Auto-Deletion of Verified Factors**:
   - The application automatically cleans up stale *unverified* enrollment factors upon cancellation or subsequent login.
   - *Verified* factors are immutable from the browser and can only be unenrolled by an active, verified AAL2 administrator or by the system owner via the server-side service-role API.

---

## 2. Emergency Recovery Scenarios

### Scenario A: Administrator Lost Authenticator Device (Phone Damaged / Lost)

If an administrator loses their authenticator device, their account is locked at `aal1` (password authenticated, but unable to produce TOTP challenge codes).

#### Preparation: Secondary Emergency Administrator (Recommended)
Organizations should always maintain at least **two** active, verified administrator accounts:
1. The secondary administrator logs in using their password and TOTP authenticator (achieving `aal2`).
2. This keeps administrative operations available while an authorized system owner resets the affected account using the procedure below.
3. The current portal does not provide one administrator with the ability to reset another administrator's factors.

#### Resolution Method 2: System Owner Service-Role Reset
If the organization only has one administrator account or all administrators lost their devices:
1. The authorized DevOps / Infrastructure engineer logs into the secure server environment where `SUPABASE_SERVICE_ROLE_KEY` is securely injected via environment variables.
2. From this project directory, run the following command. Node must load the installed npm package; `jsr:` imports are not supported by Node:
   ```bash
   node --input-type=module -e "import { createClient } from '@supabase/supabase-js'; const userId = process.argv[1]; if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('User ID, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required'); const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); const { data, error } = await client.auth.admin.mfa.listFactors({ userId }); if (error) throw error; for (const factor of data.factors) { const { error: deleteError } = await client.auth.admin.mfa.deleteFactor({ userId, id: factor.id }); if (deleteError) throw deleteError; } console.log('MFA factors cleared for', userId);" "<TARGET_ADMIN_USER_ID>"
   ```
3. The administrator logs into the portal using their standard password.
4. The application detects zero factors and immediately initiates mandatory enrollment with a fresh QR code and secret.

---

### Scenario B: Replacement Authenticator Enrollment (Upgrading / Changing Phones)

The current portal does not include a factor-management panel. Before retiring an old device, keep another verified administrator available, then have the authorized system owner use the service-role procedure above. The administrator can then sign in and enroll the replacement device. Never delete the last usable factor until the recovery path has been tested.

---

### Scenario C: Unverified Factor Cleanup

If an administrator began enrollment but accidentally closed the browser, lost connection, or clicked "Cancel":
- Upon cancellation, the portal immediately calls `supabase.auth.mfa.unenroll()` on the unverified factor before signing out.
- On the next login, the portal automatically inspects all factors: any factor with status `'unverified'` is safely removed before a new enrollment is initiated.
- Verified factors are never affected by this cleanup.

---

### Scenario D: Time Drift / Desynchronization Issues

TOTP codes rely on accurate time synchronization between the mobile device and the Supabase Auth server:
1. Verify that the mobile device's time is set to **Automatic / Network-provided time**.
2. If codes are rejected, verify clock skew on the device (clock drift of >30 seconds will cause codes to fall outside the acceptable window).
3. If issues persist, test against a newly generated 30-second window code.

---

## 3. Best Practices Checklist

- [ ] Maintain at least **two** distinct institutional administrator accounts with verified TOTP on separate physical devices.
- [ ] Store break-glass service-role credentials only in secure secrets vaults (e.g. AWS Secrets Manager, GCP Secret Manager), never on developer machines or in Git.
- [ ] Periodically test the secondary administrator login to verify factor health prior to major exam cycles.

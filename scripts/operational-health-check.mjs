#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from '../e2e/support/local-supabase.mjs';

const localMode = process.argv.includes('--local');
const local = localMode ? readLocalSupabase() : null;
const url = local?.url || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = local?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
CBT Operational Health Check CLI
Usage: node scripts/operational-health-check.mjs [options]

Environment Variables:
  SUPABASE_URL               Supabase instance URL
  SUPABASE_SERVICE_ROLE_KEY  Service role key for administrative health checks
  VITE_SUPABASE_URL          Fallback project URL only

Options:
  --local                    Read credentials only from the local Supabase CLI
  --json                     Output structured JSON for monitoring agents
  --help, -h                 Show this help message
`);
  process.exit(0);
}

const asJson = process.argv.includes('--json');

const emitResult = (result, exitCode = 0) => {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\n========================================');
    console.log(`CBT SYSTEM HEALTH STATUS: ${result.status}`);
    console.log(`Checked at: ${result.timestamp}`);
    console.log('========================================');
    if (result.metrics) {
      console.log('\nOperational Metrics:');
      for (const [k, v] of Object.entries(result.metrics)) {
        console.log(`  - ${k}: ${v}`);
      }
    }
    if (result.issues && result.issues.length > 0) {
      console.log('\n⚠️  Issues Detected:');
      result.issues.forEach(issue => console.log(`  - ${issue}`));
    } else {
      console.log('\n✓ No critical operational issues detected.');
    }
    console.log('========================================\n');
  }
  process.exitCode = exitCode;
};

if (!url || !key) {
  emitResult({
    status: 'OFFLINE_CONFIG_MISSING',
    timestamp: new Date().toISOString(),
    error: 'SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY must be set.',
    issues: ['Missing database connection configuration.']
  }, 1);
} else {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
  const issues = [];
  const metrics = {};

  // 1. Check RPC operational health if available
  const { data: healthData, error: healthError } = await client.rpc('admin_operational_health');
  if (healthError) {
    issues.push(`Authoritative operational health check failed: ${healthError.message}`);
  } else if (healthData) {
    Object.assign(metrics, {
      activeExams: healthData.active_exams,
      liveSessions: healthData.live_sessions,
      expiredSessionsPending: healthData.expired_sessions_pending_finalization,
      questionsMissingMedia: healthData.questions_missing_required_media,
      inactiveStudents: healthData.inactive_students,
      recentAuditEvents: healthData.audit_events_last_24_hours
    });

    if (healthData.expired_sessions_pending_finalization > 0) {
      issues.push(`${healthData.expired_sessions_pending_finalization} expired examination attempt(s) require finalization.`);
    }
    if (healthData.questions_missing_required_media > 0) {
      issues.push(`${healthData.questions_missing_required_media} question(s) require diagram uploads.`);
    }
  }

  // 2. Scan for unreferenced storage assets if permitted
  const { data: assetData, error: assetError } = await client.rpc('get_unreferenced_exam_assets');
  if (assetError) {
    issues.push(`Storage integrity scan failed: ${assetError.message}`);
  } else if (Array.isArray(assetData)) {
    metrics.unreferencedStorageAssets = assetData.length;
    if (assetData.length > 50) {
      issues.push(`${assetData.length} unreferenced storage files in exam-assets bucket. Storage cleanup recommended.`);
    }
  }

  const isHealthy = issues.length === 0;
  emitResult({
    status: isHealthy ? 'HEALTHY' : 'ATTENTION_REQUIRED',
    timestamp: new Date().toISOString(),
    metrics,
    issues
  }, isHealthy ? 0 : 1);

  } catch (err) {
    emitResult({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: err.message,
      issues: [`Unexpected runtime exception during check: ${err.message}`]
    }, 1);
  }
}

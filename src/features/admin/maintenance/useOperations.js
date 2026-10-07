import { useCallback, useEffect, useRef, useState } from 'react';
import { customAlert, customConfirm, showToast } from '../../../utils';
import { supabase } from '../../../supabase';

/**
 * Row of `admin_audit_events`.
 * @typedef {object} AuditEvent
 * @property {string | number} id
 * @property {string | null} actor_user_id
 * @property {string} action
 * @property {string | null} target_type
 * @property {string | null} target_id
 * @property {import('../../../types').UntrustedInput} metadata
 * @property {string} occurred_at
 */

/**
 * Row of `get_unreferenced_exam_assets` (storage object in the `exam-assets` bucket).
 * @typedef {{ name?: string | null, metadata?: { size?: number } | null }} UnreferencedAsset
 */

/**
 * Operations & Audit: read-only health summary, the latest audit events and
 * unreferenced storage-asset cleanup. Refreshes each time the tab is entered
 * (`enabled`); the view's Refresh button handles later refreshes.
 * @param {{ enabled: boolean }} options
 */
export function useOperations({ enabled }) {
  const [operationalHealth, setOperationalHealth] = useState(/** @type {import('../../../types').UntrustedInput} */ (null));
  const [auditEvents, setAuditEvents] = useState(/** @type {AuditEvent[]} */ ([]));
  const [clientErrors, setClientErrors] = useState(/** @type {import('../../../types').UntrustedInput[]} */ ([]));
  const [operationalLoading, setOperationalLoading] = useState(false);
  const [operationalError, setOperationalError] = useState('');
  const [unreferencedAssets, setUnreferencedAssets] = useState(/** @type {UnreferencedAsset[] | null} */ (null));
  const [scanningAssets, setScanningAssets] = useState(false);
  const [cleaningAssets, setCleaningAssets] = useState(false);
  const [terminatedPage, setTerminatedPage] = useState({ rows: /** @type {any[]} */ ([]), total: 0, page: 1, pageSize: 10 });
  const [terminatedLoading, setTerminatedLoading] = useState(false);
  const [regrantingSessionId, setRegrantingSessionId] = useState(/** @type {string | null} */ (null));
  // Guards overlapping refreshes without making the loader identity depend on render state.
  const operationalLoadingRef = useRef(false);

  const fetchTerminatedStudents = useCallback(async (page = 1, pageSize = 10, search = '') => {
    setTerminatedLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_admin_terminated_students_page', {
        page_number_param: page,
        page_size_param: pageSize,
        search_param: search || null
      });
      if (error) throw error;
      setTerminatedPage(data || { rows: [], total: 0, page, pageSize });
    } catch (err) {
      console.error('Failed to load terminated students:', err);
      setOperationalError('Terminated students could not be loaded. Refresh to try again.');
    } finally {
      setTerminatedLoading(false);
    }
  }, []);

  const fetchOperationalOverview = useCallback(async () => {
    if (operationalLoadingRef.current) return;
    operationalLoadingRef.current = true;
    setOperationalLoading(true);
    setOperationalError('');
    try {
      const [healthResult, auditResult] = await Promise.all([
        supabase.rpc('admin_operational_health'),
        supabase.from('admin_audit_events')
          .select('id, actor_user_id, action, target_type, target_id, metadata, occurred_at')
          .order('occurred_at', { ascending: false })
          .limit(100),
        fetchTerminatedStudents(1, 10)
      ]);
      if (healthResult.error) throw healthResult.error;
      if (auditResult.error) throw auditResult.error;
      setOperationalHealth(healthResult.data);
      setAuditEvents(auditResult.data || []);
      // Client error reporting (C18) is optional: an older database without the
      // RPC must not break the rest of the operations screen.
      const errorsResult = await supabase.rpc('admin_recent_client_errors', { limit_param: 20 });
      setClientErrors(!errorsResult.error && Array.isArray(errorsResult.data) ? errorsResult.data : []);
    } catch (error) {
      console.error('Operational overview failed:', error);
      setOperationalError('Operational status could not be loaded. Verify the database connection and administrator access.');
    } finally {
      operationalLoadingRef.current = false;
      setOperationalLoading(false);
    }
  }, [fetchTerminatedStudents]);

  const handleRegrantAccess = useCallback(
    /**
     * @param {string} session_id
     * @param {string} student_name
     * @param {string} exam_title
     */
    async (session_id, student_name, exam_title) => {
    const confirmed = await customConfirm(`Re-grant exam access to ${student_name} for "${exam_title}"?\n\nThe student will be able to resume their attempt under their original deadline with saved answers intact.`);
    if (!confirmed) return;

    setRegrantingSessionId(session_id);
    try {
      const { error } = await supabase.rpc('admin_regrant_exam_access', {
        session_id_param: session_id
      });
      if (error) throw error;
      showToast(`Access re-granted to ${student_name} successfully.`, 'success');
      await fetchOperationalOverview();
    } catch (err) {
      console.error('Failed to re-grant access:', err);
      await customAlert(`Failed to re-grant access: ${/** @type {Error} */ (err).message}`);
    } finally {
      setRegrantingSessionId(null);
    }
  }, [fetchOperationalOverview]);

  useEffect(() => {
    if (enabled) fetchOperationalOverview();
  }, [enabled, fetchOperationalOverview]);

  const handleScanUnreferencedAssets = async () => {
    setScanningAssets(true);
    try {
      const { data, error } = await supabase.rpc('get_unreferenced_exam_assets');
      if (error) throw error;
      setUnreferencedAssets(data || []);
      showToast(`Scan complete: ${data?.length || 0} unreferenced assets found.`, 'info');
    } catch (err) {
      console.error('Scan unreferenced assets failed:', err);
      await customAlert(`Scan failed: ${/** @type {Error} */ (err).message}`);
    } finally {
      setScanningAssets(false);
    }
  };

  const handleCleanupUnreferencedAssets = async () => {
    if (!unreferencedAssets || unreferencedAssets.length === 0) return;
    const confirmed = await customConfirm(`Permanently delete ${unreferencedAssets.length} unreferenced storage files from "exam-assets"? This action cannot be undone.`);
    if (!confirmed) return;

    setCleaningAssets(true);
    try {
      const requestedPaths = /** @type {string[]} */ (unreferencedAssets.map(asset => asset.name).filter(Boolean));
      let deletedCount = 0;
      for (let offset = 0; offset < requestedPaths.length; offset += 100) {
        const batch = requestedPaths.slice(offset, offset + 100);
        // The Storage API removes both the object bytes and their metadata.
        // Its database DELETE policy re-checks references at deletion time.
        const { data: removed, error: removeError } = await supabase.storage.from('exam-assets').remove(batch);
        if (removeError) throw removeError;
        const removedPaths = (removed || []).map(asset => asset.name).filter(Boolean);
        if (removedPaths.length === 0 && batch.length > 0) {
          throw new Error('Storage did not confirm deletion of the selected files.');
        }
        const { error: auditError } = await supabase.rpc('record_exam_asset_cleanup', {
          asset_names: removedPaths
        });
        if (auditError) throw auditError;
        deletedCount += removedPaths.length;
      }
      await customAlert(`Cleanup successful: deleted ${deletedCount} unreferenced files through secure storage.`);
      await handleScanUnreferencedAssets();
      await fetchOperationalOverview();
    } catch (err) {
      console.error('Cleanup unreferenced assets failed:', err);
      await customAlert(`Cleanup failed: ${/** @type {Error} */ (err).message}`);
    } finally {
      setCleaningAssets(false);
    }
  };

  return {
    operationalHealth,
    auditEvents,
    clientErrors,
    operationalLoading,
    operationalError,
    fetchOperationalOverview,
    unreferencedAssets,
    scanningAssets,
    cleaningAssets,
    handleScanUnreferencedAssets,
    handleCleanupUnreferencedAssets,
    terminatedPage,
    terminatedLoading,
    regrantingSessionId,
    fetchTerminatedStudents,
    handleRegrantAccess
  };
}

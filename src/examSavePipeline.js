// Autosave and submission share this drain. Intermediate snapshots are replaced
// by the latest pending answers; the in-flight write always finishes first.
/**
 * @template T
 * @param {(payload: T) => Promise<number | null>} save
 */
export function createExamSavePipeline(save) {
  /** @type {T | null} */
  let pending = null;
  /** @type {Promise<number | null> | null} */
  let running = null;
  let closed = false;
  return {
    /** @param {T} payload */
    save(payload) {
      if (closed) return Promise.reject(new Error('The answer save pipeline is closed.'));
      pending = payload;
      if (running) return running;
      running = (async () => {
        /** @type {number | null} */
        let version = null;
        while (pending !== null) {
          const snapshot = pending;
          pending = null;
          version = await save(snapshot);
          if (closed) throw new Error('The answer save pipeline is closed.');
        }
        return version;
      })().finally(() => { running = null; });
      return running;
    },
    dispose() { closed = true; pending = null; }
  };
}

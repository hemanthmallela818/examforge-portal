export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_COLLECTION_LIMIT = 20000;

export const parsePagedCollectionResponse = (data, { expectedPage, expectedPageSize }) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('The server returned an invalid page response.');
  const page = Number(data.page);
  const pageSize = Number(data.page_size);
  const total = Number(data.total);
  if (!Number.isInteger(page) || page !== expectedPage || page < 0) throw new Error('The server returned an unexpected page number.');
  if (!Number.isInteger(pageSize) || pageSize !== expectedPageSize || pageSize <= 0) throw new Error('The server returned an unexpected page size.');
  if (!Number.isInteger(total) || total < 0) throw new Error('The server returned an invalid collection total.');
  if (!Array.isArray(data.rows) || data.rows.length > pageSize) throw new Error('The server returned an invalid page of rows.');
  if (data.rows.length > total) throw new Error('The page contains more rows than the reported collection total.');
  return { page, pageSize, total, rows: data.rows };
};

export class CollectionLimitError extends Error {
  constructor(limit) {
    super(`This collection contains more than ${limit.toLocaleString()} records. Narrow the query before loading it.`);
    this.name = 'CollectionLimitError';
    this.limit = limit;
  }
}

const assertPositiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
};

// Supabase/PostgREST limits a response to max_rows (1,000 in this project).
// Fetch fixed ranges so callers never mistake a truncated first page for a
// complete collection. A one-row probe distinguishes an exact-limit result
// from an oversized collection and fails visibly instead of dropping data.
export const fetchAllRows = async (
  fetchPage,
  { pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_COLLECTION_LIMIT } = {}
) => {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function.');
  assertPositiveInteger(pageSize, 'pageSize');
  assertPositiveInteger(maxRows, 'maxRows');
  if (pageSize > 1000) throw new RangeError('pageSize cannot exceed the configured API row limit of 1,000.');

  const rows = [];
  while (rows.length < maxRows) {
    const requested = Math.min(pageSize, maxRows - rows.length);
    const from = rows.length;
    const { data, error } = await fetchPage(from, from + requested - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new TypeError('A paginated query must return an array of rows.');
    if (data.length > requested) throw new Error('A paginated query returned more rows than requested.');

    rows.push(...data);
    if (data.length < requested) return rows;
  }

  const { data: overflow, error: overflowError } = await fetchPage(maxRows, maxRows);
  if (overflowError) throw overflowError;
  if (!Array.isArray(overflow)) throw new TypeError('A paginated query must return an array of rows.');
  if (overflow.length > 0) throw new CollectionLimitError(maxRows);
  return rows;
};

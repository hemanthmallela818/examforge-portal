import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CollectionLimitError,
  fetchAllRows,
  parsePagedCollectionResponse
} from '../src/paginatedQuery.js';

const pageSource = (rows, calls) => async (from, to) => {
  calls.push([from, to]);
  return { data: rows.slice(from, to + 1), error: null };
};

test('fetchAllRows retrieves every page instead of accepting the API first-page ceiling', async () => {
  const source = Array.from({ length: 1205 }, (_, id) => ({ id }));
  const calls = [];
  const rows = await fetchAllRows(pageSource(source, calls), { pageSize: 500, maxRows: 2000 });

  assert.deepEqual(rows, source);
  assert.deepEqual(calls, [[0, 499], [500, 999], [1000, 1499]]);
});

test('fetchAllRows verifies that an exact safety-limit result is complete', async () => {
  const source = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const calls = [];
  const rows = await fetchAllRows(pageSource(source, calls), { pageSize: 500, maxRows: 1000 });

  assert.equal(rows.length, 1000);
  assert.deepEqual(calls.at(-1), [1000, 1000]);
});

test('fetchAllRows fails visibly when a collection exceeds its browser safety limit', async () => {
  const source = Array.from({ length: 1001 }, (_, id) => ({ id }));
  await assert.rejects(
    fetchAllRows(pageSource(source, []), { pageSize: 500, maxRows: 1000 }),
    (error) => error instanceof CollectionLimitError && error.limit === 1000
  );
});

test('fetchAllRows propagates query failures without returning partial data', async () => {
  const failure = new Error('network unavailable');
  await assert.rejects(
    fetchAllRows(async (from) => from === 0
      ? { data: Array.from({ length: 500 }), error: null }
      : { data: null, error: failure }),
    failure
  );
});

test('fetchAllRows rejects a page size above the configured API limit', async () => {
  await assert.rejects(fetchAllRows(async () => ({ data: [], error: null }), { pageSize: 1001 }), /cannot exceed/);
});

test('parsePagedCollectionResponse rejects malformed counts and oversized pages', () => {
  assert.throws(() => parsePagedCollectionResponse(null, { expectedPage: 0, expectedPageSize: 10 }), /invalid page response/);
  assert.throws(() => parsePagedCollectionResponse({ page: 0, page_size: 10, total: -1, rows: [] }, { expectedPage: 0, expectedPageSize: 10 }), /invalid collection total/);
  assert.throws(() => parsePagedCollectionResponse({ page: 0, page_size: 10, total: 10, rows: Array(11) }, { expectedPage: 0, expectedPageSize: 10 }), /invalid page of rows/);
});

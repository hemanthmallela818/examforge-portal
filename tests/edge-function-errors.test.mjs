import test from 'node:test';
import assert from 'node:assert/strict';

import { readFunctionInvocationError } from '../src/edgeFunctionErrors.js';

test('Edge Function errors prefer the server JSON response over the generic SDK message', async () => {
  const result = {
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify({ error: 'Exact server failure' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
  };

  assert.equal(await readFunctionInvocationError(result, 'Fallback'), 'Exact server failure');
});

test('Edge Function errors retain safe SDK and fallback messages', async () => {
  assert.equal(
    await readFunctionInvocationError({ error: { message: 'Network unavailable' } }, 'Fallback'),
    'Network unavailable'
  );
  assert.equal(await readFunctionInvocationError({}, 'Fallback'), 'Fallback');
});

test('server correlation IDs are appended so support can trace the failure', async () => {
  const { readFunctionInvocationError } = await import('../src/edgeFunctionErrors.js');
  const withReference = await readFunctionInvocationError({
    data: { error: 'Failed to update student password', correlationId: '7f3a9c2e-1b4d-4e8f-9a0b-123456789abc' }
  }, 'fallback');
  assert.equal(withReference, 'Failed to update student password (Reference: 7f3a9c2e-1b4d-4e8f-9a0b-123456789abc)');

  const unsafeReference = await readFunctionInvocationError({
    data: { error: 'Denied', correlationId: '<script>alert(1)</script>' }
  }, 'fallback');
  assert.equal(unsafeReference, 'Denied');
});

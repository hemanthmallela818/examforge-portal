import { expect, it, vi } from 'vitest';
import { createExamSavePipeline } from '../../src/examSavePipeline.js';

it('serializes autosave and final flush, keeping only the latest pending snapshot', async () => {
  let finish;
  const save = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(3);
  const pipeline = createExamSavePipeline(save);
  const first = pipeline.save({ value: 'old' });
  pipeline.save({ value: 'middle' });
  const flushed = pipeline.save({ value: 'final' });
  expect(save).toHaveBeenCalledTimes(1);
  finish(2);
  expect(await first).toBe(3);
  expect(await flushed).toBe(3);
  expect(save.mock.calls.map(([payload]) => payload.value)).toEqual(['old', 'final']);
});

it('propagates failure and retries through the same pipeline without a parallel write', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(2);
  const pipeline = createExamSavePipeline(save);
  await expect(pipeline.save({ value: 'answer' })).rejects.toThrow('network');
  expect(await pipeline.save({ value: 'answer' })).toBe(2);
  expect(save).toHaveBeenCalledTimes(2);
});

it('disposal prevents a queued write after an in-flight response', async () => {
  let finish;
  const save = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const pipeline = createExamSavePipeline(save);
  const running = pipeline.save({ value: 'old' });
  pipeline.save({ value: 'pending' });
  pipeline.dispose();
  finish(2);
  await expect(running).rejects.toThrow(/closed/);
  expect(save).toHaveBeenCalledTimes(1);
});

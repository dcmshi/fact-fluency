import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerRequest } from '@shared';
import {
  enqueueAnswer,
  flushAll,
  flushAnswers,
  markPendingComplete,
  pendingCount,
} from './syncQueue';

// Mock the HTTP client — these tests assert queue ordering/draining behavior,
// not real network calls.
vi.mock('./api', () => ({ api: { answer: vi.fn(), complete: vi.fn() } }));
import { api } from './api';

const answerMock = api.answer as unknown as ReturnType<typeof vi.fn>;
const completeMock = api.complete as unknown as ReturnType<typeof vi.fn>;

const body = (factId: string): AnswerRequest => ({ factId, correct: true, responseMs: 1200 });

beforeEach(() => {
  localStorage.clear();
  answerMock.mockReset();
  completeMock.mockReset();
});

describe('queued answers', () => {
  it('persists across calls (survives a reload)', () => {
    enqueueAnswer('s1', body('add:2+3'));
    enqueueAnswer('s1', body('add:4+5'));
    expect(pendingCount()).toBe(2);
  });

  it('flushes every answer in order, then drains', async () => {
    answerMock.mockResolvedValue({});
    enqueueAnswer('s1', body('a'));
    enqueueAnswer('s1', body('b'));

    expect(await flushAnswers()).toBe(true);
    expect(answerMock.mock.calls.map((c) => c[1].factId)).toEqual(['a', 'b']);
    expect(pendingCount()).toBe(0);
  });

  it('stops at the first failure and preserves it + the rest, in order', async () => {
    answerMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline'));
    enqueueAnswer('s1', body('a'));
    enqueueAnswer('s1', body('b'));
    enqueueAnswer('s1', body('c'));

    expect(await flushAnswers()).toBe(false);
    expect(pendingCount()).toBe(2); // 'a' sent; 'b' (failed) + 'c' remain

    answerMock.mockReset();
    answerMock.mockResolvedValue({});
    expect(await flushAnswers()).toBe(true);
    expect(answerMock.mock.calls.map((c) => c[1].factId)).toEqual(['b', 'c']);
  });

  it('treats an empty queue as drained', async () => {
    expect(await flushAnswers()).toBe(true);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('serializes concurrent flushes so each answer is sent exactly once', async () => {
    answerMock.mockResolvedValue({});
    enqueueAnswer('s1', body('a'));
    enqueueAnswer('s1', body('b'));

    // Two near-simultaneous triggers (e.g. mount flush + an `online` event).
    // Without the lock both would read [a, b] and send 4 requests.
    await Promise.all([flushAnswers(), flushAnswers()]);

    expect(answerMock).toHaveBeenCalledTimes(2);
    expect(pendingCount()).toBe(0);
  });
});

describe('flushAll', () => {
  it('does not complete a session while its answers are still pending', async () => {
    answerMock.mockRejectedValue(new Error('offline'));
    enqueueAnswer('s1', body('a'));
    markPendingComplete('s1');

    await flushAll();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('completes a finished-offline session once answers drain (idempotent mark)', async () => {
    answerMock.mockResolvedValue({});
    completeMock.mockResolvedValue({});
    enqueueAnswer('s1', body('a'));
    markPendingComplete('s1');
    markPendingComplete('s1'); // duplicate is a no-op

    await flushAll();
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith('s1');
  });

  it('keeps a session queued when its completion still fails, retrying later', async () => {
    completeMock.mockRejectedValue(new Error('offline'));
    markPendingComplete('s1');
    await flushAll();
    expect(completeMock).toHaveBeenCalledTimes(1);

    completeMock.mockReset();
    completeMock.mockResolvedValue({});
    await flushAll();
    expect(completeMock).toHaveBeenCalledWith('s1');
  });
});

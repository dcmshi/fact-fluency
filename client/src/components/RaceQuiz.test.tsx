import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Fact } from '@shared';
import { renderWithProviders } from '../test/harness';
import { RaceQuiz } from './RaceQuiz';

const fact: Fact = { id: 'mul:3x4', operation: 'mul', operandA: 3, operandB: 4, answer: 12 };
const choices = [10, 12, 14, 16]; // the answer, 12, is index 1 → the "2" key

describe('RaceQuiz keyboard picks', () => {
  it('reports a correct pick', () => {
    const onComplete = vi.fn();
    renderWithProviders(
      <RaceQuiz fact={fact} choices={choices} onAnswer={() => {}} onComplete={onComplete} />,
    );

    fireEvent.keyDown(window, { key: '2' });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ correct: true, wrongMunches: 0 });
  });

  /**
   * The regression this component's keydown handler had: its dep array was
   * eslint-disabled and listed neither `onComplete` nor `fact`, so the listener
   * kept whichever closure the last matching render produced. RacePage rebuilds
   * onRoundComplete every render around its current roundIndex, so a keyboard
   * player's answer could be attributed to a stale round.
   */
  it('calls the latest onComplete, not the one from the first render', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderWithProviders(
      <RaceQuiz fact={fact} choices={choices} onAnswer={() => {}} onComplete={stale} />,
    );
    rerender(<RaceQuiz fact={fact} choices={choices} onAnswer={() => {}} onComplete={fresh} />);

    fireEvent.keyDown(window, { key: '2' });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('counts a wrong pick without ending the round, then accepts the right one', () => {
    const onAnswer = vi.fn();
    const onComplete = vi.fn();
    renderWithProviders(
      <RaceQuiz fact={fact} choices={choices} onAnswer={onAnswer} onComplete={onComplete} />,
    );

    fireEvent.keyDown(window, { key: '1' }); // 10 — wrong
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    expect(onComplete).not.toHaveBeenCalled();

    // A wrong tap locks the buttons briefly; the lock is what stops the next
    // key, so the round is still open.
    expect(screen.getByRole('button', { name: '10' }).getAttribute('aria-disabled')).toBe('true');
  });
});

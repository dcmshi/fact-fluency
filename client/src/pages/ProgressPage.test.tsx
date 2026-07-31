import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { dashboard, masteredProgress } from '../test/fixtures';
import { renderWithProviders, stubAnimationFrame, type FrameControl } from '../test/harness';
import { cellBackground, ProgressPage } from './ProgressPage';

/**
 * The fact grid used to convey mastery with shade alone: boxes 0–4 differed only
 * by alpha (0.2 → 0.66) and "unseen" looked much like box 0. The bar layer is
 * the non-color cue (WCAG 1.4.1), so what matters is that it is present, that it
 * is monotonic in the box number, and that "unseen" has none.
 */
const barPct = (css: string): number | null => {
  const m = /transparent (\d+(?:\.\d+)?)%\)/.exec(css);
  return m ? Number(m[1]) : null;
};

describe('cellBackground', () => {
  it('gives an unseen fact a flat fill and no bar', () => {
    const css = cellBackground('mul', null, 'unseen');
    expect(css).toBe('#f1e7d5');
    expect(barPct(css)).toBeNull();
  });

  it('gives a fact with no box yet no bar even if it is not marked unseen', () => {
    expect(barPct(cellBackground('mul', null, 'review'))).toBeNull();
  });

  it('grows the bar monotonically from box 0 to mastered', () => {
    const pcts = ([0, 1, 2, 3, 4, 5] as const).map((b) =>
      barPct(cellBackground('add', b, 'review')),
    );
    expect(pcts).toEqual([16.7, 33.3, 50.0, 66.7, 83.3, 100.0]);
  });

  it('keeps the operation fill underneath the bar', () => {
    expect(cellBackground('sub', 0, 'review')).toContain('rgba(255, 107, 92, 0.2)');
    expect(cellBackground('sub', 5, 'mastered')).toContain('rgba(255, 107, 92, 1)');
  });
});

// ---------------------------------------------------------------------------
// Rendered page — the print and export lifecycles, which only exist in effects
// ---------------------------------------------------------------------------

let frames: FrameControl;

function renderPage() {
  vi.spyOn(api, 'dashboard').mockResolvedValue(dashboard());
  vi.spyOn(api, 'progress').mockResolvedValue(masteredProgress);
  return renderWithProviders(<ProgressPage />, {
    route: '/progress/p1',
    path: '/progress/:profileId',
  });
}

beforeEach(() => {
  frames = stubAnimationFrame();
  vi.stubGlobal('print', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printing a certificate', () => {
  /**
   * The sheet used to be unmounted on the line after window.print(). Chrome and
   * Firefox block there until the dialog closes, so it worked; Safari returns
   * immediately, so the sheet was gone before the dialog had rendered it and the
   * kid got a printout of the rest of the page. Nothing here fakes Safari — the
   * test simply never lets print() block, which is Safari's behaviour, and
   * asserts the sheet is still mounted afterwards.
   */
  it('keeps the sheet mounted until afterprint fires', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /certificate/i });

    fireEvent.click(button);
    act(() => frames.flush());

    expect(window.print).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.certificate-sheet')).not.toBeNull();

    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.querySelector('.certificate-sheet')).toBeNull());
  });

  it('renders the sheet before opening the dialog, not after', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /certificate/i });

    fireEvent.click(button);
    // A frame is deliberately left between arming and printing so the sheet is
    // in the DOM when the dialog snapshots the page.
    expect(window.print).not.toHaveBeenCalled();
    act(() => frames.flush());
    expect(window.print).toHaveBeenCalled();
  });
});

describe('exporting progress', () => {
  it('revokes the blob URL in a later task, not inline after click()', async () => {
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('a,b\n1,2', { status: 200 })),
    );

    // Firefox starts the download asynchronously after click() returns and
    // cancels it if the URL is already gone. Probe from a timer scheduled
    // *during* click, which therefore runs before any timer the download itself
    // schedules afterwards: revoke must not have happened by then.
    let revokesByNextTask = -1;
    const probe = new Promise<void>((done) => {
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        setTimeout(() => {
          revokesByNextTask = revokeObjectURL.mock.calls.length;
          done();
        }, 0);
      });
    });

    renderPage();
    (await screen.findByRole('button', { name: 'CSV' })).click();

    await probe;
    expect(revokesByNextTask).toBe(0);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:export'));
  });
});

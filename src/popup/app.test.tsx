// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp, type PopupDeps } from './app';

afterEach(cleanup);

function deps(over: Partial<PopupDeps> = {}): PopupDeps {
  return {
    readCheck: vi.fn().mockResolvedValue(false),
    setCheck: vi.fn().mockResolvedValue({ on: true }),
    scan: vi.fn().mockResolvedValue(undefined),
    openPanel: vi.fn(),
    openOptions: vi.fn(),
    close: vi.fn(),
    ...over,
  };
}

describe('the popup', () => {
  it('shows Scan this page, the Live check switch as the setting is, Cards found and Options', async () => {
    render(<PopupApp deps={deps({ readCheck: vi.fn().mockResolvedValue(true) })} />);
    expect(screen.getByRole('button', { name: 'Scan this page' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Live check' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('Point at a card in a video to see it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cards found' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Options' })).toBeTruthy();
  });

  it('Scan this page scans, then closes the popup', async () => {
    const d = deps();
    render(<PopupApp deps={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan this page' }));
    expect(d.scan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(d.close).toHaveBeenCalled());
  });

  it('the switch turns Live check on in the click itself, and shows why it stayed off', async () => {
    const d = deps({ setCheck: vi.fn().mockResolvedValue({ on: false, reason: 'no-permission' }) });
    render(<PopupApp deps={d} />);
    const sw = screen.getByRole('switch', { name: 'Live check' });
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
    fireEvent.click(sw);
    expect(d.setCheck).toHaveBeenCalledWith(true); // synchronously, in the click
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Live check needs access to every site to work on any page.'));
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('Cards found opens the panel; Options opens Options and closes the popup', () => {
    const d = deps();
    render(<PopupApp deps={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cards found' }));
    expect(d.openPanel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));
    expect(d.openOptions).toHaveBeenCalledTimes(1);
    expect(d.close).toHaveBeenCalledTimes(1);
  });
});

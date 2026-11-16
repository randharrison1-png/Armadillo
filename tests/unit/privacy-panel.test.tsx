import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/settings/actions', () => ({ deleteAccountAction: vi.fn() }));
const { PrivacyPanel } = await import('@/features/settings/PrivacyPanel');

afterEach(() => vi.unstubAllGlobals());

describe('PrivacyPanel copy matches what the gateway sends', () => {
  const text = () => document.body.textContent ?? '';

  it('says what goes with every chat turn', () => {
    render(<PrivacyPanel />);
    expect(text()).toMatch(/session title and operating system/i);
    expect(text()).toMatch(/conversation so far/i);
    expect(text()).toMatch(/your message/i);
  });

  it('names the selectable items correctly (requirements are not selectable)', () => {
    render(<PrivacyPanel />);
    expect(text()).toMatch(/scripts, the README, reports and evidence notes/i);
    expect(text()).not.toMatch(/scripts, the README, reports and requirements/i);
  });

  /** The disclosure list item that starts with `action`. */
  const item = (action: RegExp) => {
    const hit = screen.getAllByRole('listitem').find((li) => action.test(li.textContent ?? ''));
    expect(hit, `a list item for ${action}`).toBeDefined();
    return hit!.textContent ?? '';
  };

  it('discloses what each Claude action sends', () => {
    render(<PrivacyPanel />);
    const extract = item(/^Extract requirements/);
    expect(extract).toMatch(/README/);

    const assess = item(/^Assess coverage/);
    expect(assess).toMatch(/README/);
    expect(assess).toMatch(/script version you choose/i);
    expect(assess).toMatch(/text of the requirements/i);

    const propose = item(/^Propose adaptation/);
    expect(propose).toMatch(/README/);
    expect(propose).toMatch(/script/);
    expect(propose).toMatch(/all of the session.s requirements with their coverage and suggestions/i);

    const remediation = item(/^Remediation/);
    expect(remediation).toMatch(/whole report/i);
    expect(remediation).toMatch(/failing findings/i);
    expect(remediation).toMatch(/script/);
    expect(remediation).toMatch(/requirements/);

    const mapping = item(/^Mapping findings/);
    expect(mapping).toMatch(/findings and requirements/i);

    const ping = item(/^Test connection/);
    expect(ping).toMatch(/one-word ping/i);
  });

  it('lists every way Claude is called, so "only when you ask" is true', () => {
    render(<PrivacyPanel />);
    const rule = item(/Nothing is sent automatically/);
    for (const trigger of [/send a message/i, /Extract requirements/, /Assess coverage/, /Propose adaptation/, /Remediation/, /Mapping findings/, /Test connection/]) {
      expect(rule).toMatch(trigger);
    }
  });

  it('says the latest export stays in private storage', () => {
    render(<PrivacyPanel />);
    expect(text()).toMatch(/latest export zip stays in your private storage until you export again or delete your account/i);
  });

  it('keeps: nothing is sent automatically, pastes are public, key never reaches the browser', () => {
    render(<PrivacyPanel />);
    expect(text()).toMatch(/nothing is sent automatically/i);
    expect(text()).not.toMatch(/Nothing from your library is sent automatically/i);
    expect(text()).toMatch(/pastes are public/i);
    expect(text()).toMatch(/never reaches your browser/i);
  });

  it('states the export cap', () => {
    render(<PrivacyPanel />);
    expect(text()).toMatch(/48 MB/);
  });
});

describe('Export my data', () => {
  const assign = vi.fn();
  const setup = (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', { value: { assign }, writable: true, configurable: true });
    return fetchMock;
  };

  it('is a button that POSTs, shows a pending state, then goes to the signed URL', async () => {
    assign.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ url: 'https://files.example/signed?t=1', filename: 'a.zip' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', { value: { assign }, writable: true, configurable: true });
    render(<PrivacyPanel />);
    const btn = screen.getByRole('button', { name: /Export my data/ });
    await userEvent.click(btn);
    expect(fetchMock).toHaveBeenCalledWith('/api/account/export', expect.objectContaining({ method: 'POST' }));
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example/signed?t=1'));
    expect(btn).not.toBeDisabled();
  });

  it('shows the server error text inline when the export fails', async () => {
    assign.mockClear();
    setup({ ok: false, status: 413, json: async () => ({ error: 'Your data is larger than 50 MB.' }) });
    render(<PrivacyPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Export my data/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your data is larger than 50 MB.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a generic message when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    Object.defineProperty(window, 'location', { value: { assign }, writable: true, configurable: true });
    render(<PrivacyPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Export my data/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach|try again/i);
  });
});

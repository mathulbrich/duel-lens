// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Keys, commandLabel, shortcutKeys } from './shortcuts';

afterEach(cleanup);

describe('shortcutKeys', () => {
  it('splits the form Chrome reports on Windows, Linux and ChromeOS', () => {
    expect(shortcutKeys('Alt+Shift+Y')).toEqual(['Alt', 'Shift', 'Y']);
    expect(shortcutKeys('Ctrl+Shift+Comma')).toEqual(['Ctrl', 'Shift', 'Comma']);
  });

  it('splits the macOS form (modifier symbols, then the key)', () => {
    expect(shortcutKeys('⌥⇧Y')).toEqual(['⌥', '⇧', 'Y']);
    expect(shortcutKeys('⌃⌘Comma')).toEqual(['⌃', '⌘', 'Comma']);
  });

  it('has no keys for a shortcut that is not set', () => {
    expect(shortcutKeys('')).toEqual([]);
    expect(shortcutKeys('  ')).toEqual([]);
  });
});

describe('Keys', () => {
  it('renders each key as a keycap inside one combination', () => {
    const { container } = render(<Keys shortcut="Alt+Shift+Y" />);
    const combo = container.querySelector('kbd.combo')!;
    expect(Array.from(combo.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['Alt', 'Shift', 'Y']);
    expect(combo.textContent).toBe('Alt+Shift+Y');
  });

  it('spells out the macOS modifier symbols', () => {
    const { container } = render(<Keys shortcut="⌘⇧Y" />);
    expect(Array.from(container.querySelectorAll('kbd.combo kbd')).map((k) => k.textContent)).toEqual(['⌘ Command', '⇧ Shift', 'Y']);
  });
});

describe('commandLabel', () => {
  it("names Duel Lens's commands in the pages' own words, else uses Chrome's description", () => {
    expect(commandLabel({ name: 'scan-card', description: 'Scan a card on this page', shortcut: '' })).toBe('Scan a card');
    expect(commandLabel({ name: 'open-panel', description: 'Open the Duel Lens side panel', shortcut: '' })).toBe('Open the side panel');
    expect(commandLabel({ name: 'something-new', description: 'Do something new', shortcut: '' })).toBe('Do something new');
  });
});

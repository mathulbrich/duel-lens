// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { render } from 'preact';

it('renders Preact JSX in tests', () => {
  const root = document.createElement('div');
  render(<p class="x">hi</p>, root);
  expect(root.innerHTML).toBe('<p class="x">hi</p>');
});

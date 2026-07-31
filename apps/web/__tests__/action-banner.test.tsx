import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionBanner } from '../src/shared/components/action-banner.js';

const success = vi.fn();
const error = vi.fn();
const info = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (m: string) => success(m),
    error: (m: string) => error(m),
    info: (m: string) => info(m),
  },
}));

describe('ActionBanner', () => {
  beforeEach(() => {
    success.mockClear();
    error.mockClear();
    info.mockClear();
  });

  it('renders nothing', () => {
    const { container } = render(<ActionBanner banner={{ kind: 'ok', message: 'Saved.' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fires no toast when banner is null', () => {
    render(<ActionBanner banner={null} />);
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('fires a success toast for kind:ok', () => {
    const { rerender } = render(<ActionBanner banner={null} />);
    rerender(<ActionBanner banner={{ kind: 'ok', message: 'Saved.' }} />);
    expect(success).toHaveBeenCalledWith('Saved.');
    expect(error).not.toHaveBeenCalled();
  });

  it('fires an error toast for kind:err', () => {
    const { rerender } = render(<ActionBanner banner={null} />);
    rerender(<ActionBanner banner={{ kind: 'err', message: 'Nope.' }} />);
    expect(error).toHaveBeenCalledWith('Nope.');
    expect(success).not.toHaveBeenCalled();
  });

  it('fires an info toast for kind:info', () => {
    // Some mutation answers are neither. Cancelling an override the bot is
    // already dispatching neither succeeded nor broke, and rendering it as an
    // error tells the operator to retry something that needs waiting out.
    const { rerender } = render(<ActionBanner banner={null} />);
    rerender(<ActionBanner banner={{ kind: 'info', message: 'Already acting on it.' }} />);
    expect(info).toHaveBeenCalledWith('Already acting on it.');
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

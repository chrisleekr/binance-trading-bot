import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RowActions, type RowAction } from '@/shared/components/row-actions';

describe('RowActions', () => {
  it('renders nothing when there are no actions', () => {
    const { container } = render(<RowActions label="Row actions" actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the menu and runs an enabled action on select', async () => {
    const onSelect = vi.fn();
    const actions: RowAction[] = [{ key: 'edit', label: 'Edit', testId: 'act-edit', onSelect }];
    const user = userEvent.setup();
    render(<RowActions label="Row actions" testId="trigger" actions={actions} />);

    await user.click(screen.getByTestId('trigger'));
    await user.click(await screen.findByTestId('act-edit'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows a disabled action with its reason and does not run it', async () => {
    const onSelect = vi.fn();
    const actions: RowAction[] = [
      {
        key: 'delete',
        label: 'Delete',
        testId: 'act-delete',
        destructive: true,
        disabled: true,
        disabledReason: 'Pinned as the live baseline',
        onSelect,
      },
    ];
    const user = userEvent.setup();
    render(<RowActions label="Row actions" testId="trigger" actions={actions} />);

    await user.click(screen.getByTestId('trigger'));
    expect(await screen.findByText('Pinned as the live baseline')).toBeInTheDocument();
    await user.click(screen.getByTestId('act-delete'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opening the menu does not fire a surrounding row click', async () => {
    const rowClick = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={rowClick}>
        <RowActions
          label="Row actions"
          testId="trigger"
          actions={[{ key: 'edit', label: 'Edit', testId: 'act-edit', onSelect }]}
        />
      </div>,
    );

    // The whole reason the menu lives in a clickable row: opening it (and
    // choosing an item) must not also trigger the row's click handler.
    await user.click(screen.getByTestId('trigger'));
    await user.click(await screen.findByTestId('act-edit'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });
});

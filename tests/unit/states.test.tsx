import { fireEvent, render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shell/states/EmptyState';
import { ErrorState } from '@/components/shell/states/ErrorState';
import { LoadingState } from '@/components/shell/states/LoadingState';

describe('Button', () => {
  it('exposes focus-visible ring and aria-busy when loading', () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole('button', { name: /save/i });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
    expect(btn.className).toContain('focus-visible:ring');
  });

  it('is not busy by default and supports all variants', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      const btn = screen.getByRole('button', { name: variant });
      expect(btn).not.toHaveAttribute('aria-busy', 'true');
      expect(btn.className).toContain('hover:');
      unmount();
    }
  });
});

describe('state components', () => {
  it('EmptyState renders title, description, and actions', () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No scripts in your library"
        description="Upload or create one."
        actions={<Button>Upload</Button>}
      />,
    );
    expect(screen.getByText('No scripts in your library')).toBeInTheDocument();
    expect(screen.getByText('Upload or create one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('LoadingState is a polite status with its label', () => {
    render(<LoadingState label="Loading scripts" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Loading scripts');
    expect(el).toHaveAttribute('aria-busy', 'true');
  });

  it('ErrorState is an alert and retry calls onRetry', () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Could not load" detail="Network down" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.getByText('Network down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

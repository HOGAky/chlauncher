/**
 * @file switch.tsx
 * Toggle switch (checkbox styled as a switch — zero-dep shadcn equivalent).
 */
import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Accessible on/off switch. `shrink-0` is load-bearing: inside flex rows a
 *  shrinkable track gets squashed while the thumb still travels a fixed
 *  distance — the classic "crooked toggle" look. */
export const Switch = ({ checked, onCheckedChange, disabled, className }: SwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      'inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      checked ? 'bg-primary' : 'bg-muted',
      disabled && 'opacity-40 pointer-events-none',
      className
    )}
  >
    <span
      className={cn(
        'pointer-events-none ml-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-4' : 'translate-x-0'
      )}
    />
  </button>
);

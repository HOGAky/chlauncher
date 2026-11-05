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

/** Accessible on/off switch. */
export const Switch = ({ checked, onCheckedChange, disabled, className }: SwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      'relative h-5 w-9 rounded-full transition-colors',
      checked ? 'bg-primary' : 'bg-muted',
      disabled && 'opacity-40 pointer-events-none',
      className
    )}
  >
    <span
      className={cn(
        'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
        checked ? 'translate-x-[18px]' : 'translate-x-0.5'
      )}
    />
  </button>
);

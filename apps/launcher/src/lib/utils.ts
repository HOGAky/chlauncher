/**
 * @file utils.ts
 * Shared UI helpers: `cn` class combiner and sensitive-data masking used by
 * Streamer Mode.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Masks an email for streamer mode: `st***@example.com`.
 * Short local parts degrade gracefully to `***@host`.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${(local || '').slice(0, 2)}***@${domain}`;
}

/** Masks a token/HWID entirely for streamer mode. */
export function maskSecret(s: string | null | undefined): string {
  return s ? '••••••••••••' : '';
}

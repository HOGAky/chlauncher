/**
 * @file hwid.js
 * Hardware-id handling (Task 5): usability validation, HMAC hashing for
 * persistence and IP hashing for the device-events journal.
 *
 * The launcher's hardware_id() returns a `!sentinel` string when the OS
 * refuses to disclose a machine id — such values must never be accepted as
 * a real binding, otherwise every unidentifiable machine shares the same
 * fake device identity. `isUsableHwid` rejects them at the HTTP boundary.
 *
 * HWIDs are stored HMAC-SHA256'd — a database dump reveals only hashes,
 * and the raw value is never logged or returned to clients.
 */

import crypto from 'node:crypto';
import { config } from './config.js';

/** Upper bound on a plausible HWID string (machine GUIDs are ~36 chars). */
export const HWID_MAX_LEN = 256;

/**
 * @param {unknown} hwid
 * @returns {boolean} true when the value may be used as a device binding.
 */
export function isUsableHwid(hwid) {
  return (
    typeof hwid === 'string' &&
    hwid.length > 0 &&
    hwid.length <= HWID_MAX_LEN &&
    !hwid.startsWith('!')
  );
}

/**
 * HMAC-SHA256 of a raw HWID — the only form ever persisted/compared.
 * @param {string} hwid
 * @returns {string} 64-char hex digest
 */
export function hwidHash(hwid) {
  return crypto
    .createHmac('sha256', config.hwidHashSecret)
    .update(String(hwid))
    .digest('hex');
}

/**
 * Short HMAC of an IP for the device-events journal — correlatable within
 * this deployment but useless to anyone holding a dump.
 * @param {string} ip
 * @returns {string} 16-char hex digest
 */
export function ipHash(ip) {
  return crypto
    .createHmac('sha256', config.hwidHashSecret)
    .update(`ip:${ip || ''}`)
    .digest('hex')
    .slice(0, 16);
}

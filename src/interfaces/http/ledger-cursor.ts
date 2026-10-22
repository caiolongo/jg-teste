import { RequestValidationError } from './http-errors';

/**
 * Opaque, stable cursor: base64url of the wallet id and the last walletVersion returned.
 * walletVersion is unique and gap-free per wallet, so pages never skip or repeat entries as new ones are appended.
 */
export function encodeLedgerCursor(walletId: string, afterVersion: number): string {
  return Buffer.from(JSON.stringify({ w: walletId, v: afterVersion })).toString('base64url');
}

export function decodeLedgerCursor(walletId: string, cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { w?: unknown }).w === walletId &&
      Number.isInteger((parsed as { v?: unknown }).v) &&
      (parsed as { v: number }).v >= 0
    ) {
      return (parsed as { v: number }).v;
    }
  } catch {
    // fall through
  }
  throw new RequestValidationError('INVALID_CURSOR', 'cursor is invalid or belongs to another wallet');
}

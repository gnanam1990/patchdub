import { now, sha256 } from './util/hash.ts';
import type { DB } from './db.ts';

/**
 * Seller adapter contract (KITE-AND-PROVIDERS.md): quote, execute, inspect
 * status. Refund/cancel are NOT claimed. The live Kite rail is unavailable in
 * this local run, so the shipped adapter is a deterministic local emulator
 * whose order book is persisted in SQLite: receipts survive process restarts
 * and can be reconciled by original reference.
 */

export interface OrderItem {
  patchId: string;
  orderKey: string;
  sourceText: string;
  context: string[];
  targetLocale: string;
  glossaryDigest: string | null;
}

export interface OrderRequest {
  orderKey: string;
  purchaseId: string;
  items: OrderItem[];
  quoteMinor: number;
  token: string;
  decimals: number;
  idempotencyKey: string;
}

export interface OrderStatus {
  state: 'settled' | 'pending' | 'unknown' | 'failed';
  receipt?: Record<string, unknown>;
  results?: Record<string, string>; // patchId -> translated text
}

export interface SellerAdapter {
  id: string;
  rail: string;
  quote(items: OrderItem[]): { totalMinor: number; expiresAt: string };
  execute(order: OrderRequest): { externalRef: string };
  status(externalRef: string): OrderStatus;
}

/** Deterministic local translation table, overridable in tests. */
const DEFAULT_LEXICON: Record<string, string> = {};

export type SettleBehavior = 'auto' | 'manual' | 'unresolvable';

export class LocalSellerAdapter implements SellerAdapter {
  id = 'local-seller';
  rail = 'local-emulator';
  private db: DB;
  private settle: SettleBehavior;
  private lexicon: Record<string, string>;

  constructor(db: DB, opts?: { settle?: SettleBehavior; lexicon?: Record<string, string> }) {
    this.db = db;
    this.settle = opts?.settle ?? 'auto';
    this.lexicon = { ...DEFAULT_LEXICON, ...(opts?.lexicon ?? {}) };
  }

  quote(items: OrderItem[]) {
    return {
      totalMinor: items.length * 2,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  private translate(item: OrderItem): string {
    if (this.lexicon[item.sourceText]) return this.lexicon[item.sourceText];
    // Deterministic fallback: tagged Tamil marker, never silently English.
    return `[ta] ${item.sourceText}`;
  }

  execute(order: OrderRequest): { externalRef: string } {
    const externalRef = `ord_${sha256(order.orderKey).slice(0, 20)}`;
    const existing = this.db.prepare('SELECT external_ref FROM provider_orders WHERE external_ref = ?')
      .get(externalRef);
    if (existing) return { externalRef }; // keyed resubmission is a no-op (INV-07)

    const results: Record<string, string> = {};
    for (const item of order.items) results[item.patchId] = this.translate(item);
    const receipt = {
      ref: externalRef,
      amountMinor: order.quoteMinor,
      token: order.token,
      decimals: order.decimals,
      rail: this.rail,
      provider: this.id,
      orderKey: order.orderKey,
      itemCount: order.items.length,
      acceptedAt: now(),
      note: 'local emulator receipt; not a live settlement',
    };
    this.db.prepare(`INSERT INTO provider_orders(external_ref,order_key,items,amount_minor,token,state,receipt,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(externalRef, order.orderKey, JSON.stringify({ order, results }), order.quoteMinor,
        order.token, 'accepted', JSON.stringify(receipt), now(), now());
    return { externalRef };
  }

  status(externalRef: string): OrderStatus {
    const row = this.db.prepare('SELECT * FROM provider_orders WHERE external_ref = ?')
      .get(externalRef) as { state: string; receipt: string | null; items: string; amount_minor: number } | undefined;
    if (!row) return { state: 'unknown' };
    if (this.settle === 'unresolvable') return { state: 'unknown' };
    if (this.settle === 'manual' && row.state === 'accepted') return { state: 'pending' };
    if (row.state === 'settled') {
      return {
        state: 'settled',
        receipt: row.receipt ? JSON.parse(row.receipt) : undefined,
        results: JSON.parse(row.items).results,
      };
    }
    // auto / manual-after-settle: settle accepted orders and attach a receipt.
    const items = JSON.parse(row.items);
    const receipt = {
      ...(row.receipt ? JSON.parse(row.receipt) : {}),
      settledAt: now(),
      observedBy: 'independent-status-call',
    };
    this.db.prepare("UPDATE provider_orders SET state = 'settled', receipt = ?, updated_at = ? WHERE external_ref = ?")
      .run(JSON.stringify(receipt), now(), externalRef);
    return { state: 'settled', receipt, results: items.results };
  }

  /** Test/operator hook: settle an order the emulator holds as accepted. */
  _settle(externalRef: string): void {
    this.db.prepare("UPDATE provider_orders SET state = 'settled', updated_at = ? WHERE external_ref = ?")
      .run(now(), externalRef);
  }
}

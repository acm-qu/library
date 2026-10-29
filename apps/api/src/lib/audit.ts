import { auditLog, type Db } from '@acm/core/db';

type Tx = Pick<Db, 'insert'>;

/** Every admin mutation, tier change and delete writes one row (handoff §10.5). */
export function audit(db: Tx, actorId: string, action: string, target: { type: string; id: string }, data?: Record<string, unknown>) {
  return db.insert(auditLog).values({ actorId, action, targetType: target.type, targetId: target.id, data: data ?? null });
}

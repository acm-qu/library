import { type Db, users } from '@acm/core/db';
import { Me, PatchMeBody } from '@acm/core/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireUser, viewerOf } from '../auth/plugin.ts';

export function meRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/me', { preHandler: requireUser }, async (req) => Me.parse(viewerOf(req)));

  app.patch('/api/me', { preHandler: requireUser }, async (req) => {
    const body = PatchMeBody.parse(req.body);
    const [u] = await db.update(users).set(body).where(eq(users.id, viewerOf(req).id)).returning();
    return Me.parse({ ...u, isSuperadmin: viewerOf(req).isSuperadmin });
  });
}

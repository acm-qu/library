// Only `drizzle-kit generate` is used. Migrations are applied by scripts/migrate.ts (drizzle's migrator),
// locally and on the server, so the same SQL files run everywhere. Never use `push` against production.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/core/src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
});

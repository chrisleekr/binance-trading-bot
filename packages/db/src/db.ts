import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schemaModule from './schema/index.js';
import type { Database } from './repo/_db.js';

export const createDb = (pool: Pool): Database => drizzle(pool, { schema: schemaModule });

export type { Database };

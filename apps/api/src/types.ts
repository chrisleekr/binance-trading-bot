import type { UserId } from '@app/contracts';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { DI } from './di.js';

export interface Variables {
  requestId: string;
  userId?: UserId;
  // Mutated by audit middleware after a successful state-changing handler
  // returns; the middleware reads this and writes one audit_logs row.
  auditEvent?: { event: string; payload?: unknown };
}

export interface Env {
  Variables: Variables;
  Bindings: { di: DI };
}

export type ApiHono = OpenAPIHono<Env>;

/**
 * Factory for sub-router OpenAPIHono instances. Centralises the
 * `defaultHook` that re-throws zod-openapi's input-validation result so
 * the error flows through the shared `errorHandler` (project envelope)
 * instead of the library's `{success:false, error:{name:"ZodError"}}`
 * default. Use everywhere a sub-router is created.
 */
export const createApiHono = (): ApiHono =>
  new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });

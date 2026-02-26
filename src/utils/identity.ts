// amplify/functions/workflow-runner/src/utils/identity.ts

export type AuthType = 'PUBLIC' | 'AUTHED';

export interface AuthContext {
  authType: AuthType;
  actorId: string;
  actorUsername?: string | null;
  actorGroups: string[];
  orgId?: string | null;
}

export interface Caller {
  actorId: string;
  actorUsername?: string | null;
  actorGroups: string[];
  orgId?: string | null;
  authType: AuthType;
}

/** 
 * Extracts the caller identity from the Lambda event as injected by the API layer
 * Handles both public (unauthenticated) and authenticated requests
 */
export function getCaller(event: unknown): Caller {
  const e = event as { authContext?: Partial<AuthContext> };
  const ctx = e?.authContext ?? {};
  
  // Determine auth type - default to PUBLIC if not explicitly AUTHED
  const authType: AuthType = ctx.authType === 'AUTHED' ? 'AUTHED' : 'PUBLIC';
  
  // For public requests, use 'system' as actorId; for authed, use provided actorId
  const actorId = ctx.actorId && ctx.actorId.length > 0 ? ctx.actorId : 'system';
  
  // Ensure actorGroups is an array, default to empty for public
  const actorGroups = Array.isArray(ctx.actorGroups) ? ctx.actorGroups : [];
  
  return {
    actorId,
    actorUsername: ctx.actorUsername ?? null,
    actorGroups,
    orgId: ctx.orgId ?? null,
    authType,
  };
}
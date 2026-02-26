// amplify/functions/workflow-runner/src/utils/access.ts
export type Visibility = 'PRIVATE' | 'PUBLIC' | 'AUTHED' | 'SHARED' | 'ADMIN_ONLY';

export interface Workflow {
  id: string;
  owner: string;
  visibility: Visibility;
}

export interface WorkflowAccessRow {
  id: string;
  workflowId: string;
  principalType: 'USER';
  principalId: string;
  permissions: string; // JSON stringified array, e.g., '["RUN"]'
  workflowOwner: string;
  owner: string;       // grantor
  grantedBy: string;
}

export interface Models {
  Workflow: {
    get(input: { id: string }): Promise<{ data: Workflow | null }>;
  };
  WorkflowAccess: {
    list(input: {
      filter: {
        workflowId: { eq: string };
        principalType: { eq: 'USER' };
        principalId: { eq: string };
      };
      limit?: number;
    }): Promise<{ data: WorkflowAccessRow[] }>;
  };
}

export interface DataClient {
  models: Models;
}

export interface Caller {
  actorId: string;
  actorGroups: string[];
}

export interface AccessDecision {
  allowRun: boolean;
  workflowOwner: string;
  visibility: Visibility;
  reason?: string;
}

export interface RequestUser {
  userId: string;
  groups?: string[];
}

/** 
 * Central access decision function: Admin → Owner → ADMIN_ONLY → PUBLIC → AUTHED → SHARED → deny
 * This is the single source of truth for workflow access control
 */
export async function checkAccess(
  client: DataClient,
  workflowId: string,
  caller: Caller
): Promise<AccessDecision> {
  // Step 1: Fetch the workflow
  const wfRes = await client.models.Workflow.get({ id: workflowId });
  const wf = wfRes.data;
  
  if (!wf) {
    return { 
      allowRun: false, 
      workflowOwner: 'unknown', 
      visibility: 'PRIVATE', 
      reason: 'NOT_FOUND' 
    };
  }

  // Step 2: Check if user is Admin (highest privilege)
  const isAdmin = caller.actorGroups.includes('Admin');
  if (isAdmin) {
    return { 
      allowRun: true, 
      workflowOwner: wf.owner, 
      visibility: wf.visibility 
    };
  }

  // Step 3: Check if user is the workflow owner
  if (caller.actorId === wf.owner) {
    return { 
      allowRun: true, 
      workflowOwner: wf.owner, 
      visibility: wf.visibility 
    };
  }

  // Step 4: Apply visibility rules in order of precedence
  
  // ADMIN_ONLY - only admins and owners can access (already checked above)
  if (wf.visibility === 'ADMIN_ONLY') {
    return { 
      allowRun: false, 
      workflowOwner: wf.owner, 
      visibility: wf.visibility, 
      reason: 'ADMIN_ONLY' 
    };
  }

  // PUBLIC - anyone can access (including unauthenticated)
  if (wf.visibility === 'PUBLIC') {
    return { 
      allowRun: true, 
      workflowOwner: wf.owner, 
      visibility: wf.visibility 
    };
  }

  // AUTHED - any authenticated user can access
  if (wf.visibility === 'AUTHED') {
    if (caller.actorId !== 'system') {
      return { 
        allowRun: true, 
        workflowOwner: wf.owner, 
        visibility: wf.visibility 
      };
    }
    return { 
      allowRun: false, 
      workflowOwner: wf.owner, 
      visibility: wf.visibility, 
      reason: 'AUTH_REQUIRED' 
    };
  }

  // SHARED - only specific users with RUN permission can access
  if (wf.visibility === 'SHARED') {
    if (caller.actorId === 'system') {
      return { 
        allowRun: false, 
        workflowOwner: wf.owner, 
        visibility: wf.visibility, 
        reason: 'AUTH_REQUIRED' 
      };
    }
    
    // Check WorkflowAccess table for explicit permission
    const accessList = await client.models.WorkflowAccess.list({
      filter: {
        workflowId: { eq: workflowId },
        principalType: { eq: 'USER' },
        principalId: { eq: caller.actorId },
      },
      limit: 50,
    });
    
    const hasRunPermission = accessList.data.some((row) => {
      try {
        const perms: unknown = JSON.parse(row.permissions);
        return Array.isArray(perms) && perms.includes('RUN');
      } catch {
        return false;
      }
    });
    
    return hasRunPermission
      ? { allowRun: true, workflowOwner: wf.owner, visibility: wf.visibility }
      : { allowRun: false, workflowOwner: wf.owner, visibility: wf.visibility, reason: 'NOT_SHARED' };
  }

  // PRIVATE (default) - only owner and admins can access
  return { 
    allowRun: false, 
    workflowOwner: wf.owner, 
    visibility: wf.visibility, 
    reason: 'PRIVATE' 
  };
}

export function enforceWorkflowAccess(params: {
  workflow: { id: string; owner: string; visibility: 'PRIVATE'|'PUBLIC'|'AUTHED'|'SHARED'|'ADMIN_ONLY' };
  user: RequestUser | null;            // null for public route
  route: 'PUBLIC' | 'AUTHED';
}): void {
  const { workflow, user, route } = params;

  if (route === 'PUBLIC') {
    if (workflow.visibility !== 'PUBLIC') {
      throw new Error('FORBIDDEN: Workflow is not public');
    }
    return;
  }

  // AUTHED route:
  if (!user?.userId) throw new Error('UNAUTHORIZED');

  // Owner
  if (user.userId === workflow.owner) return;

  // Admin-only
  if (workflow.visibility === 'ADMIN_ONLY') {
    if (user.groups?.includes('Admin')) return; // Fixed: use 'Admin' (capital A)
    throw new Error('FORBIDDEN: Admin only');
  }

  // Authed (any signed-in user)
  if (workflow.visibility === 'AUTHED') return;

  // Shared (must have grant)
  if (workflow.visibility === 'SHARED') {
    // IMPLEMENT real WorkflowAccess lookup here:
    // if (await hasWorkflowShareGrant(workflow.id, user.userId, user.groups)) return;
    throw new Error('FORBIDDEN: No share grant');
  }

  // Private (owner only, we already checked owner)
  if (workflow.visibility === 'PRIVATE') {
    throw new Error('FORBIDDEN: Private workflow');
  }

  throw new Error('FORBIDDEN');
}
// amplify/functions/workflow-runner/src/utils/slotState.ts

import type { Schema } from "@platform/data/resource";

type DataClient = ReturnType<typeof import("aws-amplify/data").generateClient<Schema>>;

/**
 * Shape of persisted slot state stored in Conversation.metadata.slotState
 */
export interface PersistedSlotState {
  slotValues: Record<string, string>;
  slotAttempts: Record<string, number>;
  currentSlotKey: string;
  allSlotsFilled: boolean;
  updatedAt: string;
}

/**
 * Load SlotTracker state from Conversation.metadata
 * 
 * @param dataClient - Amplify data client
 * @param conversationId - Conversation ID
 * @returns Persisted slot state or empty object
 */
export async function loadSlotState(
  dataClient: DataClient,
  conversationId: string
): Promise<Partial<PersistedSlotState>> {
  try {
    const result = await dataClient.models.Conversation.get(
      { id: conversationId },
      { selectionSet: ['id', 'metadata'] }
    );

    if (!result.data?.metadata) {
      return {};
    }

    // Parse metadata JSON
    const metadata = typeof result.data.metadata === 'string'
      ? JSON.parse(result.data.metadata)
      : result.data.metadata;

    // Return slotState namespace or empty
    return metadata?.slotState || {};
  } catch (error) {
    console.error('Failed to load slot state:', error);
    return {};
  }
}

/**
 * Save SlotTracker state to Conversation.metadata (shallow merge)
 * 
 * @param dataClient - Amplify data client
 * @param conversationId - Conversation ID
 * @param slotState - Partial slot state to save
 */
export async function saveSlotState(
  dataClient: DataClient,
  conversationId: string,
  slotState: Partial<PersistedSlotState>
): Promise<void> {
  try {
    // First, get existing metadata
    const result = await dataClient.models.Conversation.get(
      { id: conversationId },
      { selectionSet: ['id', 'metadata'] }
    );

    if (!result.data) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Parse existing metadata
    let existingMetadata: Record<string, unknown> = {};
    if (result.data.metadata) {
      existingMetadata = typeof result.data.metadata === 'string'
        ? JSON.parse(result.data.metadata)
        : result.data.metadata;
    }

    // Merge slot state into metadata.slotState namespace
    const updatedMetadata = {
      ...existingMetadata,
      slotState: {
        ...(existingMetadata.slotState as Record<string, unknown> || {}),
        ...slotState,
        updatedAt: new Date().toISOString(),
      },
    };

    // Save back to database
    await dataClient.models.Conversation.update({
      id: conversationId,
      metadata: JSON.stringify(updatedMetadata),
    });

    console.log('✅ Saved slot state to Conversation.metadata', {
      conversationId,
      slotCount: Object.keys(slotState.slotValues || {}).length,
      currentSlotKey: slotState.currentSlotKey,
    });
  } catch (error) {
    console.error('❌ Failed to save slot state:', error);
    throw error;
  }
}

/**
 * Clear SlotTracker state from Conversation.metadata
 * Call this when slot collection is complete
 * 
 * @param dataClient - Amplify data client
 * @param conversationId - Conversation ID
 */
export async function clearSlotState(
  dataClient: DataClient,
  conversationId: string
): Promise<void> {
  try {
    // Get existing metadata
    const result = await dataClient.models.Conversation.get(
      { id: conversationId },
      { selectionSet: ['id', 'metadata'] }
    );

    if (!result.data?.metadata) {
      return; // Nothing to clear
    }

    // Parse existing metadata
    const existingMetadata = typeof result.data.metadata === 'string'
      ? JSON.parse(result.data.metadata)
      : result.data.metadata;
    
    // Remove slotState namespace (avoid unused binding)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { slotState: _ignored, ...remainingMetadata } = existingMetadata;

    // Save back (or delete metadata if empty)
    await dataClient.models.Conversation.update({
      id: conversationId,
      metadata: Object.keys(remainingMetadata).length > 0
        ? JSON.stringify(remainingMetadata)
        : null,
    });

    console.log('✅ Cleared slot state from Conversation.metadata', {
      conversationId,
    });
  } catch (error) {
    console.error('❌ Failed to clear slot state:', error);
    // Non-fatal - continue execution
  }
}
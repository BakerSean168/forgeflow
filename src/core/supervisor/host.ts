import type { SupervisorProjection } from './projection.js';

export interface SupervisorConversation {
  conversationId: string;
  replaced: boolean;
}

export interface SupervisorConversationHost {
  startOrResume(input: {
    supervisorId: string;
    planId: string;
    conversationId?: string;
    projection: SupervisorProjection;
  }): Promise<SupervisorConversation>;
}

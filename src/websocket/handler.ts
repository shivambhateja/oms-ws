import { ChatMessage } from '../types/message.js';
import { WebSocketServer } from './server.js';
import { OrchestratorService } from '../orchestrator/service.js';

export class MessageHandler {
  private orchestrator: OrchestratorService;

  constructor(orchestrator: OrchestratorService) {
    this.orchestrator = orchestrator;
  }

  async handleUserMessage(
    chatId: string,
    userMessage: ChatMessage,
    wsServer: WebSocketServer,
    selectedDocuments?: string[],
    cartData?: {
      items: Array<{
        id: string;
        type: "publisher" | "product";
        name: string;
        price: number;
        quantity: number;
        addedAt?: string;
        metadata?: {
          publisherId?: string;
          website?: string;
          niche?: string[];
          dr?: number;
          da?: number;
        };
      }>;
      totalItems: number;
      totalPrice: number;
    }
  ): Promise<void> {
    await this.orchestrator.processMessage(chatId, userMessage, wsServer, selectedDocuments, cartData);
  }

  handleStop(chatId: string): void {
    this.orchestrator.cancel(chatId);
  }
}


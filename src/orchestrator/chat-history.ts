import { ChatMessage } from '../types/message.js';

/**
 * ChatHistoryManager - Keeps track of messages per chat room
 * 
 * Since we're not using a database, this stores messages in memory.
 * Messages are organized by chatId/roomId.
 */

interface ChatHistory {
  messages: ChatMessage[];
  lastActivity: number;
}

export class ChatHistoryManager {
  private histories: Map<string, ChatHistory> = new Map();
  
  // Auto-cleanup after 1 hour of inactivity
  private readonly CLEANUP_INTERVAL = 1000 * 60 * 60; // 1 hour
  
  constructor() {
    // Start cleanup timer
    setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  /**
   * Get conversation history for a chat
   */
  getHistory(chatId: string): ChatMessage[] {
    const history = this.histories.get(chatId);
    if (!history) {
      return [];
    }
    return [...history.messages]; // Return copy
  }

  /**
   * Add a message to chat history
   */
  addMessage(chatId: string, message: ChatMessage): void {
    let history = this.histories.get(chatId);
    
    if (!history) {
      history = {
        messages: [],
        lastActivity: Date.now(),
      };
      this.histories.set(chatId, history);
    }

    history.messages.push(message);
    history.lastActivity = Date.now();
    
    // Message added to chat history
  }

  /**
   * Get full conversation including system prompt
   */
  getConversation(chatId: string, systemPrompt: string): ChatMessage[] {
    const history = this.getHistory(chatId);
    
    // If no history, return just system prompt
    if (history.length === 0) {
      return [];
    }

    return history;
  }

  /**
   * Clear history for a specific chat
   */
  clearHistory(chatId: string): void {
    this.histories.delete(chatId);
  }

  /**
   * Get all active chat IDs
   */
  getActiveChatIds(): string[] {
    return Array.from(this.histories.keys());
  }

  /**
   * Get total message count across all chats
   */
  getTotalMessageCount(): number {
    let total = 0;
    for (const history of this.histories.values()) {
      total += history.messages.length;
    }
    return total;
  }

  /**
   * Cleanup old chats (> 1 hour inactive)
   */
  private cleanup(): void {
    const now = Date.now();
    const idsToDelete: string[] = [];

    for (const [chatId, history] of this.histories.entries()) {
      if (now - history.lastActivity > this.CLEANUP_INTERVAL) {
        idsToDelete.push(chatId);
      }
    }

    for (const chatId of idsToDelete) {
      this.histories.delete(chatId);
    }

    // Cleanup completed
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalChats: this.histories.size,
      totalMessages: this.getTotalMessageCount(),
      chatIds: this.getActiveChatIds(),
    };
  }
}


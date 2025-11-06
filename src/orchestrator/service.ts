import { OpenAIProvider, OpenAIModel, AvailableFunction, FunctionCallResponse } from '../llm/openai.js';
import { ChatMessage, Role } from '../types/message.js';
import { WebSocketServer } from '../websocket/server.js';
import { MessageType } from '../websocket/protocol.js';
import { browsePublishers, BrowsePublishersArgs, BrowsePublishersResult } from '../tools/publishers.js';
import { ChatHistoryManager } from './chat-history.js';
import { EmbeddingService } from '../services/embeddings.js';
import { PineconeService } from '../services/pinecone.js';
import { EmbeddingQueue } from '../queues/embedding-queue.js';

function safeArgs(value: unknown, maxLen: number = 600): string {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
  } catch {
    return '[unserializable]';
  }
}

export class OrchestratorService {
  private openai: OpenAIProvider;
  private abortControllers: Map<string, AbortController> = new Map();
  private chatHistory: ChatHistoryManager;
  private embedder?: EmbeddingService;
  private pinecone?: PineconeService;
  private embeddingQueue?: EmbeddingQueue;

  constructor(openAiApiKey: string, opts?: { embedder?: EmbeddingService; pinecone?: PineconeService; embeddingQueue?: EmbeddingQueue }) {
    this.openai = new OpenAIProvider(openAiApiKey);
    this.chatHistory = new ChatHistoryManager();
    this.embedder = opts?.embedder;
    this.pinecone = opts?.pinecone;
    this.embeddingQueue = opts?.embeddingQueue;
  }

  private readonly SYSTEM_PROMPT = `You are an AI assistant with access to backend tools.

## Your Process:
1. Analyze the user's intent
2. Decide if you need tools or can respond directly
3. If tools are needed, call them with clear reasoning about your choice
4. Interpret the results and provide a helpful summary

## Available Tools:
- browsePublishers: Search publishers for backlinking opportunities
- viewCart: View the current shopping cart contents. Use this to show the user their cart.
- addToCart: Add a publisher or product to the shopping cart. Use this when user wants to add items.
- processPayment: Process payment for cart items. Use this when user is ready to checkout.

## Cart and Checkout Flow:
1. After browsePublishers is called, proactively suggest adding publishers to cart
2. When user mentions specific publishers or says "add these" or "add to cart", use addToCart for each selected publisher
3. After items are added to cart, ALWAYS call viewCart to show the user their current cart
4. When showing the cart, ask the user: "Would you like to edit anything in your cart, or are you ready to proceed to checkout?"
5. If user says they're done or ready to checkout, call processPayment with the current cart items
6. If user wants to edit the cart, wait for their changes and then show cart again

## Rules:
- For simple questions or greetings, respond directly without tools
- For document-related tasks (e.g., "summarize this doc", "explain the document", or when user provided referenced documents), DO NOT call any tools. Use the referenced document context provided to you and respond directly.
- Only use browsePublishers / cart tools when the user's intent is explicitly about finding, viewing, adding, or purchasing publishers/products.
- Provide clear reasoning when choosing to use a tool
- Keep responses conversational and helpful
- After showing publishers, immediately suggest adding selected publishers to cart
- When user mentions cart, always show the cart using viewCart

## Examples:
User: "Hi"
You: "Hello! How can I help you today?"

User: "Find publishers in tech"
You: "Let me search for tech publishers for you. [reasoning about using browsePublishers tool]"

User: "Add TechCrunch to cart"
You: "I'll add TechCrunch to your cart. [call addToCart] Now showing your cart... [call viewCart]"

User: "Show my cart"
You: "Let me show you your current cart. [call viewCart]"`;

  async processMessage(
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
    try {
      // Add user message to history
      this.chatHistory.addMessage(chatId, userMessage);

      // Debug: log selected document references if any
      try {
        if (Array.isArray(selectedDocuments)) {
          console.log(`[DocRAG] SelectedDocuments received chatId=${chatId} count=${selectedDocuments.length} ids=${selectedDocuments.join(',')}`);
        }
      } catch {}

      // After adding to history, enqueue embedding of the user message (non-blocking)
      try {
        const userId = (wsServer as any).getUserIdForChat?.(chatId) as string | undefined;
        if (userId && this.embeddingQueue && userMessage?.content) {
          this.embeddingQueue.enqueue({
            userId,
            chatId,
            messageId: `user_${Date.now()}`,
            role: 'user',
            content: userMessage.content,
            createdAt: new Date().toISOString(),
          });
          console.log(`[RAG] Enqueued user embedding chatId=${chatId}`);
        }
      } catch {}

      // Get conversation history for this chat
      const messageHistory = this.chatHistory.getHistory(chatId);
      
      // Build conversation with system prompt + history
      // Include cart context in system prompt if available
      let systemPrompt = this.SYSTEM_PROMPT;

      // Inject Personalization Context via RAG (non-blocking if services missing)
      try {
        const userId = (wsServer as any).getUserIdForChat?.(chatId) as string | undefined;
        if (userId && this.embedder && this.pinecone && userMessage?.content) {
          const start = Date.now();
          console.log(`[RAG] Retrieval start chatId=${chatId} userId=${userId}`);
          
          // Expand query for better personal information retrieval
          // If user asks about "my X" or "tell me my Y", enhance the query
          const userQuery = userMessage.content.toLowerCase();
          const isPersonalQuery = /\b(my|tell me my|what is my|what's my|my favorite|my fav)\b/.test(userQuery);
          
          let queryText = userMessage.content;
          if (isPersonalQuery) {
            // Expand query to include synonyms and related terms for better matching
            queryText = `${userMessage.content}\n\nuser personal information profile preference favorite likes dislikes company ownership identity facts about me`;
          }
          
          // General embedding
          const { embedding } = await this.embedder.embed(queryText);
          // Profile-hinted embedding for better recall of personal facts
          const profileHintText = `${queryText}\n\nuser profile preference favorite company ownership identity personal details`; 
          const { embedding: profileEmbedding } = await this.embedder.embed(profileHintText);
          if (embedding && embedding.length > 0) {
            const topK = 15;
            const results = await this.pinecone.query({
              namespace: userId,
              vector: embedding,
              topK,
              filter: undefined,
            });
            // Second pass: profile-focused
            let profileResults: typeof results = [];
            try {
              profileResults = await this.pinecone.query({
                namespace: userId,
                vector: profileEmbedding && profileEmbedding.length > 0 ? profileEmbedding : embedding,
                topK: 10,
                filter: { isProfile: true },
              });
            } catch {}

            const merged = [...(results || []), ...(profileResults || [])];
            // Deduplicate by id, keep best score
            const bestById = new Map<string, { id: string; score: number; metadata?: any }>();
            for (const m of merged) {
              const prev = bestById.get(m.id);
              if (!prev || (typeof m.score === 'number' && m.score > prev.score)) bestById.set(m.id, m as any);
            }
            const deduped = Array.from(bestById.values());
            // Apply lower threshold and fallback: keep at least top 3
            const threshold = 0.3;
            let filtered = deduped.filter(r => typeof r.score === 'number' ? r.score >= threshold : true);
            if (filtered.length < 3) {
              filtered = deduped
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .slice(0, Math.min(3, deduped.length));
            }
            // Ensure top 3 profile facts are included regardless of score
            const profileTop = deduped
              .filter(r => (r as any)?.metadata?.isProfile)
              .sort((a, b) => (b.score || 0) - (a.score || 0))
              .slice(0, 3);
            const finalMap = new Map<string, typeof filtered[number]>();
            [...filtered, ...profileTop].forEach(m => finalMap.set(m.id, m));
            const finalList = Array.from(finalMap.values()).slice(0, topK);
            console.log(`[RAG] Retrieval success chatId=${chatId} userId=${userId} matches=${finalList.length} ms=${Date.now() - start}`);
            if (finalList.length > 0) {
              // Separate profile/preference facts from general conversation
              const profileFacts = finalList.filter(r => (r as any)?.metadata?.isProfile || (r as any)?.metadata?.isPreference);
              const conversationContext = finalList.filter(r => !(r as any)?.metadata?.isProfile && !(r as any)?.metadata?.isPreference);
              
              let contextSection = '\n\n## USER PERSONAL INFORMATION (IMPORTANT: Use this when answering questions about the user)\n';
              contextSection += 'The following information has been retrieved from previous conversations with this user. ';
              contextSection += 'ALWAYS reference and use this information when the user asks about their preferences, facts, or personal details:\n\n';
              
              if (profileFacts.length > 0) {
                profileFacts.forEach((r, idx) => {
                  const text = (r as any)?.metadata?.text as string | undefined;
                  const role = (r as any)?.metadata?.role as string | undefined;
                  if (text) {
                    contextSection += `[${idx + 1}] ${text}\n`;
                  }
                });
                contextSection += '\n';
              }
              
              if (conversationContext.length > 0) {
                contextSection += '## RELEVANT CONVERSATION HISTORY:\n';
                contextSection += 'Use this context to maintain continuity and reference previous discussions:\n\n';
                conversationContext.forEach((r, idx) => {
                  const text = (r as any)?.metadata?.text as string | undefined;
                  const role = (r as any)?.metadata?.role as string | undefined;
                  if (text) {
                    contextSection += `[${idx + 1}] ${role === 'user' ? 'User said' : 'You said'}: ${text}\n`;
                  }
                });
                contextSection += '\n';
              }
              
              contextSection += 'REMEMBER: When the user asks "tell me my X" or "what is my Y", use the information above. ';
              contextSection += 'Do NOT say you don\'t have access - you have this information from their conversation history.\n';
              
              systemPrompt += contextSection;

              console.log('reached here', selectedDocuments);

              // Document-context retrieval if user selected documents
              if (selectedDocuments && selectedDocuments.length > 0) {
                console.log('selectedDocuments', selectedDocuments);
                console.log(`[DocRAG] Attempting document retrieval userId=${userId} namespace=user_${userId}_docs selected=${selectedDocuments.length}`);
                try {
                  const { DocumentRetrievalService } = await import('../services/document-retrieval.js');
                  const docRetriever = new DocumentRetrievalService(this.pinecone!);
                  const docMatches = await docRetriever.querySelectedDocuments({
                    userId,
                    queryEmbedding: embedding,
                    selectedDocuments,
                    topKPerDoc: 3,
                    minScore: 0.3,
                  });

                  if (docMatches.length > 0) {
                    const grouped: Record<string, { name?: string; chunks: { score: number; content: string }[] }> = {};
                    for (const m of docMatches) {
                      const entry = grouped[m.documentId] || { name: m.documentName, chunks: [] };
                      entry.chunks.push({ score: m.score, content: m.content });
                      grouped[m.documentId] = entry;
                    }
                    const docContext = Object.entries(grouped)
                      .map(([docId, info]) => {
                        const name = info.name ? ` (${info.name})` : '';
                        const bullets = info.chunks
                          .sort((a, b) => b.score - a.score)
                          .slice(0, 5)
                          .map(c => `- ${c.content}`)
                          .join('\n');
                        return `Document ${docId}${name}:\n${bullets}`;
                      })
                      .join('\n\n');

                    const section = `## REFERENCED DOCUMENTS\nUse the following context from the user's selected documents if relevant:\n${docContext}\n`;
                    // Insert the section before the Examples block so it shows up early in the prompt preview
                    if (systemPrompt.includes('## Examples:')) {
                      systemPrompt = systemPrompt.replace('## Examples:', `${section}\n## Examples:`);
                    } else {
                      systemPrompt = `${systemPrompt}\n\n${section}`;
                    }
                    console.log(`[DocRAG] Injected ${docMatches.length} chunks from ${selectedDocuments.length} selected documents`);
                    console.log('[DocRAG] Section preview:\n', section.slice(0, 800));
                  } else {
                    console.log('[DocRAG] No matches for selected documents');
                  }
                } catch (err) {
                  console.error('[DocRAG] Retrieval failed:', err);
                }
              }

              // Debug logging
              console.log(`[RAG] Context injected: profileFacts=${profileFacts.length} conversationContext=${conversationContext.length}`);
              if (profileFacts.length > 0) {
                console.log(`[RAG] Profile facts preview:`, profileFacts.slice(0, 2).map(r => 
                  ((r as any)?.metadata?.text as string || '').slice(0, 100)
                ));
              }
            }
          } else {
            console.log(`[RAG] Skipped: empty embedding chatId=${chatId}`);
          }
        } else {
          console.log(`[RAG] Retrieval disabled or missing identity chatId=${chatId} hasUserId=${!!userId} hasEmbedder=${!!this.embedder} hasPinecone=${!!this.pinecone}`);
        }
      } catch {
        // On any retrieval failure, proceed without personalization context
        console.error(`[RAG] Retrieval failed chatId=${chatId}`);
      }
      if (cartData && cartData.items.length > 0) {
        systemPrompt += `\n\n## Current Cart Context:
- Cart has ${cartData.totalItems} item${cartData.totalItems !== 1 ? 's' : ''} totaling $${cartData.totalPrice.toFixed(2)}
- Items: ${cartData.items.map(item => `${item.name} (${item.quantity}x)`).join(', ')}
- When calling viewCart, use this cart data: ${JSON.stringify({ cartItems: cartData.items })}
`;
      }
      
      const conversation: ChatMessage[] = [
        { role: Role.System, content: systemPrompt },
        ...messageHistory
      ];

      // Debug: log final system prompt/context being sent to the model (truncated for safety)
      try {
        const hasDocContext = systemPrompt.includes('## REFERENCED DOCUMENTS') || systemPrompt.includes('# Referenced Documents') || systemPrompt.includes('## USER PERSONAL INFORMATION');
        const preview = systemPrompt.length > 2000 ? `${systemPrompt.slice(0, 2000)}…` : systemPrompt;
        console.log('[AI] Final system prompt length=', systemPrompt.length, 'hasDocContext=', hasDocContext);
        console.log('[AI] Final system prompt preview:\n', preview);
      } catch {}

      // STEP 1: Analyze intent and decide on tool usage
      // Support cancellation per chat via AbortController
      const controller = new AbortController();
      this.abortControllers.set(chatId, controller);

      // Guard tools: disable tools for document-summary style intents or when user provided selected document references
      const lowered = (userMessage.content || '').toLowerCase();
      const looksLikeDocTask = /\b(summarize|summary|summarise|explain|analyze|analyse|document|doc|pdf|csv|xlsx|txt)\b/.test(lowered);
      const hasSelectedDocs = typeof (selectedDocuments as any)?.length === 'number' && (selectedDocuments as any).length > 0;
      const shouldUseFunctions = !(looksLikeDocTask || hasSelectedDocs);

      const analysisResponse = await this.openai.call(
        conversation,
        OpenAIModel.GPT35Turbo,
        shouldUseFunctions,
        [],
        controller.signal
      );

      const candidate = analysisResponse.candidates[0];
      if (!candidate || !candidate.content?.parts) {
        this.sendErrorMessage(chatId, 'No response from AI', wsServer);
        return;
      }

      const parts = candidate.content.parts;
      let functionToCall: FunctionCallResponse | null = null;
      let intentAnalysis = '';

      // Process intent analysis and tool decision
      for (const part of parts) {
        if (part.text && part.text.trim()) {
          intentAnalysis = part.text;
          
          // Stream the reasoning to frontend (but don't add to history yet - will add later)
          await this.streamTextResponse(chatId, part.text, wsServer);
        }

        if (part.functionCall) {
          functionToCall = part.functionCall;
          this.sendFunctionCallMessage(chatId, functionToCall, wsServer);
        }
      }

      // STEP 2: Execute tool if needed
      if (functionToCall) {
        // Notify frontend that tool execution is starting
        this.sendFunctionCallStartMessage(chatId, functionToCall.name, wsServer);
        
        const toolResult = await this.executeFunction(functionToCall, chatId, wsServer, cartData);

        // Notify frontend that tool execution completed
        this.sendFunctionCallEndMessage(chatId, functionToCall.name, wsServer);

        // If there was no intent analysis text, create a simple one
        const assistantContent = intentAnalysis || `I'm using the ${functionToCall.name} tool to help with your request.`;
        
        // For OpenAI, we don't add the function response here because we don't have the tool_call_id
        // Instead, we'll format it as text for the summary
        const formattedResult = typeof toolResult === 'object' 
          ? JSON.stringify(toolResult, null, 2)
          : String(toolResult);
        
        // Add to conversation for final summary with context
        conversation.push({
          role: Role.Assistant,
          content: assistantContent
        });
        
        // Add function result as a user message for context (OpenAI compatibility)
        conversation.push({
          role: Role.User,
          content: `The ${functionToCall.name} function returned: ${formattedResult}. Please summarize the results.`
        });

        this.chatHistory.addMessage(chatId, {
          role: Role.Assistant,
          content: assistantContent
        });
        
        this.chatHistory.addMessage(chatId, {
          role: Role.Function,
          content: JSON.stringify(toolResult),
          name: functionToCall.name
        });

        this.sendFunctionResultMessage(chatId, functionToCall.name, toolResult, wsServer);

        // STEP 3: Generate final summary
        const summaryResponse = await this.openai.call(
          conversation,
          OpenAIModel.GPT35Turbo,
          false // No functions needed for summary
        );

        const summaryCandidate = summaryResponse.candidates[0];

        if (summaryCandidate?.content?.parts) {
          let summaryText = '';
          for (const part of summaryCandidate.content.parts) {
            if (part.text && part.text.trim()) {
              summaryText = part.text;
              await this.streamTextResponse(chatId, part.text, wsServer);
              
              const finalMessage: ChatMessage = {
                role: Role.Assistant,
                content: part.text
              };
              this.chatHistory.addMessage(chatId, finalMessage);

              // Enqueue embeddings for assistant final message (non-blocking)
              try {
                const userId = (wsServer as any).getUserIdForChat?.(chatId) as string | undefined;
                if (userId && this.embeddingQueue) {
                  this.embeddingQueue.enqueue({
                    userId,
                    chatId,
                    messageId: `assistant_${Date.now()}`,
                    role: 'assistant',
                    content: part.text,
                    createdAt: new Date().toISOString(),
                  });
                  console.log(`[RAG] Enqueued assistant embedding chatId=${chatId}`);
                }
              } catch {}
            }
          }
        }
      } else {
        // No tool needed - just respond directly
        if (intentAnalysis) {
          const finalMessage: ChatMessage = {
            role: Role.Assistant,
            content: intentAnalysis
          };
          this.chatHistory.addMessage(chatId, finalMessage);

          // Enqueue embeddings for assistant direct response
          try {
            const userId = (wsServer as any).getUserIdForChat?.(chatId) as string | undefined;
            if (userId && this.embeddingQueue) {
              this.embeddingQueue.enqueue({
                userId,
                chatId,
                messageId: `assistant_${Date.now()}`,
                role: 'assistant',
                content: intentAnalysis,
                createdAt: new Date().toISOString(),
              });
              console.log(`[RAG] Enqueued assistant embedding chatId=${chatId}`);
            }
          } catch {}
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Try to have AI acknowledge the error gracefully
      try {
        const errorAckMessage: ChatMessage = {
          role: Role.User,
          content: `I encountered an error while processing your request: ${errorMessage}. Please acknowledge this error and explain to the user what happened.`
        };
        
        // Get conversation history
        const messageHistory = this.chatHistory.getHistory(chatId);
        const conversation: ChatMessage[] = [
          { role: Role.System, content: this.SYSTEM_PROMPT },
          ...messageHistory,
          errorAckMessage
        ];

        const errorResponse = await this.openai.call(
          conversation,
          OpenAIModel.GPT35Turbo,
          false // No functions needed for error acknowledgment
        );

        const errorCandidate = errorResponse.candidates?.[0];
        if (errorCandidate?.content?.parts) {
          for (const part of errorCandidate.content.parts) {
            if (part.text && part.text.trim()) {
              await this.streamTextResponse(chatId, part.text, wsServer);
              const errorAckFinal: ChatMessage = {
                role: Role.Assistant,
                content: part.text
              };
              this.chatHistory.addMessage(chatId, errorAckFinal);
            }
          }
        }
      } catch (ackError) {
        // If even the error acknowledgment fails, just send a simple error message
        this.sendErrorMessage(chatId, `Error: ${errorMessage}`, wsServer);
      }
    }
  }

  cancel(chatId: string) {
    const controller = this.abortControllers.get(chatId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(chatId);
    }
  }

  /**
   * Get chat history stats (for debugging)
   */
  getHistoryStats() {
    return this.chatHistory.getStats();
  }

  /**
   * Clear history for a specific chat
   */
  clearChatHistory(chatId: string) {
    this.chatHistory.clearHistory(chatId);
  }

  private async executeFunction(
    functionCall: FunctionCallResponse,
    chatId: string,
    wsServer: WebSocketServer,
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
  ): Promise<unknown> {
    switch (functionCall.name) {
      case AvailableFunction.BrowsePublishers: {
        const publisherArgs = functionCall.args as unknown as BrowsePublishersArgs;
        try {
          // Call the function to get data
          const result: BrowsePublishersResult = await browsePublishers(publisherArgs);
          
          // Send FULL DATA directly to frontend (bypassing AI context)
          wsServer.broadcastToRoom(chatId, {
            type: MessageType.PublishersData,
            payload: {
              publishers: result.publishers,
              totalCount: result.totalCount,
              filters: result.filters
            },
            timestamp: Date.now(),
            message_id: `data_${Date.now()}`
          });
          
          // Return ONLY summary to AI context (saves tokens!)
          return {
            summary: result.summary,
            count: result.totalCount,
            message: 'Full results sent to user interface'
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            error: true,
            function: 'browsePublishers',
            message: `Failed to fetch publishers: ${errorMessage}`,
            details: 'The publisher search service encountered an error. Please try again later or adjust your search criteria.'
          };
        }
      }

      case AvailableFunction.ViewCart: {
        // Add artificial 4-second delay to show loading state (like publishers)
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Get cart data from function call args, or use cartData from message context
        const cartItems = (functionCall.args as { cartItems?: unknown[] })?.cartItems;
        
        // Use cartData from message context if available (it has current cart state)
        // Only use args if explicitly provided and cartData is not available
        const itemsToUse = cartData?.items && cartData.items.length > 0
          ? cartData.items
          : (cartItems && cartItems.length > 0 ? cartItems : []);
        
        // Calculate summary
        const totalItems = Array.isArray(itemsToUse) ? itemsToUse.length : 0;
        const totalQuantity = Array.isArray(itemsToUse) 
          ? itemsToUse.reduce((sum: number, item: any) => sum + (item.quantity || 1), 0)
          : 0;
        const totalPrice = Array.isArray(itemsToUse)
          ? itemsToUse.reduce((sum: number, item: any) => sum + ((item.price || 0) * (item.quantity || 1)), 0)
          : 0;
        
        // Send CartData message with summary (like PublishersData)
        wsServer.broadcastToRoom(chatId, {
          type: MessageType.CartData,
          payload: {
            action: 'show',
            summary: {
              totalItems,
              totalQuantity,
              totalPrice,
              isEmpty: totalItems === 0
            },
            cartData: {
              items: Array.isArray(itemsToUse) ? itemsToUse.slice(0, 3) : [], // First 3 items for preview
              totalItems,
              totalPrice
            },
            message: totalItems === 0 ? 'Cart is empty' : `Your cart has ${totalItems} item${totalItems !== 1 ? 's' : ''}`
          },
          timestamp: Date.now(),
          message_id: `cart_${Date.now()}`
        });
        
        // Return summary to AI (saves tokens)
        return {
          summary: {
            totalItems,
            totalQuantity,
            totalPrice,
            isEmpty: totalItems === 0
          },
          message: totalItems === 0 
            ? 'Cart is empty. User can add items from publisher search results.'
            : `Cart has ${totalItems} item${totalItems !== 1 ? 's' : ''} totaling $${totalPrice.toFixed(2)}. Full cart data sent to user interface.`
        };
      }

      case AvailableFunction.AddToCart: {
        const cartArgs = functionCall.args as {
          type: "publisher" | "product";
          name: string;
          price: number;
          quantity?: number;
          metadata?: {
            publisherId?: string;
            website?: string;
            niche?: string[];
            dr?: number;
            da?: number;
          };
        };
        
        // Send CartUpdated message to frontend with item to add
        wsServer.broadcastToRoom(chatId, {
          type: MessageType.CartUpdated,
          payload: {
            action: 'add',
            item: {
              type: cartArgs.type,
              name: cartArgs.name,
              price: cartArgs.price,
              quantity: cartArgs.quantity || 1,
              metadata: cartArgs.metadata
            }
          },
          timestamp: Date.now(),
          message_id: `cart_add_${Date.now()}`
        });
        
        return {
          success: true,
          message: `Added ${cartArgs.name} to cart`,
          item: {
            name: cartArgs.name,
            price: cartArgs.price,
            quantity: cartArgs.quantity || 1
          }
        };
      }

      case AvailableFunction.ProcessPayment: {
        const paymentArgs = functionCall.args as {
          cartItems: Array<{
            id: string;
            name: string;
            price: number;
            quantity: number;
          }>;
        };
        
        // Send CartData message with checkout action
        wsServer.broadcastToRoom(chatId, {
          type: MessageType.CartData,
          payload: {
            action: 'checkout',
            cartItems: paymentArgs.cartItems,
            message: 'Proceeding to checkout'
          },
          timestamp: Date.now(),
          message_id: `checkout_${Date.now()}`
        });
        
        const totalAmount = paymentArgs.cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        return {
          success: true,
          message: 'Payment processing initiated',
          totalAmount,
          itemCount: paymentArgs.cartItems.length
        };
      }

      default:
        return {
          error: true,
          function: functionCall.name,
          message: `Unknown function: ${functionCall.name}`,
          details: 'This function is not available in the system.'
        };
    }
  }

  private sendFunctionCallMessage(
    chatId: string,
    functionCall: FunctionCallResponse,
    wsServer: WebSocketServer
  ): void {
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.FunctionCall,
      payload: {
        ...functionCall,
        role: 'function'
      },
      timestamp: Date.now(),
      message_id: `msg_${Date.now()}`
    });
  }

  private sendFunctionCallStartMessage(
    chatId: string,
    functionName: string,
    wsServer: WebSocketServer
  ): void {
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.FunctionCallStart,
      payload: {
        name: functionName
      },
      timestamp: Date.now(),
      message_id: `msg_${Date.now()}`
    });
  }

  private sendFunctionCallEndMessage(
    chatId: string,
    functionName: string,
    wsServer: WebSocketServer
  ): void {
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.FunctionCallEnd,
      payload: {
        name: functionName
      },
      timestamp: Date.now(),
      message_id: `msg_${Date.now()}`
    });
  }

  private sendFunctionResultMessage(
    chatId: string,
    functionName: string,
    result: unknown,
    wsServer: WebSocketServer
  ): void {
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.FunctionResult,
      payload: {
        name: functionName,
        result,
        role: 'function'
      },
      timestamp: Date.now(),
      message_id: `msg_${Date.now()}`
    });
  }

  private sendErrorMessage(chatId: string, error: string, wsServer: WebSocketServer): void {
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.Error,
      payload: { error },
      timestamp: Date.now(),
      message_id: `msg_${Date.now()}`
    });
  }

  private async streamTextResponse(
    chatId: string,
    text: string,
    wsServer: WebSocketServer
  ): Promise<void> {
    // For now, send the full text as streaming isn't implemented in Gemini API yet
    // In the future, this can be enhanced with actual streaming
    const words = text.split(' ');
    const chunkSize = 5; // Stream 5 words at a time

    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
      
      wsServer.broadcastToRoom(chatId, {
        type: MessageType.TextStream,
        payload: {
          text: chunk,
          isComplete: i + chunkSize >= words.length
        },
        timestamp: Date.now(),
        message_id: `stream_${Date.now()}`
      });

      // Small delay between chunks for streaming effect
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Send stream end notification
    wsServer.broadcastToRoom(chatId, {
      type: MessageType.TextStreamEnd,
      payload: { text },
      timestamp: Date.now(),
      message_id: `stream_end_${Date.now()}`
    });
  }
}


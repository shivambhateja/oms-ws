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

  private readonly SYSTEM_PROMPT = `You are an intelligent AI assistant with access to tools, user documents, and conversation history.

## CRITICAL: Document Context Handling
When document context is provided below (marked with "📄 RELEVANT DOCUMENT CONTEXT" or similar headers), you MUST:
- **ALWAYS use the document context to answer questions** - it contains the actual content the user is asking about
- **NEVER say you need the document** - you already have it in the context below
- **Reference specific details** from the document context (numbers, names, sections, data points)
- **Assume the user has already shared the document** when they say "this doc", "the document", "the file", etc.
- Be confident and direct in your answers based on the provided context

When the user asks to "summarize this doc", "analyze this file", "what's in the document", etc., you should:
1. Look for the document context section below (it will be clearly marked)
2. Use that context to provide a comprehensive answer
3. DO NOT ask for the document again - you already have it

---

## Available Tools
You have access to these tools for specific tasks:

**Publisher & Shopping Tools:**
- browsePublishers: Search publishers for backlinking opportunities
- viewCart: View the current shopping cart contents
- addToCart: Add a publisher or product to the shopping cart
- processPayment: Process payment for cart items

**When to Use Tools:**
- Use browsePublishers ONLY when user explicitly asks to find/search/browse publishers
- Use cart tools ONLY when user explicitly wants to view/add items to cart or checkout
- DO NOT use tools for document-related questions (summarize, analyze, explain documents)
- DO NOT use tools for general conversation or questions about provided documents

---

## Cart and Checkout Flow
1. After browsePublishers is called, proactively suggest adding publishers to cart
2. When user mentions specific publishers or says "add these" or "add to cart", use addToCart for each selected publisher
3. After items are added to cart, ALWAYS call viewCart to show the user their current cart
4. When showing the cart, ask: "Would you like to edit anything in your cart, or are you ready to proceed to checkout?"
5. If user says they're done or ready to checkout, call processPayment with the current cart items
6. If user wants to edit the cart, wait for their changes and then show cart again

---

## Response Style
- **Be conversational and helpful**
- **Be confident** - when you have document context or user information, use it directly without hesitation
- **Use markdown for beautiful formatting:**
  * Use **bold** for important terms and numbers
  * Use bullet points with • or - for lists
  * Use emojis strategically (✅ ❌ 🎯 📊 💰 🔍 etc.)
  * Use line breaks for better readability
  * Use > blockquotes for important notes or tips
- **Never mention technical details** like "vector search", "API calls", "embeddings", "filters", etc.
- **Focus on what the user gets**, not how you do it

---

## Decision Logic
1. **Is there document context below?** → Use it to answer document questions directly
2. **Is this a simple greeting or question?** → Respond directly without tools
3. **Is the user asking about publishers/shopping?** → Use appropriate tools
4. **Is this about user preferences/history?** → Use the USER PERSONAL INFORMATION section if provided

Remember: You are helpful, intelligent, and confident. When you have the information (in document context or user history), use it directly!`;
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
      console.log(`[DocRAG] DEBUG: selectedDocuments parameter:`, {
        exists: selectedDocuments !== undefined,
        isArray: Array.isArray(selectedDocuments),
        length: selectedDocuments?.length,
        value: selectedDocuments,
        chatId
      });

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
      
      // Get userId early for document retrieval
      const userId = (wsServer as any).getUserIdForChat?.(chatId) as string | undefined;

      // Store document context separately (like mosaic-next does)
      let documentContext = '';

      // ===== DOCUMENT RETRIEVAL - Handle FIRST and independently =====
      // This ensures documents are retrieved even if conversation RAG fails or is disabled
      console.log(`[DocRAG] DEBUG: Checking conditions for document retrieval:`, {
        hasSelectedDocuments: !!(selectedDocuments && selectedDocuments.length > 0),
        selectedDocumentsLength: selectedDocuments?.length || 0,
        hasUserId: !!userId,
        userId: userId,
        hasEmbedder: !!this.embedder,
        hasPinecone: !!this.pinecone,
        hasUserMessageContent: !!userMessage?.content,
        userMessageContent: userMessage?.content?.substring(0, 50) || 'N/A'
      });
      
      if (selectedDocuments && selectedDocuments.length > 0 && userId && this.embedder && this.pinecone && userMessage?.content) {
        console.log(`[DocRAG] 🚀 Starting document retrieval for ${selectedDocuments.length} selected documents`);
        console.log(`[DocRAG] Selected document IDs:`, selectedDocuments);
        console.log(`[DocRAG] User ID: ${userId}, Namespace: user_${userId}_docs`);
        
        try {
          // Generate embedding for document query
          const { embedding: docEmbedding } = await this.embedder.embed(userMessage.content);
          
          if (docEmbedding && docEmbedding.length > 0) {
            const { DocumentRetrievalService } = await import('../services/document-retrieval.js');
            const docRetriever = new DocumentRetrievalService(this.pinecone!);
            
            console.log(`[DocRAG] Calling querySelectedDocuments with embedding length=${docEmbedding.length}`);
            
            const docMatches = await docRetriever.querySelectedDocuments({
              userId,
              queryEmbedding: docEmbedding,
              selectedDocuments,
              topKPerDoc: 10,
              minScore: 0.15,
            });
            
            console.log(`[DocRAG] Retrieved ${docMatches.length} document chunks from Pinecone`);

            if (docMatches.length > 0) {
              // Format document context similar to mosaic-next approach
              documentContext = this.formatDocumentContextForAllTypes(docMatches, userMessage.content || '');
              
              console.log(`[DocRAG] ✅ SUCCESS: Prepared ${docMatches.length} chunks from ${selectedDocuments.length} selected documents`);
              console.log('[DocRAG] Document context length:', documentContext.length, 'characters');
              console.log('[DocRAG] Document context preview (first 1000 chars):\n', documentContext.slice(0, 1000));
            } else {
              console.log('[DocRAG] ⚠️ WARNING: No document chunks retrieved for selected documents');
              console.log('[DocRAG] This could mean:');
              console.log('[DocRAG]   1. Documents are not yet processed/embedded');
              console.log('[DocRAG]   2. Document IDs do not match what is stored in Pinecone');
              console.log('[DocRAG]   3. Query embedding does not match document embeddings');
            }
          } else {
            console.log('[DocRAG] ⚠️ Failed to generate embedding for document query');
          }
        } catch (err) {
          console.error('[DocRAG] ❌ ERROR: Document retrieval failed:', err);
          console.error('[DocRAG] Error details:', err instanceof Error ? err.message : String(err));
          console.error('[DocRAG] Stack:', err instanceof Error ? err.stack : 'N/A');
        }
      } else {
        console.log('[DocRAG] ⚠️ Document retrieval SKIPPED - Conditions not met:');
        if (!selectedDocuments || selectedDocuments.length === 0) {
          console.log('[DocRAG]   ❌ No selected documents provided (selectedDocuments:', selectedDocuments, ')');
        }
        if (!userId) {
          console.log('[DocRAG]   ❌ No userId available for document retrieval');
        }
        if (!this.embedder) {
          console.log('[DocRAG]   ❌ Embedder not available for document retrieval');
        }
        if (!this.pinecone) {
          console.log('[DocRAG]   ❌ Pinecone not available for document retrieval');
        }
        if (!userMessage?.content) {
          console.log('[DocRAG]   ❌ No user message content for document retrieval');
        }
      }
      
      // Always log document context status
      console.log(`[DocRAG] Document context status: ${documentContext ? `PREPARED (${documentContext.length} chars)` : 'NOT PREPARED'}`);
      
      // Insert document context into system prompt (like mosaic-next line 176)
      // Insert it naturally - the AI will understand how to use it
      if (documentContext) {
        systemPrompt = systemPrompt + '\n\n' + documentContext;
        console.log('[DocRAG] ✅ Document context inserted into system prompt');
      }

      // Inject Personalization Context via RAG (non-blocking if services missing)
      try {
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
        const hasDocContext = systemPrompt.includes('RELEVANT DOCUMENT CONTEXT') || 
                              systemPrompt.includes('REFERENCED DOCUMENTS') || 
                              systemPrompt.includes('📄 RELEVANT DOCUMENT CONTEXT') ||
                              systemPrompt.includes('📊 CSV Data Analysis') ||
                              systemPrompt.includes('📄 Word Document Analysis') ||
                              systemPrompt.includes('📊 Excel Workbook Analysis') ||
                              systemPrompt.includes('📄 PDF Document Analysis');
        const preview = systemPrompt.length > 3000 ? `${systemPrompt.slice(0, 3000)}…` : systemPrompt;
        console.log('[AI] Final system prompt length=', systemPrompt.length, 'hasDocContext=', hasDocContext);
        
        // Find document context section in prompt for better debugging
        const docContextIndex = systemPrompt.indexOf('RELEVANT DOCUMENT CONTEXT');
        if (docContextIndex !== -1) {
          const docContextSection = systemPrompt.slice(docContextIndex, Math.min(docContextIndex + 1000, systemPrompt.length));
          console.log('[AI] Document context found in prompt at index', docContextIndex);
          console.log('[AI] Document context preview:\n', docContextSection.slice(0, 500));
        } else {
          console.log('[AI] WARNING: Document context NOT found in final system prompt!');
        }
        
        console.log('[AI] Final system prompt preview (first 2000 chars):\n', preview);
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

  /**
   * Format document context for all document types (CSV, XLSX, DOCX, PDF, etc.)
   * Similar to mosaic-next formatDocumentContextForAllTypes function
   */
  private formatDocumentContextForAllTypes(
    chunks: Array<{
      documentId: string;
      documentName?: string;
      content: string;
      score: number;
      chunkIndex?: number;
      metadata?: any;
    }>,
    userMessage: string
  ): string {
    // Separate chunks by type
    const csvChunks = chunks.filter(chunk => 
      chunk.metadata?.chunkType?.startsWith('csv_') || 
      chunk.metadata?.isCSV
    );
    const xlsxChunks = chunks.filter(chunk => 
      chunk.metadata?.chunkType?.startsWith('xlsx_') || 
      chunk.metadata?.isXLSX
    );
    const docxChunks = chunks.filter(chunk => 
      chunk.metadata?.chunkType?.startsWith('docx_') || 
      chunk.metadata?.isDOCX
    );
    const pdfChunks = chunks.filter(chunk => 
      chunk.metadata?.chunkType?.startsWith('pdf_') || 
      chunk.metadata?.isPDF
    );
    const otherChunks = chunks.filter(chunk => 
      !chunk.metadata?.chunkType?.startsWith('csv_') && 
      !chunk.metadata?.chunkType?.startsWith('xlsx_') &&
      !chunk.metadata?.chunkType?.startsWith('docx_') &&
      !chunk.metadata?.chunkType?.startsWith('pdf_') &&
      !chunk.metadata?.isCSV &&
      !chunk.metadata?.isXLSX &&
      !chunk.metadata?.isDOCX &&
      !chunk.metadata?.isPDF
    );

    let context = '**📄 RELEVANT DOCUMENT CONTEXT:**\n\n';

    // DOCX-specific context with priority ordering
    if (docxChunks.length > 0) {
      context += '**📄 Word Document Analysis:**\n';
      const priorityOrder: Record<string, number> = { 'high': 0, 'medium': 1, 'low': 2 };
      docxChunks.sort((a, b) => {
        const aPriority = priorityOrder[a.metadata?.priority] ?? 2;
        const bPriority = priorityOrder[b.metadata?.priority] ?? 2;
        return aPriority - bPriority;
      });

      docxChunks.forEach((chunk) => {
        const chunkType = chunk.metadata?.chunkType;
        const relevance = (chunk.score * 100).toFixed(0);
        const docName = chunk.documentName || 'Unknown Document';

        if (chunkType === 'docx_summary') {
          context += `[Document Summary - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'docx_outline') {
          context += `[Document Outline - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'docx_paragraph') {
          const range = chunk.metadata?.paragraphRange ? ` ${chunk.metadata.paragraphRange}` : '';
          context += `[Paragraphs${range} - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else {
          context += `[${docName} - Section ${(chunk.chunkIndex || 0) + 1}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        }
      });
    }

    // XLSX-specific context with priority ordering
    if (xlsxChunks.length > 0) {
      context += '**📊 Excel Workbook Analysis:**\n';
      const priorityOrder: Record<string, number> = { 'high': 0, 'medium': 1, 'low': 2 };
      xlsxChunks.sort((a, b) => {
        const aPriority = priorityOrder[a.metadata?.priority] ?? 2;
        const bPriority = priorityOrder[b.metadata?.priority] ?? 2;
        return aPriority - bPriority;
      });

      xlsxChunks.forEach((chunk) => {
        const chunkType = chunk.metadata?.chunkType;
        const relevance = (chunk.score * 100).toFixed(0);
        const docName = chunk.documentName || 'Unknown Document';

        if (chunkType === 'xlsx_summary') {
          context += `[Workbook Summary - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'xlsx_sheet_overview') {
          const sheetName = chunk.metadata?.sheetName ? `Sheet: ${chunk.metadata.sheetName} - ` : '';
          context += `[${sheetName}${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'xlsx_column') {
          const columnName = chunk.metadata?.columnName || 'Unknown Column';
          const sheetName = chunk.metadata?.sheetName ? ` - Sheet: ${chunk.metadata.sheetName}` : '';
          context += `[Column: ${columnName}${sheetName} - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else {
          context += `[${docName} - Section ${(chunk.chunkIndex || 0) + 1}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        }
      });
    }

    // CSV-specific context with priority ordering
    if (csvChunks.length > 0) {
      context += '**📊 CSV Data Analysis:**\n';
      const priorityOrder: Record<string, number> = { 'high': 0, 'medium': 1, 'low': 2 };
      csvChunks.sort((a, b) => {
        const aPriority = priorityOrder[a.metadata?.priority] ?? 2;
        const bPriority = priorityOrder[b.metadata?.priority] ?? 2;
        return aPriority - bPriority;
      });

      csvChunks.forEach((chunk) => {
        const chunkType = chunk.metadata?.chunkType;
        const relevance = (chunk.score * 100).toFixed(0);
        const docName = chunk.documentName || 'Unknown Document';

        if (chunkType === 'csv_summary') {
          context += `[Summary - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'csv_statistics') {
          context += `[Statistical Analysis - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'csv_column') {
          const columnName = chunk.metadata?.columnName || 'Unknown Column';
          const columnType = chunk.metadata?.columnType ? ` (${chunk.metadata.columnType})` : '';
          context += `[Column: ${columnName}${columnType} - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'csv_rows') {
          const rowRange = chunk.metadata?.rowRange ? ` ${chunk.metadata.rowRange}` : '';
          context += `[Rows${rowRange} - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else {
          context += `[${docName} - Section ${(chunk.chunkIndex || 0) + 1}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        }
      });
    }

    // PDF-specific context with priority ordering
    if (pdfChunks.length > 0) {
      context += '**📄 PDF Document Analysis:**\n';
      const priorityOrder: Record<string, number> = { 'high': 0, 'medium': 1, 'low': 2 };
      pdfChunks.sort((a, b) => {
        const aPriority = priorityOrder[a.metadata?.priority] ?? 2;
        const bPriority = priorityOrder[b.metadata?.priority] ?? 2;
        return aPriority - bPriority;
      });

      pdfChunks.forEach((chunk) => {
        const chunkType = chunk.metadata?.chunkType;
        const relevance = (chunk.score * 100).toFixed(0);
        const docName = chunk.documentName || 'Unknown Document';

        if (chunkType === 'pdf_summary') {
          context += `[Document Summary - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'pdf_outline') {
          context += `[Document Outline - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else if (chunkType === 'pdf_page') {
          const pageNumber = chunk.metadata?.pageNumber || 'Unknown';
          context += `[Page ${pageNumber} - ${docName}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        } else {
          context += `[${docName} - Section ${(chunk.chunkIndex || 0) + 1}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
        }
      });
    }

    // Other document context
    if (otherChunks.length > 0) {
      context += '**📄 Other Document Content:**\n';
      otherChunks.forEach((chunk) => {
        const relevance = (chunk.score * 100).toFixed(0);
        const docName = chunk.documentName || 'Unknown Document';
        context += `[${docName} - Section ${(chunk.chunkIndex || 0) + 1}] (Relevance: ${relevance}%)\n${chunk.content}\n\n`;
      });
    }

    context += '\n\n**Instructions:** Use this document context to provide accurate, data-driven responses. Reference specific values, columns, rows, sheets, sections, tables, lists, and pages when relevant. For Excel workbooks, prioritize workbook summaries and sheet overviews for general questions, and specific columns/statistics for detailed analysis. For Word documents, prioritize document summaries and outlines for general questions, and specific sections/tables for detailed analysis. For PDF documents, prioritize document summaries and outlines for general questions, and specific sections/tables/pages for detailed analysis. For CSV files, prioritize summaries and statistics for general questions, and specific columns/rows for detailed analysis.';

    return context;
  }
}


import { EmbeddingService, chunkText, sha1 } from '../services/embeddings.js';
import { PineconeService } from '../services/pinecone.js';

export interface EmbedJob {
  userId: string;
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'function';
  content: string;
  createdAt?: string;
}

export class EmbeddingQueue {
  private queue: EmbedJob[] = [];
  private running = false;
  private embedder: EmbeddingService;
  private pinecone: PineconeService;

  constructor(embedder: EmbeddingService, pinecone: PineconeService) {
    this.embedder = embedder;
    this.pinecone = pinecone;
  }

  enqueue(job: EmbedJob): void {
    this.queue.push(job);
    console.log(`[EmbedQueue] Enqueued messageId=${job.messageId} userId=${job.userId} role=${job.role} size=${job.content.length}`);
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const start = Date.now();
        try {
          await this.process(job);
          console.log(`[EmbedQueue] Processed messageId=${job.messageId} ms=${Date.now() - start}`);
        } catch (err) {
          console.error(`[EmbedQueue] Failed messageId=${job.messageId} error=${(err as Error).message}`);
        }
      }
    } catch {
      // Swallow to avoid halting the loop; individual failures are acceptable
    } finally {
      this.running = false;
    }
  }

  private async process(job: EmbedJob): Promise<void> {
    if (!job.content?.trim()) return;
    const chunks = chunkText(job.content);
    console.log(`[EmbedQueue] Chunked messageId=${job.messageId} chunks=${chunks.length}`);
    const vectors: { id: string; values: number[]; metadata: any }[] = [];
    let index = 0;
    for (const chunk of chunks) {
      const hash = sha1(chunk);
      const id = `${job.messageId}_${index}_${hash}`;
      const { embedding } = await this.embedder.embed(chunk);
      if (!embedding || embedding.length === 0) continue;
      // Detect personal facts/preferences
      const lowered = chunk.toLowerCase();
      const isProfile = /\b(i am|i'm|i work at|i own|my company|founder|ceo|cto|owner|co-founder)\b/.test(lowered);
      const isPreference = /\b(i prefer|my favorite|i like|i love|i hate|please use|tone|style)\b/.test(lowered);
      const truncated = chunk.length > 600 ? `${chunk.slice(0, 600)}…` : chunk;
      vectors.push({
        id,
        values: embedding,
        metadata: {
          userId: job.userId,
          chatId: job.chatId,
          messageId: job.messageId,
          role: job.role,
          createdAt: job.createdAt || new Date().toISOString(),
          tags: ['chat'],
          isProfile,
          isPreference,
          hash,
          text: truncated,
        },
      });
      index++;
    }

    if (vectors.length > 0) {
      await this.pinecone.upsert({ namespace: job.userId, vectors });
    }
  }
}



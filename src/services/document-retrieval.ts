import { PineconeService } from './pinecone.js';

export interface RetrievedDocChunk {
  id: string;
  content: string;
  score: number;
  documentId: string;
  documentName?: string;
  chunkIndex?: number;
  metadata?: Record<string, unknown>;
}

function getDocumentsNamespace(userId: string): string {
  return `user_${userId}_docs`;
}

export class DocumentRetrievalService {
  private pinecone: PineconeService;

  constructor(pinecone: PineconeService) {
    this.pinecone = pinecone;
  }

  async querySelectedDocuments(params: {
    userId: string;
    queryEmbedding: number[];
    selectedDocuments: string[];
    topKPerDoc?: number;
    minScore?: number;
  }): Promise<RetrievedDocChunk[]> {
    const { userId, queryEmbedding, selectedDocuments, topKPerDoc = 5, minScore = 0.15 } = params;
    if (!selectedDocuments || selectedDocuments.length === 0) return [];

    const namespace = getDocumentsNamespace(userId);
    const filter = { documentId: { $in: selectedDocuments } } as Record<string, unknown>;

    console.log(`[DocRAG] Querying Pinecone namespace=${namespace} docIds=${selectedDocuments.join(',')} topK=${topKPerDoc}`);
    const matches = await this.pinecone.query({
      namespace,
      vector: queryEmbedding,
      topK: Math.max(10, topKPerDoc * selectedDocuments.length),
      filter,
    });
    // Log returned scores for diagnostics
    try {
      console.log('[DocRAG] Raw matches (id:score:docId):', matches.map(m => `${m.id}:${(m.score ?? 0).toFixed(3)}:${(m.metadata as any)?.documentId || ''}`).join(', '));
    } catch {}

    let filtered = matches.filter(m => (m.score ?? 0) >= minScore);

    // Fallback: if nothing passes threshold, keep top few anyway
    if (filtered.length === 0 && matches.length > 0) {
      filtered = matches
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.min(3, matches.length));
      console.log(`[DocRAG] Threshold fallback engaged. Using top ${filtered.length} matches below minScore=${minScore}`);
    }

    const limited = filtered.slice(0, topKPerDoc * selectedDocuments.length).map(m => ({
      id: m.id,
      content: (m.metadata as any)?.text || '',
      score: m.score ?? 0,
      documentId: (m.metadata as any)?.documentId || '',
      documentName: (m.metadata as any)?.documentName,
      chunkIndex: (m.metadata as any)?.chunkIndex,
      metadata: m.metadata as any,
    }));

    console.log(`[DocRAG] Retrieved ${limited.length} chunks for selected documents`);
    return limited;
  }
}



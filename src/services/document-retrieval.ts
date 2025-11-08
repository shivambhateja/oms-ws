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
    if (!selectedDocuments || selectedDocuments.length === 0) {
      console.log(`[DocRAG] No selected documents provided`);
      return [];
    }

    const namespace = getDocumentsNamespace(userId);
    console.log(`[DocRAG] Querying Pinecone namespace=${namespace} selectedDocuments=[${selectedDocuments.join(', ')}] topKPerDoc=${topKPerDoc} minScore=${minScore}`);
    
    // Calculate total topK needed
    const totalTopK = Math.max(20, topKPerDoc * selectedDocuments.length * 2); // Get more results to filter

    let matches: Array<{ id: string; score: number; metadata?: any }> = [];
    
    try {
      // Try querying with filter first
      const filter = { documentId: { $in: selectedDocuments } };
      console.log(`[DocRAG] Attempting query with filter:`, JSON.stringify(filter));
      
      matches = await this.pinecone.query({
        namespace,
        vector: queryEmbedding,
        topK: totalTopK,
        filter,
      });
      
      console.log(`[DocRAG] Query with filter returned ${matches.length} matches`);
      
      // Log metadata for debugging
      if (matches.length > 0) {
        console.log(`[DocRAG] Sample match metadata:`, JSON.stringify(matches[0].metadata || {}, null, 2));
        console.log(`[DocRAG] Match documentIds:`, matches.map(m => (m.metadata as any)?.documentId || 'missing').slice(0, 5));
      }
    } catch (filterError: any) {
      console.error(`[DocRAG] Filter query failed:`, filterError?.message || filterError);
      console.log(`[DocRAG] Falling back to query without filter, will filter in-memory`);
      
      try {
        // Fallback: Query without filter and filter in-memory
        const allMatches = await this.pinecone.query({
          namespace,
          vector: queryEmbedding,
          topK: totalTopK * 2, // Get more results since we'll filter
        });
        
        console.log(`[DocRAG] Query without filter returned ${allMatches.length} total matches`);
        
        // Filter in-memory by documentId
        matches = allMatches.filter(m => {
          const docId = (m.metadata as any)?.documentId;
          const isSelected = docId && selectedDocuments.includes(docId);
          if (!isSelected && docId) {
            console.log(`[DocRAG] Filtered out document ${docId} (not in selectedDocuments)`);
          }
          return isSelected;
        });
        
        console.log(`[DocRAG] After in-memory filtering: ${matches.length} matches from selected documents`);
      } catch (queryError: any) {
        console.error(`[DocRAG] Query failed completely:`, queryError?.message || queryError);
        return [];
      }
    }

    // Extract and validate document chunks
    const chunks: RetrievedDocChunk[] = matches.map(m => {
      const metadata = m.metadata as any || {};
      const docId = metadata.documentId || '';
      const docName = metadata.documentName || '';
      const content = metadata.text || '';
      
      if (!docId) {
        console.warn(`[DocRAG] Match ${m.id} has no documentId in metadata`);
      }
      
      return {
        id: m.id,
        content: content,
        score: m.score ?? 0,
        documentId: docId,
        documentName: docName,
        chunkIndex: metadata.chunkIndex,
        metadata: metadata,
      };
    });

    // Filter by score threshold
    let filtered = chunks.filter(c => c.score >= minScore && c.documentId && selectedDocuments.includes(c.documentId));

    console.log(`[DocRAG] After score filtering (minScore=${minScore}): ${filtered.length} chunks`);

    // Group by document and limit per document
    const grouped: Record<string, RetrievedDocChunk[]> = {};
    for (const chunk of filtered) {
      if (!grouped[chunk.documentId]) {
        grouped[chunk.documentId] = [];
      }
      grouped[chunk.documentId].push(chunk);
    }

    // Take topKPerDoc chunks per document
    const limited: RetrievedDocChunk[] = [];
    for (const docId of selectedDocuments) {
      const docChunks = grouped[docId] || [];
      const sorted = docChunks.sort((a, b) => b.score - a.score);
      const topChunks = sorted.slice(0, topKPerDoc);
      limited.push(...topChunks);
      console.log(`[DocRAG] Document ${docId}: ${topChunks.length} chunks (from ${docChunks.length} total)`);
    }

    // Fallback: if we still have no results, try without score threshold
    if (limited.length === 0 && chunks.length > 0) {
      console.log(`[DocRAG] No chunks passed score threshold, using top chunks without threshold`);
      const allFiltered = chunks
        .filter(c => c.documentId && selectedDocuments.includes(c.documentId))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(10, chunks.length));
      limited.push(...allFiltered);
    }

    console.log(`[DocRAG] Final result: ${limited.length} chunks from ${selectedDocuments.length} selected documents`);
    if (limited.length > 0) {
      console.log(`[DocRAG] Sample chunk: docId=${limited[0].documentId} score=${limited[0].score.toFixed(3)} content=${limited[0].content.slice(0, 100)}...`);
    }

    return limited;
  }
}



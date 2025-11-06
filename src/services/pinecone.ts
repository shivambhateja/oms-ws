import axios, { AxiosInstance } from 'axios';

export interface PineconeMetadata {
  userId: string;
  chatId: string;
  messageId?: string;
  role?: string;
  createdAt?: string;
  tags?: string[];
  hash?: string;
}

export interface PineconeVectorUpsert {
  id: string;
  values: number[];
  metadata?: PineconeMetadata;
}

export interface PineconeQueryResult {
  id: string;
  score: number;
  metadata?: PineconeMetadata;
}

export class PineconeService {
  private apiKey: string;
  private indexHost?: string;
  private indexName?: string;
  private projectId?: string;
  private environment?: string;
  private http: AxiosInstance;

  constructor(params: {
    apiKey: string;
    indexHost?: string; // Prefer explicit host if provided
    indexName?: string;
    projectId?: string;
    environment?: string;
  }) {
    this.apiKey = params.apiKey;
    this.indexHost = params.indexHost;
    this.indexName = params.indexName;
    this.projectId = params.projectId;
    this.environment = params.environment;
    this.http = axios.create({
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      // baseURL is set dynamically per-request because host may differ
      timeout: 15000,
    });
  }

  private getIndexHost(): string {
    if (this.indexHost) return this.indexHost;
    if (this.indexName && this.projectId && this.environment) {
      // Pinecone serverless host format
      return `https://${this.indexName}-${this.projectId}.svc.${this.environment}.pinecone.io`;
    }
    throw new Error('Pinecone index host is not configured');
  }

  async upsert(params: {
    namespace: string;
    vectors: PineconeVectorUpsert[];
  }): Promise<void> {
    const host = this.getIndexHost();
    const url = `${host}/vectors/upsert`;
    const count = params.vectors.length;
    const start = Date.now();
    console.log(`[Pinecone] Upsert start namespace=${params.namespace} count=${count}`);
    try {
      await this.http.post(url, {
        vectors: params.vectors,
        namespace: params.namespace,
      });
      console.log(`[Pinecone] Upsert success namespace=${params.namespace} count=${count} ms=${Date.now() - start}`);
    } catch (err) {
      const anyErr = err as any;
      const status = anyErr?.response?.status;
      const data = anyErr?.response?.data;
      console.error(`[Pinecone] Upsert failed namespace=${params.namespace} count=${count} status=${status} error=${(err as Error).message} body=${JSON.stringify(data)}`);
      throw err;
    }
  }

  async query(params: {
    namespace: string;
    vector: number[];
    topK: number;
    filter?: Record<string, unknown>;
  }): Promise<PineconeQueryResult[]> {
    const host = this.getIndexHost();
    const url = `${host}/query`;
    const start = Date.now();
    console.log(`[Pinecone] Query start namespace=${params.namespace} topK=${params.topK}`);
    try {
      const { data } = await this.http.post(url, {
        vector: params.vector,
        topK: params.topK,
        namespace: params.namespace,
        filter: params.filter,
        includeMetadata: true,
      });
      const matches = (data?.matches || []) as Array<{
        id: string;
        score: number;
        metadata?: PineconeMetadata;
      }>;
      console.log(`[Pinecone] Query success namespace=${params.namespace} returned=${matches.length} ms=${Date.now() - start}`);
      return matches.map(m => ({ id: m.id, score: m.score, metadata: m.metadata }));
    } catch (err) {
      const anyErr = err as any;
      const status = anyErr?.response?.status;
      const data = anyErr?.response?.data;
      console.error(`[Pinecone] Query failed namespace=${params.namespace} status=${status} error=${(err as Error).message} body=${JSON.stringify(data)}`);
      throw err;
    }
  }

  async deleteByIds(params: { namespace: string; ids: string[] }): Promise<void> {
    const host = this.getIndexHost();
    const url = `${host}/vectors/delete`;
    console.log(`[Pinecone] Delete start namespace=${params.namespace} ids=${params.ids.length}`);
    try {
      await this.http.post(url, {
        ids: params.ids,
        namespace: params.namespace,
      });
      console.log(`[Pinecone] Delete success namespace=${params.namespace}`);
    } catch (err) {
      const anyErr = err as any;
      const status = anyErr?.response?.status;
      const data = anyErr?.response?.data;
      console.error(`[Pinecone] Delete failed namespace=${params.namespace} status=${status} error=${(err as Error).message} body=${JSON.stringify(data)}`);
      throw err;
    }
  }
}



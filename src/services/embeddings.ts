import axios from 'axios';

export interface EmbedResult {
  embedding: number[];
}

export class EmbeddingService {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<EmbedResult> {
    const input = text.trim();
    if (!input) return { embedding: [] };
    const start = Date.now();
    console.log(`[Embed] Request start model=${this.model} chars=${input.length}`);
    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: this.model, input },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const vector = (data?.data?.[0]?.embedding || []) as number[];
      console.log(`[Embed] Success dims=${vector.length} ms=${Date.now() - start}`);
      return { embedding: vector };
    } catch (err) {
      console.error(`[Embed] Failed error=${(err as Error).message}`);
      throw err;
    }
  }
}

export function chunkText(text: string, opts?: { chunkSize?: number; overlap?: number }): string[] {
  const chunkSize = Math.max(200, Math.min(opts?.chunkSize || 800, 1200));
  const overlap = Math.max(0, Math.min(opts?.overlap || 100, Math.floor(chunkSize / 2)));

  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const chunkWords = words.slice(i, i + chunkSize);
    if (chunkWords.length === 0) break;
    chunks.push(chunkWords.join(' '));
    if (overlap > 0) {
      i += chunkSize - overlap;
    } else {
      i += chunkSize;
    }
  }
  return chunks;
}

export function sha1(input: string): string {
  // Lightweight hash for de-duplication; crypto.subtle not available in Node versions uniformly
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return `sha1_${(hash >>> 0).toString(16)}`;
}



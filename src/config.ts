import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  openAiApiKey: string;
  wsPort: number;
  outreachApiUrl?: string;
  pinecone: {
    apiKey: string;
    indexHost?: string;
    indexName?: string;
    projectId?: string;
    environment?: string;
  } | null;
}

export function loadConfig(): Config {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  // Support PORT (for Render/deployment) or WS_PORT, default 8080 to match frontend
  const wsPort = parseInt(process.env.PORT || process.env.WS_PORT || '8080', 10);
  const outreachApiUrl = process.env.OUTREACH_API_URL;
  const pineconeApiKey = process.env.PINECONE_API_KEY;
  const pineconeIndexHost = process.env.PINECONE_INDEX_HOST; // preferred if provided
  const pineconeIndexName = process.env.PINECONE_INDEX;
  const pineconeProjectId = process.env.PINECONE_PROJECT_ID;
  const pineconeEnv = process.env.PINECONE_ENV;

  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  return {
    openAiApiKey,
    wsPort,
    outreachApiUrl,
    pinecone: pineconeApiKey
      ? {
          apiKey: pineconeApiKey,
          indexHost: pineconeIndexHost,
          indexName: pineconeIndexName,
          projectId: pineconeProjectId,
          environment: pineconeEnv,
        }
      : null,
  };
}


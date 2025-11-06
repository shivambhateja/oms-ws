import { loadConfig } from './config.js';
import { WebSocketServer } from './websocket/server.js';
import { MessageHandler } from './websocket/handler.js';
import { OrchestratorService } from './orchestrator/service.js';
import { NotificationWebSocketServer } from './notifications/server.js';
import { EmbeddingService } from './services/embeddings.js';
import { PineconeService } from './services/pinecone.js';
import { EmbeddingQueue } from './queues/embedding-queue.js';

async function main() {
  try {
    // Load configuration
    const config = loadConfig();
    
    // Initialize services
    const embedder = new EmbeddingService(config.openAiApiKey);
    const pinecone = config.pinecone
      ? new PineconeService({
          apiKey: config.pinecone.apiKey,
          indexHost: config.pinecone.indexHost,
          indexName: config.pinecone.indexName,
          projectId: config.pinecone.projectId,
          environment: config.pinecone.environment,
        })
      : undefined;
    const embeddingQueue = pinecone ? new EmbeddingQueue(embedder, pinecone) : undefined;

    const orchestrator = new OrchestratorService(config.openAiApiKey, {
      embedder,
      pinecone,
      embeddingQueue,
    });
    const messageHandler = new MessageHandler(orchestrator);
    
    // Initialize Chat WebSocket Server (standalone on port)
    const chatServer = new WebSocketServer(config.wsPort, messageHandler);
    chatServer.start();
    
    // Initialize Notification WebSocket Server (standalone on port + 1)
    const notificationPort = config.wsPort + 1;
    const notificationServer = new NotificationWebSocketServer();
    notificationServer.createStandaloneWebSocketServer(notificationPort);

    // Graceful shutdown
    const shutdown = () => {
      if ((chatServer as any).server) {
        (chatServer as any).server.close();
      }
      if (notificationServer.wss) {
        notificationServer.wss.close();
      }
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();


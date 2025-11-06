import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HTTPServer } from 'http';
import { NotificationData, NotificationMessage, ClientConnection } from './types.js';

export class NotificationWebSocketServer {
  public wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private adminClients: Set<string> = new Set();

  public createStandaloneWebSocketServer(port: number) {
    this.wss = new WebSocketServer({ port });
    this.setupConnectionHandlers();
  }

  public createWebSocketServer(server: HTTPServer) {
    // Prevent duplicate server creation
    if (this.wss) {
      return;
    }
    
    this.wss = new WebSocketServer({ 
      server,
      path: '/api/notifications/ws'
    });

    this.setupConnectionHandlers();
  }

  private setupConnectionHandlers() {
    if (!this.wss) {
      throw new Error('WebSocket server not initialized');
    }

    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const clientId = this.generateClientId();
      this.clients.set(clientId, { ws });

      ws.on('message', (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());
          this.handleMessage(clientId, data);
        } catch (error) {
          console.error(`❌ [Notification] Error parsing message:`, error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        // Only log actual errors, not normal closures
        // 1000 = Normal Closure, 1001 = Going Away, 1005 = No Status Received are all normal
        // Everything else should be logged as an error
        const isNormalClosure = code === 1000 || code === 1001 || code === 1005;
        if (!isNormalClosure && code !== 0) {
          console.error(`❌ [Notification] WebSocket closed unexpectedly (code: ${code} - ${this.getCloseCodeMeaning(code)})`);
        }
        this.clients.delete(clientId);
        this.adminClients.delete(clientId);
      });

      ws.on('error', (error) => {
        console.error(`❌ [Notification] WebSocket error:`, error instanceof Error ? error.message : error);
        this.clients.delete(clientId);
        this.adminClients.delete(clientId);
      });

      // Send connection confirmation
      if (!this.sendSafe(ws, {
        type: 'connected',
        clientId
      }, clientId)) {
        console.error(`❌ [Notification] Failed to send connection confirmation`);
      }
    });
  }

  private generateClientId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  private handleMessage(clientId: string, data: any) {
    const client = this.clients.get(clientId);
    if (!client) {
      console.error(`❌ [Notification] Client not found for message handling`);
      return;
    }

    switch (data.type) {
      case 'authenticate':
        this.authenticateClient(clientId, data.userId, data.isAdmin);
        break;
      case 'ping':
        this.sendSafe(client.ws, { type: 'pong' }, clientId);
        break;
      case 'broadcast':
        if (client.isAdmin) {
          if (data.notification) {
            this.broadcastNotification(data.notification);
            setTimeout(() => {
              this.sendSafe(client.ws, {
                type: 'broadcast-complete',
                notificationId: data.notification.id,
                timestamp: new Date().toISOString()
              }, clientId);
            }, 10);
          } else {
            console.error(`❌ [Notification] Broadcast message missing notification data`);
            this.sendSafe(client.ws, {
              type: 'error',
              message: 'Broadcast message missing notification data'
            }, clientId);
          }
        } else {
          console.error(`❌ [Notification] Non-admin client attempted to broadcast`);
          this.sendSafe(client.ws, {
            type: 'error',
            message: 'Only admin clients can broadcast notifications'
          }, clientId);
        }
        break;
      default:
        // Silently ignore unknown message types
        break;
    }
  }

  private authenticateClient(clientId: string, userId: string, isAdmin: boolean) {
    const client = this.clients.get(clientId);
    if (!client) {
      console.error(`❌ [Notification] Client not found for authentication`);
      return;
    }

    client.userId = userId;
    client.isAdmin = isAdmin;

    if (isAdmin) {
      this.adminClients.add(clientId);
    }

    this.sendSafe(client.ws, {
      type: 'authenticated',
      userId,
      isAdmin
    }, clientId);
  }

  public broadcastNotification(notification: NotificationData) {
    const message: NotificationMessage = {
      type: 'notification',
      data: notification
    };

    let sentCount = 0;
    let errorCount = 0;

    // Send to all connected clients
    this.clients.forEach((client, clientId) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        if (this.shouldSendToUser(client, notification)) {
          if (this.sendSafe(client.ws, message, clientId)) {
            sentCount++;
          } else {
            errorCount++;
          }
        }
      } else {
        errorCount++;
      }
    });

    if (errorCount > 0) {
      console.error(`❌ [Notification] Broadcast errors: ${errorCount} failed sends`);
    }
  }

  private shouldSendToUser(client: ClientConnection, notification: NotificationData): boolean {
    // Never send notifications to system broadcast clients (they're only for sending, not receiving)
    if (client.userId === 'system-broadcast-client') {
      return false;
    }

    // If it's a global notification, send to everyone (except broadcast clients)
    if (notification.isGlobal) {
      return true;
    }

    // If user is not authenticated, don't send
    if (!client.userId) {
      return false;
    }

    // If notification is targeted to specific users, check if this user is included
    if (notification.targetUserIds.includes(client.userId)) {
      return true;
    }

    return false;
  }

  public broadcastToAdmins(message: any) {
    this.adminClients.forEach(clientId => {
      const client = this.clients.get(clientId);
      if (client && client.ws.readyState === WebSocket.OPEN) {
        this.sendSafe(client.ws, message, clientId);
      }
    });
  }

  /**
   * Find an admin client connection by userId
   * Returns the clientId if found and connected, null otherwise
   */
  public findAdminConnectionByUserId(userId: string): string | null {
    for (const [clientId, client] of this.clients.entries()) {
      if (
        client.userId === userId &&
        client.isAdmin &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        return clientId;
      }
    }
    return null;
  }

  /**
   * Send a broadcast request to an admin's existing WebSocket connection
   * The admin client will receive this and trigger the broadcast
   */
  public requestBroadcastFromAdmin(adminUserId: string, notification: NotificationData): boolean {
    const adminClientId = this.findAdminConnectionByUserId(adminUserId);
    
    if (!adminClientId) {
      return false;
    }

    const client = this.clients.get(adminClientId);
    if (!client || !client.isAdmin) {
      return false;
    }

    this.broadcastNotification(notification);
    
    this.sendSafe(client.ws, {
      type: 'broadcast-complete',
      notificationId: notification.id,
      timestamp: new Date().toISOString()
    }, adminClientId);

    return true;
  }

  /**
   * Safely send a message to a WebSocket client with error handling
   * @returns true if message was sent successfully, false otherwise
   */
  private sendSafe(ws: WebSocket, message: any, clientId: string): boolean {
    // Type assertion to avoid TypeScript type conflicts between 'ws' and DOM WebSocket
    const wsSocket = ws as any;
    const readyStateText = this.getReadyStateText(wsSocket.readyState);
    
    if (wsSocket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      const messageStr = JSON.stringify(message);
      wsSocket.send(messageStr);
      return true;
    } catch (error) {
      console.error(`❌ [Notification] Failed to send message:`, error instanceof Error ? error.message : error);
      // If send fails, the connection is likely broken, remove the client
      this.clients.delete(clientId);
      this.adminClients.delete(clientId);
      return false;
    }
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public getAdminClientsCount(): number {
    return this.adminClients.size;
  }

  private getCloseCodeMeaning(code: number): string {
    const codes: Record<number, string> = {
      1000: 'Normal Closure',
      1001: 'Going Away',
      1002: 'Protocol Error',
      1003: 'Unsupported Data',
      1004: '(Reserved)',
      1005: 'No Status Received',
      1006: 'Abnormal Closure',
      1007: 'Invalid frame payload data',
      1008: 'Policy Violation',
      1009: 'Message too big',
      1010: 'Mandatory Extension',
      1011: 'Internal Server Error',
      1012: 'Service Restart',
      1013: 'Try Again Later',
      1014: 'Bad Gateway',
      1015: 'TLS Handshake'
    };
    return codes[code] || `Unknown code (${code})`;
  }

  private getReadyStateText(state: number): string {
    const states: Record<number, string> = {
      0: 'CONNECTING',
      1: 'OPEN',
      2: 'CLOSING',
      3: 'CLOSED'
    };
    return states[state] || `Unknown (${state})`;
  }
}



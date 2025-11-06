import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { NotificationWebSocketServer } from '../notifications/server.js';
import { NotificationData } from '../notifications/types.js';

export function setupHttpRoutes(
  server: any,
  notificationServer: NotificationWebSocketServer
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parsedUrl = parse(req.url || '', true);
      const { pathname } = parsedUrl;

      // CRITICAL: Skip WebSocket upgrade requests - let WebSocket servers handle them
      // WebSocket upgrades are handled via the 'upgrade' event, not 'request' event,
      // but we check here as a safety measure in case something goes wrong
      const isWebSocketUpgrade = req.headers.upgrade === 'websocket';
      const isChatWebSocketPath = pathname === '/' && isWebSocketUpgrade;
      const isNotificationWebSocketPath = pathname === '/api/notifications/ws';
      
      // Skip all WebSocket upgrade requests - let WebSocket servers handle them
      // For WebSocket upgrades, Node.js fires the 'upgrade' event which ws library handles
      // We must NOT send any response or process these requests
      if (isWebSocketUpgrade || isNotificationWebSocketPath) {
        // Don't process WebSocket upgrade requests - let WebSocketServer handle via 'upgrade' event
        // IMPORTANT: Do NOT call res.writeHead, res.end, or any response methods
        // Just return and let the upgrade event be handled by WebSocketServer
        return;
      }

      // Health check endpoint (only for non-WebSocket GET requests)
      if (pathname === '/health' || (pathname === '/' && req.method === 'GET' && !isWebSocketUpgrade)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          message: 'WebSocket server is running',
          status: 'healthy',
          timestamp: new Date().toISOString(),
          connectedClients: notificationServer.getConnectedClientsCount(),
          adminClients: notificationServer.getAdminClientsCount()
        }));
        return;
      }

      // Broadcast notification endpoint
      if (pathname === '/api/broadcast' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { notification } = JSON.parse(body);
            
            if (!notification) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Notification data is required' }));
              return;
            }

            notificationServer.broadcastNotification(notification as NotificationData);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              message: 'Notification broadcasted successfully',
              connectedClients: notificationServer.getConnectedClientsCount()
            }));
          } catch (error) {
            console.error('❌ Error processing broadcast request:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      // Broadcast to admins only endpoint
      if (pathname === '/api/broadcast-admin' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { message } = JSON.parse(body);
            
            if (!message) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Message data is required' }));
              return;
            }

            notificationServer.broadcastToAdmins(message);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true,
              message: 'Admin message broadcasted successfully',
              adminClients: notificationServer.getAdminClientsCount()
            }));
          } catch (error) {
            console.error('❌ Error broadcasting admin message:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to broadcast admin message' }));
          }
        });
        return;
      }

      // Get server stats endpoint
      if (pathname === '/api/stats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          connectedClients: notificationServer.getConnectedClientsCount(),
          adminClients: notificationServer.getAdminClientsCount(),
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // For other requests, return a simple response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        message: 'WebSocket server is running',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        connectedClients: notificationServer.getConnectedClientsCount(),
        adminClients: notificationServer.getAdminClientsCount()
      }));
    } catch (err) {
      console.error('❌ Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  };
}



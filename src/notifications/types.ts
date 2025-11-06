import { WebSocket } from 'ws';

export interface NotificationData {
  id: string;
  title: string;
  body: string;
  imageUrl?: string;
  typeId: string;
  isActive: boolean;
  isGlobal: boolean;
  targetUserIds: string[];
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  type: {
    id: string;
    name: string;
    displayName: string;
    icon?: string;
    color?: string;
  };
}

export interface NotificationMessage {
  type: 'notification';
  data: NotificationData;
}

export interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  isAdmin?: boolean;
}



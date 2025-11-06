import { ChatMessage } from '../types/message.js';

export enum MessageType {
  ConnectionEstablished = "connection_established",
  ConnectionError = "connection_error",
  JoinChat = "join_chat",
  LeaveChat = "leave_chat",
  ChatMessage = "chat_message",
  MessageReceived = "message_received",
  MessageError = "message_error",
  TextStream = "text_stream",
  TextStreamEnd = "text_stream_end",
  FunctionCall = "function_call",
  FunctionCallStart = "function_call_start",
  FunctionCallEnd = "function_call_end",
  FunctionResult = "function_result",
  FunctionError = "function_error",
  FunctionExecuteRequest = "function_execute_request",  // Backend → Frontend: Execute this
  FunctionExecuteResponse = "function_execute_response", // Frontend → Backend: Here's the result
  PublishersData = "publishers_data",  // Backend → Frontend: Display publishers in UI
  CartData = "cart_data",  // Backend → Frontend: Display cart in sidebar
  ExecutionPlanData = "execution_plan_data",  // Backend → Frontend: Display execution plan with todos
  PlanCreated = "plan_created",
  PlanUpdated = "plan_updated",
  PlanCompleted = "plan_completed",
  CartUpdated = "cart_updated",
  CartCleared = "cart_cleared",
  SystemMessage = "system_message",
  IterationStart = "iteration_start",
  IterationEnd = "iteration_end",
  Heartbeat = "heartbeat",
  Error = "error",
  StopGeneration = "stop_generation",
}

export interface JoinRoomMessage {
  chat_id: string;
  user_id?: string;
}

export interface RoomMessage {
  room_id: string;
  payload: ChatMessage;
}

export interface SendMessageData {
  chat_id: string;
  user_id?: string;
  message: RoomMessage;
  selectedDocuments?: string[];
  cartData?: {
    items: Array<{
      id: string;
      type: "publisher" | "product";
      name: string;
      price: number;
      quantity: number;
      addedAt?: string;
      metadata?: {
        publisherId?: string;
        website?: string;
        niche?: string[];
        dr?: number;
        da?: number;
      };
    }>;
    totalItems: number;
    totalPrice: number;
  };
}

export interface WebSocketMessage {
  type: MessageType;
  payload: unknown;
  timestamp: number;
  message_id: string;
}

export interface ClientInfo {
  address: string;
  rooms: Set<string>;
}

export interface FunctionExecuteRequest {
  functionName: string;
  args: Record<string, unknown>;
  requestId: string; // Unique ID to match request/response
}

export interface FunctionExecuteResponse {
  requestId: string;
  result?: unknown;
  error?: string;
}


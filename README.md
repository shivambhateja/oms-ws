# TypeScript Backend for AI Orchestrator

This is the TypeScript version of the AI Orchestrator backend, providing a WebSocket server that orchestrates AI tool calls with function calling capabilities.

## Features

- **Unified WebSocket Server**: Single server handling both chat and notifications
- **Chat WebSocket**: Real-time bidirectional communication for AI chat
- **Notification WebSocket**: Real-time push notifications for users and admins
- **AI Orchestration**: Loop-based AI response processing with function calling
- **Function Calling**: Integrates with Gemini API to call tools dynamically
- **HTTP API**: REST endpoints for triggering notification broadcasts
- **Type Safety**: Full TypeScript with strict type checking
- **Modular Architecture**: Clean separation of concerns

## Setup

### 1. Install Dependencies

```bash
cd backend-ts
pnpm install
```

### 2. Configure Environment

Create a `.env` file in the `backend-ts` directory:

```env
GOOGLE_GENERATIVE_AI_API_KEY=your_api_key_here
WS_PORT=8080
```

### 3. Run the Server

Development mode (with hot reload):
```bash
pnpm dev
```

Production mode:
```bash
pnpm build
pnpm start
```

## Architecture

```
backend-ts/
├── src/
│   ├── types/           # Type definitions
│   ├── websocket/       # Chat WebSocket server and protocol
│   ├── notifications/   # Notification WebSocket server
│   ├── api/            # HTTP API routes for notifications
│   ├── llm/            # LLM provider (Gemini)
│   ├── orchestrator/   # AI orchestration logic
│   ├── tools/          # Available tools/functions
│   ├── config.ts       # Configuration loading
│   └── index.ts        # Entry point
```

## WebSocket Endpoints

The server provides two WebSocket endpoints:

### 1. Chat WebSocket (Root: `/`)

Real-time AI chat communication using structured messages:

```typescript
interface WebSocketMessage {
  type: MessageType;
  payload: unknown;
  timestamp: number;
  message_id: string;
}
```

**Message Types:**
- `connection_established` - Server sends on successful connection
- `chat_message` - User/client messages
- `function_call` - AI wants to call a function
- `function_result` - Result from function execution
- `error` - Error messages

### 2. Notification WebSocket (`/api/notifications/ws`)

Real-time push notifications for authenticated users:

**Client → Server:**
- `authenticate` - Authenticate with userId and admin status
- `ping` - Keep-alive ping

**Server → Client:**
- `connected` - Connection confirmation with clientId
- `authenticated` - Authentication confirmation
- `notification` - Real-time notification data
- `pong` - Response to ping

## HTTP API Endpoints

### Notification Broadcasting

**POST `/api/broadcast`**
Broadcast a notification to connected clients.

**Request Body:**
```json
{
  "notification": {
    "id": "notif-123",
    "title": "New Update",
    "body": "Check out the latest features",
    "isGlobal": true,
    "targetUserIds": [],
    "priority": "NORMAL",
    "typeId": "type-123",
    "isActive": true,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z",
    "type": {
      "id": "type-123",
      "name": "update",
      "displayName": "Update"
    }
  }
}
```

**POST `/api/broadcast-admin`**
Broadcast a message to admin clients only.

**Request Body:**
```json
{
  "message": {
    "type": "admin_message",
    "data": { /* any data */ }
  }
}
```

### Health & Monitoring

**GET `/health`** - Health check endpoint  
**GET `/api/stats`** - Server statistics (connected clients, uptime, etc.)

## AI Orchestration Flow

1. **User sends message** via WebSocket
2. **Orchestrator processes** message with system prompt
3. **AI decides** whether to call functions or respond directly
4. **Function execution** if needed (with result streaming)
5. **Final response** to user
6. **Loop continues** until AI provides a final answer

### System Prompt

The orchestrator uses a system prompt that instructs the AI:
- To analyze user requests
- To use appropriate functions
- To provide final answers after receiving function results
- To never call the same function twice
- To use function results to answer questions

## Available Tools

### get_weather
Get current weather information for a location.

**Parameters:**
- `location` (string, required): City or location name
- `unit` (string, optional): Temperature unit (celsius/fahrenheit)

**Example:**
```json
{
  "name": "get_weather",
  "args": {
    "location": "New York",
    "unit": "celsius"
  }
}
```

### plan_todos
Plan the steps needed to fulfill a request.

**Parameters:**
- `todos` (array, required): List of tasks

## Development

### Project Structure

- **Types**: Shared type definitions
- **WebSocket**: Server implementation and protocol handling
- **LLM**: Gemini API integration with function calling
- **Orchestrator**: Core orchestration logic with while loop
- **Tools**: Implemented functions (weather, etc.)

### Adding New Tools

1. Create a new file in `src/tools/`
2. Implement the function
3. Add function declaration to `GeminiProvider`
4. Add case in `OrchestratorService.executeFunction()`

## License

MIT


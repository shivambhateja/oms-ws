# Backend TypeScript Project Structure

## Project Overview
Complete TypeScript implementation of the Rust AI Orchestrator backend with:
- WebSocket server for real-time communication
- AI orchestration with function calling
- Gemini API integration
- Modular, type-safe architecture

## Setup Instructions

1. **Install dependencies:**
```bash
cd backend-ts
pnpm install
```

2. **Configure environment:**
Create `.env` file:
```env
GOOGLE_GENERATIVE_AI_API_KEY=your_api_key_here
WS_PORT=8080
```

3. **Run the server:**
```bash
pnpm dev
```

## Architecture

### Directory Structure
```
src/
├── types/              # Type definitions (messages, roles)
├── websocket/          # WebSocket server, protocol, handler
├── llm/               # LLM provider (Gemini API)
├── orchestrator/       # AI orchestration logic (with while loop)
├── tools/             # Available tools (weather, etc.)
├── config.ts          # Configuration loading
└── index.ts           # Entry point
```

### Key Features
- **WebSocket Server**: Type-safe real-time communication
- **AI Orchestration**: While loop to process AI responses until final answer
- **Function Calling**: Gemini API with tool invocation
- **System Prompt**: Agentic AI system prompt for tool usage
- **Type Safety**: Full TypeScript with strict mode

### WebSocket Protocol
Messages follow the structure:
```typescript
interface WebSocketMessage {
  type: MessageType;
  payload: unknown;
  timestamp: number;
  message_id: string;
}
```

### Orchestration Flow
1. User sends message → WebSocket receives
2. Orchestrator processes with system prompt
3. AI decides: call function or respond
4. If function: execute → loop back
5. If response: send final answer
6. Repeat until max iterations or final answer


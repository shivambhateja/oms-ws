export enum Role {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Function = "function"
}

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
}

export function messagesToPrompt(messages: ChatMessage[]): string {
  return messages.map(message => {
    const roleStr = message.role;
    if (message.name) {
      return `${roleStr} (${message.name}): ${message.content}`;
    }
    return `${roleStr}: ${message.content}`;
  }).join("\n");
}


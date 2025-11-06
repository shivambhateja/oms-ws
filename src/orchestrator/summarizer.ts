import axios from 'axios';
import { ChatMessage } from '../types/message.js';

export class ChatSummarizer {
  private openAiApiKey: string;
  private client: ReturnType<typeof axios.create>;

  constructor(openAiApiKey: string) {
    this.openAiApiKey = openAiApiKey;
    this.client = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'Authorization': `Bearer ${this.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Summarize a list of messages using OpenAI mini model
   */
  async summarizeMessages(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    // Format messages for summarization
    const conversationText = messages
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n');

    const prompt = `Summarize the following conversation concisely, preserving important details, decisions, context, and key information that would be useful for continuing the conversation later. Focus on:
- Main topics discussed
- Important decisions or preferences mentioned
- Key facts or data points
- User's goals or objectives
- Any specific requests or requirements

Keep the summary concise but informative (2-4 sentences if possible, up to 200 words).

Conversation:
${conversationText}

Summary:`;

    try {
      const response = await this.client.post(
        '/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant that creates concise summaries of conversations.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 300,
        }
      );

      const summary = response.data.choices[0]?.message?.content?.trim() || '';
      return summary;
    } catch (error) {
      console.error('[Summarizer] Error summarizing messages:', error);
      // Fallback: create a simple summary
      return `Previous conversation covered ${messages.length} messages about various topics.`;
    }
  }

  /**
   * Estimate token count (rough approximation)
   * 1 token ≈ 4 characters for English text
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}


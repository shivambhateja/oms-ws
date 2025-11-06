import axios, { AxiosInstance } from 'axios';
import { ChatMessage, Role } from '../types/message.js';

export enum OpenAIModel {
  GPT4o = "gpt-4o",
  GPT4oTurbo = "gpt-4o-mini",
  GPT35Turbo = "gpt-3.5-turbo",
}

export enum AvailableFunction {
  BrowsePublishers = "browsePublishers",
  GetPublisherDetails = "getPublisherDetails",
  ViewCart = "viewCart",
  AddToCart = "addToCart",
  ProcessPayment = "processPayment",
}

export enum FunctionExecutionLocation {
  Backend = "backend",
  Frontend = "frontend",
}

export interface FunctionCallResponse {
  name: string; // Can be AvailableFunction or any frontend function name
  args: Record<string, unknown>;
}

export interface OpenAIMessageResponse {
  choices: Array<{
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
      tool_call_id?: string;
      name?: string;
    };
    finish_reason?: string;
  }>;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface Todo {
  task: string;
  description: string;
  dependencies?: string[];
  estimated_time?: number;
}

export interface PlanResult {
  todos: Todo[];
}

export class OpenAIProvider {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  private createFunctionDeclarations(additionalFunctions: FunctionDeclaration[] = []): FunctionDeclaration[] {
    const backendFunctions = [
      {
        name: AvailableFunction.BrowsePublishers,
        description: "Browse and search for publishers/websites for backlinking opportunities. Returns data to display in user interface. Use this when user asks to find, search, browse, or show publishers/websites.",
        parameters: {
          type: "object",
          properties: {
            // Basic filters
            niche: {
              type: "string",
              description: "Filter by niche/category (e.g., Technology, Health, Business, Finance, Travel)"
            },
            language: {
              type: "string",
              description: "Filter by language (e.g., English, Spanish, French)"
            },
            country: {
              type: "string",
              description: "Filter by country (e.g., United States, United Kingdom, Canada, India)"
            },
            searchQuery: {
              type: "string",
              description: "Search query for website names or niches (searches in website names and niche tags)"
            },
            
            // Authority metrics
            daMin: {
              type: "number",
              description: "Minimum Domain Authority (0-100). DA predicts ranking ability."
            },
            daMax: {
              type: "number",
              description: "Maximum Domain Authority (0-100)"
            },
            paMin: {
              type: "number",
              description: "Minimum Page Authority (0-100). PA predicts page ranking ability."
            },
            paMax: {
              type: "number",
              description: "Maximum Page Authority (0-100)"
            },
            drMin: {
              type: "number",
              description: "Minimum Domain Rating (0-100). DR measures link profile strength."
            },
            drMax: {
              type: "number",
              description: "Maximum Domain Rating (0-100)"
            },
            
            // Quality filters
            spamMin: {
              type: "number",
              description: "Minimum spam score (0-100). Lower is better quality."
            },
            spamMax: {
              type: "number",
              description: "Maximum spam score (0-100). Lower is better quality."
            },
            
            // Traffic metrics
            semrushOverallTrafficMin: {
              type: "number",
              description: "Minimum Semrush overall traffic (monthly visits)"
            },
            semrushOrganicTrafficMin: {
              type: "number",
              description: "Minimum Semrush organic traffic (monthly organic visits)"
            },
            
            // Pricing
            priceMin: {
              type: "number",
              description: "Minimum price in USD for backlink placement"
            },
            priceMax: {
              type: "number",
              description: "Maximum price in USD for backlink placement"
            },
            
            // Backlink attributes
            backlinkNature: {
              type: "string",
              description: "Type of backlink attribute",
              enum: ["do-follow", "no-follow"]
            },
            
            // Availability
            availability: {
              type: "boolean",
              description: "Filter by availability status (true = available only)"
            },
            
            // Text search
            remarkIncludes: {
              type: "string",
              description: "Search in website remarks/notes (substring match)"
            },
            
            // Pagination
            page: {
              type: "number",
              description: "Page number for pagination (default: 1)"
            },
            limit: {
              type: "number",
              description: "Number of results per page (default: 8)"
            }
          },
          required: []
        }
      },
      {
        name: AvailableFunction.ViewCart,
        description: "View the current contents of the shopping cart. Use this to show the user their cart and ask if they want to edit or proceed to checkout.",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: AvailableFunction.AddToCart,
        description: "Add a publisher or product to the shopping cart. Use this when user mentions specific publishers they want to add or says 'add to cart'.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["publisher", "product"],
              description: "Type of item to add"
            },
            name: {
              type: "string",
              description: "Name of the item"
            },
            price: {
              type: "number",
              description: "Price of the item in USD"
            },
            quantity: {
              type: "number",
              description: "Quantity to add (default: 1)"
            },
            metadata: {
              type: "object",
              description: "Additional metadata about the item (publisherId, website, niche, dr, da)",
              properties: {
                publisherId: { type: "string" },
                website: { type: "string" },
                niche: { type: "array", items: { type: "string" } },
                dr: { type: "number" },
                da: { type: "number" }
              }
            }
          },
          required: ["type", "name", "price"]
        }
      },
      {
        name: AvailableFunction.ProcessPayment,
        description: "Process payment for cart items using Stripe. Use this when user is ready to checkout and says they're done adding items.",
        parameters: {
          type: "object",
          properties: {
            cartItems: {
              type: "array",
              description: "Items in the cart to process payment for",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  price: { type: "number" },
                  quantity: { type: "number" }
                }
              }
            }
          },
          required: ["cartItems"]
        }
      }
    ];

    return [...backendFunctions, ...additionalFunctions];
  }

  // Convert OpenAI response to Gemini-like format for compatibility
  async call(
    messages: ChatMessage[],
    model: OpenAIModel = OpenAIModel.GPT35Turbo,
    useFunctions: boolean = false,
    additionalFunctions: FunctionDeclaration[] = [],
    abortSignal?: AbortSignal
  ): Promise<{ candidates: Array<{ content: { parts: Array<{ text?: string; functionCall?: FunctionCallResponse }> } }> }> {
    // Convert chat messages to OpenAI format
    const openAIMessages = messages
      .map(msg => {
        // OpenAI doesn't support system messages at the top level in the same way
        // System messages should be role "system"
        if (msg.role === Role.System) {
          return {
            role: 'system',
            content: msg.content
          };
        } else if (msg.role === Role.User) {
          return {
            role: 'user',
            content: msg.content
          };
        } else if (msg.role === Role.Assistant) {
          return {
            role: 'assistant',
            content: msg.content
          };
        } else if (msg.role === Role.Function) {
          // OpenAI uses tool responses for function results
          // Since we don't have the actual tool_call_id from the assistant's response,
          // we skip these messages as they're incompatible with OpenAI's format without proper IDs
          // They're only added to history for record-keeping
          return null;
        }
        // Fallback
        return {
          role: 'user',
          content: msg.content
        };
      })
      .filter(msg => msg !== null);

    const payload: Record<string, unknown> = {
      model,
      messages: openAIMessages,
      temperature: 0.7,
      max_tokens: 1024,
    };

    if (useFunctions) {
      const functions = this.createFunctionDeclarations(additionalFunctions);
      payload.tools = functions.map(func => ({
        type: 'function',
        function: {
          name: func.name,
          description: func.description,
          parameters: func.parameters
        }
      }));
    }


    const response = await this.client.post<OpenAIMessageResponse>(
      '/chat/completions',
      payload,
      { signal: abortSignal }
    );

    // Convert OpenAI response to Gemini-like format
    const choice = response.data.choices[0];
    const parts: Array<{ text?: string; functionCall?: FunctionCallResponse }> = [];

    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const toolCall of choice.message.tool_calls) {
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments)
          }
        });
      }
    }

    return {
      candidates: [{
        content: {
          parts
        }
      }]
    };
  }

  async planFromQuery(
    userQuery: string,
    model: OpenAIModel = OpenAIModel.GPT4o
  ): Promise<PlanResult> {
    const payload = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that creates execution plans in JSON format.'
        },
        {
          role: 'user',
          content: `Analyze this user query and create an execution plan. The plan should identify if this is a simple request (normal) or complex request (complex). Then generate a list of todos that need to be executed to fulfill the request. User query: ${userQuery}. Return a JSON object with a "todos" array, where each todo has "task", "description", optional "dependencies" (array of task IDs), and optional "estimated_time" (number of seconds).`
        }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    };

    const response = await this.client.post<OpenAIMessageResponse>(
      '/chat/completions',
      payload
    );

    const textContent = response.data.choices[0]?.message?.content;
    
    if (!textContent) {
      throw new Error("No text content in response");
    }

    return JSON.parse(textContent) as PlanResult;
  }
}


import axios, { AxiosInstance } from 'axios';
import { ChatMessage, Role } from '../types/message.js';

export enum GeminiModel {
  GeminiPro = "gemini-2.5-pro",
  GeminiMed = "gemini-2.5-flash",
  GeminiLite = "gemini-2.5-flash-lite",
}

export enum AvailableFunction {
  BrowsePublishers = "browsePublishers",
  GetPublisherDetails = "getPublisherDetails",
  GetWeather = "getWeather",
}

export enum FunctionExecutionLocation {
  Backend = "backend",
  Frontend = "frontend",
}

export interface FunctionCallResponse {
  name: string; // Can be AvailableFunction or any frontend function name
  args: Record<string, unknown>;
}

export interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        functionCall?: FunctionCallResponse;
      }>;
    };
    finishReason?: string;
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

export class GeminiProvider {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      timeout: 30000,
    });
  }

  private getEndpoint(model: GeminiModel): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
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
      }
    ];

    return [...backendFunctions, ...additionalFunctions];
  }

  async call(
    messages: ChatMessage[],
    model: GeminiModel = GeminiModel.GeminiLite,
    useFunctions: boolean = false,
    additionalFunctions: FunctionDeclaration[] = []
  ): Promise<GeminiResponse> {
    // Convert chat messages to Gemini format
    // For now, just format as text. In production, you'd use proper role-based formatting
    const contents = messages.map(msg => {
      if (msg.role === Role.System) {
        return {
          parts: [{ text: msg.content }],
          role: 'user'
        };
      } else {
        return {
          parts: [{ text: msg.content }],
          role: msg.role === Role.User ? 'user' : 'model'
        };
      }
    });

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      }
    };

    if (useFunctions) {
      payload.tools = [
        {
          functionDeclarations: this.createFunctionDeclarations(additionalFunctions)
        }
      ];
    }

    const response = await this.client.post<GeminiResponse>(
      this.getEndpoint(model),
      payload
    );

    return response.data;
  }

  async planFromQuery(
    userQuery: string,
    model: GeminiModel = GeminiModel.GeminiPro
  ): Promise<PlanResult> {
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `Analyze this user query and create an execution plan. The plan should identify if this is a simple request (normal) or complex request (complex). Then generate a list of todos that need to be executed to fulfill the request. User query: ${userQuery}`
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "List of tasks to execute",
              items: {
                type: "object",
                properties: {
                  task: {
                    type: "string",
                    description: "Short task name"
                  },
                  description: {
                    type: "string",
                    description: "Detailed description of what needs to be done"
                  },
                  dependencies: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of task IDs this task depends on"
                  },
                  estimated_time: {
                    type: "number",
                    description: "Estimated time in seconds"
                  }
                },
                required: ["task", "description"]
              }
            }
          },
          required: ["todos"]
        }
      }
    };

    const response = await this.client.post<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }>(
      this.getEndpoint(model),
      payload
    );

    const textContent = response.data.candidates[0]?.content.parts[0]?.text;
    
    if (!textContent) {
      throw new Error("No text content in response");
    }

    return JSON.parse(textContent) as PlanResult;
  }
}


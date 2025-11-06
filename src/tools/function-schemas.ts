/**
 * Function schemas for Gemini function calling
 * These functions will be executed on the FRONTEND, not backend
 */

export enum FrontendFunction {
  CreateExecutionPlan = "createExecutionPlan",
  // UpdatePlanProgress = "updatePlanProgress", // DISABLED - causes AI to loop on progress updates instead of executing tasks
  GetPublisherDetails = "getPublisherDetails",
  AddToCart = "addToCart",
  RemoveFromCart = "removeFromCart",
  ViewCart = "viewCart",
  ClearCart = "clearCart",
  UpdateCartItemQuantity = "updateCartItemQuantity",
  ProcessPayment = "processPayment",
  CollectPublisherFilters = "collectPublisherFilters",
  DisplayOrders = "displayOrders",
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export const FRONTEND_FUNCTION_SCHEMAS: FunctionDeclaration[] = [
  {
    name: FrontendFunction.CreateExecutionPlan,
    description: "Create an execution plan for complex user requests",
    parameters: {
      type: "object",
      properties: {
        userRequest: { type: "string", description: "The user's request" },
        context: { type: "object", description: "Current context (cart, filters, etc.)" }
      },
      required: ["userRequest"]
    }
  },
  // DISABLED - UpdatePlanProgress causes AI to loop instead of executing actual tasks
  // {
  //   name: FrontendFunction.UpdatePlanProgress,
  //   description: "Update plan progress after completing a step",
  //   parameters: {
  //     type: "object",
  //     properties: {
  //       planId: { type: "string", description: "Plan ID" },
  //       stepIndex: { type: "number", description: "Completed step index" },
  //       stepResult: { type: "object", description: "Result of the step" }
  //     },
  //     required: ["planId", "stepIndex"]
  //   }
  // },
  {
    name: FrontendFunction.GetPublisherDetails,
    description: "Get detailed information about a specific publisher",
    parameters: {
      type: "object",
      properties: {
        publisherId: { type: "string", description: "Unique identifier for the publisher" }
      },
      required: ["publisherId"]
    }
  },
  {
    name: FrontendFunction.AddToCart,
    description: "Add a publisher or product to the shopping cart",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["publisher", "product"], description: "Type of item to add" },
        name: { type: "string", description: "Name of the item" },
        price: { type: "number", description: "Price of the item in USD" },
        quantity: { type: "number", description: "Quantity to add" },
        metadata: {
          type: "object",
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
    name: FrontendFunction.RemoveFromCart,
    description: "Remove an item from the shopping cart",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Unique identifier of the item to remove" }
      },
      required: ["itemId"]
    }
  },
  {
    name: FrontendFunction.ViewCart,
    description: "View the current contents of the shopping cart",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: FrontendFunction.ClearCart,
    description: "Clear all items from the shopping cart",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: FrontendFunction.UpdateCartItemQuantity,
    description: "Update the quantity of an item in the shopping cart",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Unique identifier of the item" },
        quantity: { type: "number", description: "New quantity" }
      },
      required: ["itemId", "quantity"]
    }
  },
  {
    name: FrontendFunction.ProcessPayment,
    description: "Process payment for cart items using Stripe",
    parameters: {
      type: "object",
      properties: {
        cartItems: {
          type: "array",
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
  },
  {
    name: FrontendFunction.CollectPublisherFilters,
    description: "Collect filters from user through interactive modals",
    parameters: {
      type: "object",
      properties: {
        step: { type: "string", enum: ["price", "dr", "complete"], description: "Current step" },
        userInput: { type: "string", description: "User input or response" },
        currentFilters: {
          type: "object",
          properties: {
            priceRange: {
              type: "object",
              properties: {
                min: { type: "number" },
                max: { type: "number" }
              }
            },
            drRange: {
              type: "object",
              properties: {
                minDR: { type: "number" },
                maxDR: { type: "number" },
                minDA: { type: "number" },
                maxDA: { type: "number" }
              }
            }
          }
        }
      },
      required: []
    }
  },
  {
    name: FrontendFunction.DisplayOrders,
    description: "Display user orders with filtering",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to fetch orders for" },
        limit: { type: "number", description: "Number of orders to fetch" },
        status: { type: "string", enum: ["PENDING", "PAID", "FAILED", "CANCELLED"] }
      },
      required: []
    }
  }
];


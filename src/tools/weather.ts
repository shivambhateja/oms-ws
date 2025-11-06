import { AvailableFunction } from '../llm/gemini.js';

export interface WeatherArgs {
  location: string;
  unit?: 'celsius' | 'fahrenheit';
}

export interface WeatherResult {
  location: string;
  temperature: number;
  unit: 'celsius' | 'fahrenheit';
  description: string;
}

export async function getWeather(args: WeatherArgs): Promise<WeatherResult> {
  // Simulate weather API call
  // In a real implementation, you would call an actual weather API
  // For now, return a mock response
  return {
    location: args.location,
    temperature: 22,
    unit: args.unit || 'celsius',
    description: 'Partly cloudy'
  };
}

export function createWeatherFunctionCall(args: WeatherArgs) {
  return {
    name: AvailableFunction.GetWeather,
    args: {
      location: args.location,
      unit: args.unit || 'celsius'
    }
  };
}


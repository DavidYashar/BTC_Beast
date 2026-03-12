import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000 });

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Generate a chat completion.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-5.2',
    messages,
    temperature: opts.temperature ?? 0.8,
    max_completion_tokens: opts.maxTokens ?? 280,
  });
  return response.choices[0]?.message?.content?.trim() ?? '';
}

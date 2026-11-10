import {
  PROVIDER_TIMEOUT_MS,
  ProviderError,
  type VisionProvider,
} from "./visionProvider.ts";

/* ######################################################################
 * OpenRouter (free vision model) via the OpenAI-compatible chat API.
 * ###################################################################### */

type ChatResponse = {
  choices?: {
    message?: { content?: string | null; reasoning?: string | null };
  }[];
};

export function createOpenRouterProvider(
  apiKey: string,
  model: string,
): VisionProvider {
  return {
    name: "openrouter",
    supports: (mimeType) => mimeType.startsWith("image/"),
    async complete({ prompt, file }) {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "X-Title": "RealPay",
          },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${file.mimeType};base64,${file.base64}`,
                    },
                  },
                ],
              },
            ],
          }),
        },
      );
      if (!response.ok) {
        throw new ProviderError(
          "openrouter",
          response.status,
          `OpenRouter returned ${response.status}`,
        );
      }
      const json = (await response.json()) as ChatResponse;
      const message = json.choices?.[0]?.message;
      // Some free reasoning models put the final JSON in `reasoning`.
      return message?.content || message?.reasoning || "";
    },
  };
}

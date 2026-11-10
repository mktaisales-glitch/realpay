import {
  PROVIDER_TIMEOUT_MS,
  ProviderError,
  type VisionProvider,
} from "./visionProvider.ts";

/* ######################################################################
 * Google Gemini (free tier) via the REST generateContent endpoint.
 * ###################################################################### */

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
};

export function createGeminiProvider(
  apiKey: string,
  model: string,
): VisionProvider {
  return {
    name: "gemini",
    supports: (mimeType) =>
      ["image/jpeg", "image/png", "application/pdf"].includes(mimeType),
    async complete({ prompt, file }) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: file.mimeType,
                      data: file.base64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
            },
          }),
        },
      );
      if (!response.ok) {
        throw new ProviderError(
          "gemini",
          response.status,
          `Gemini returned ${response.status}`,
        );
      }
      const json = (await response.json()) as GeminiResponse;
      return (
        json.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("") ?? ""
      );
    },
  };
}

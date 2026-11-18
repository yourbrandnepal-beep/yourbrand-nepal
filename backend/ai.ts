import { GoogleGenAI, Type } from '@google/genai';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured in Settings > Secrets. Add a Gemini API key to use RR AI Brain.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export type AIAssistMode =
  | 'personal_assistant'
  | 'voice_assistant'
  | 'smart_replies'
  | 'translate'
  | 'summary'
  | 'rewrite'
  | 'grammar'
  | 'spam_check'
  | 'image_spec'
  | 'sticker_spec';

export interface AIAssistResult {
  resultText?: string;
  suggestions?: string[];
  audioDataUrl?: string;
  grammar?: { correctedText: string; issues: string[] };
  spamReport?: { riskLevel: 'safe' | 'suspicious' | 'phishing'; score: number; reasons: string[]; advice: string };
  generatedArt?: {
    title: string;
    svgMarkup: string;
    shape?: 'cube' | 'torus' | 'prism' | 'star';
    color?: string;
    glowColor?: string;
    label?: string;
  };
  model: string;
}

export async function runAIAssistant(
  mode: AIAssistMode,
  input: {
    text?: string;
    messages?: string[];
    targetLang?: string;
    tone?: string;
    voiceName?: string;
  }
): Promise<AIAssistResult> {
  const ai = getGeminiClient();

  if (mode === 'personal_assistant') {
    const promptText = (input.text ?? '').trim();
    if (!promptText) throw new Error('Provide a question or prompt for RR AI Personal Assistant.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: promptText,
      config: {
        systemInstruction:
          'You are RR AI Brain, an opt-in privacy-first assistant inside RRchat 1. Respond clearly and concisely in the user’s language (supporting Nepali, English, and global languages). Never claim access to unshared encrypted messages.',
      },
    });
    return { resultText: (response.text ?? '').trim(), model: 'gemini-4-hydrogen' };
  }

  if (mode === 'voice_assistant') {
    const promptText = (input.text ?? '').trim();
    if (!promptText) throw new Error('Provide a prompt for the AI Voice Assistant.');
    const textResp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: promptText,
      config: {
        systemInstruction:
          'You are RR Voice Assistant. Give a crisp, natural, conversational spoken reply under 60 words.',
      },
    });
    const reply = (textResp.text ?? '').trim();
    const ttsResp = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: reply,
              speechMetadata: {
                style: 'Clear, calm, helpful voice assistant',
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'].includes(String(input.voiceName))
                ? String(input.voiceName)
                : 'Kore',
            },
          },
        },
      },
    });
    const base64Audio = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const audioDataUrl = base64Audio ? `data:audio/wav;base64,${base64Audio}` : undefined;
    return { resultText: reply, audioDataUrl, model: 'gemini-3.8-flash-lite-tts' };
  }

  if (mode === 'smart_replies') {
    const contextLines = (input.messages ?? []).slice(-12).join('\n');
    const promptText = input.text?.trim() || contextLines;
    if (!promptText) {
      throw new Error('Provide recent message text to generate smart reply suggestions.');
    }
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Conversation snippet:\n${promptText}`,
      config: {
        systemInstruction:
          'Generate exactly 3 natural, concise, context-aware reply suggestions for a private messaging app matching the language of the snippet (including Nepali or English). Keep each under 14 words.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
        },
      },
    });
    const parsed = JSON.parse((response.text ?? '{"suggestions":[]}').trim()) as { suggestions?: string[] };
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [],
      model: 'gemini-4-hydrogen',
    };
  }

  if (mode === 'translate') {
    const text = (input.text ?? '').trim();
    const lang = (input.targetLang ?? 'Nepali').trim();
    if (!text) throw new Error('Provide text to translate.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Translate the following message accurately into ${lang}. Return only the translated text without commentary:\n\n${text}`,
    });
    return { resultText: (response.text ?? '').trim(), model: 'gemini-4-hydrogen' };
  }

  if (mode === 'summary') {
    const transcript = (input.messages ?? []).slice(-40).join('\n') || (input.text ?? '').trim();
    if (!transcript) throw new Error('Provide conversation messages to summarize.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Summarize this private conversation concisely in 3-5 clear bullet points capturing decisions, questions, and action items:\n\n${transcript}`,
      config: {
        systemInstruction: 'You are RR AI Brain. Provide objective, concise conversation summaries.',
      },
    });
    return { resultText: (response.text ?? '').trim(), model: 'gemini-4-hydrogen' };
  }

  if (mode === 'rewrite') {
    const draft = (input.text ?? '').trim();
    const tone = (input.tone ?? 'Clear & Professional').trim();
    if (!draft) throw new Error('Provide draft text for AI Message Writer.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Compose or rewrite this message in a "${tone}" style while keeping clarity and intent. Return only the polished message:\n\n${draft}`,
    });
    return { resultText: (response.text ?? '').trim(), model: 'gemini-4-hydrogen' };
  }

  if (mode === 'grammar') {
    const draft = (input.text ?? '').trim();
    if (!draft) throw new Error('Provide text to check grammar and spelling.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Check grammar, spelling, and clarity for the following message:\n\n${draft}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            correctedText: { type: Type.STRING },
            issues: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
        },
      },
    });
    const parsed = JSON.parse((response.text ?? '{}').trim()) as { correctedText?: string; issues?: string[] };
    return {
      resultText: parsed.correctedText ?? draft,
      grammar: {
        correctedText: parsed.correctedText ?? draft,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      },
      model: 'gemini-4-hydrogen',
    };
  }

  if (mode === 'spam_check') {
    const draft = (input.text ?? '').trim();
    if (!draft) throw new Error('Provide message text or link to inspect for spam or phishing.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this message for spam, scam, social engineering, or phishing risk:\n\n${draft}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            riskLevel: { type: Type.STRING },
            score: { type: Type.INTEGER },
            reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
            advice: { type: Type.STRING },
          },
        },
      },
    });
    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      riskLevel?: string;
      score?: number;
      reasons?: string[];
      advice?: string;
    };
    const riskLevel =
      parsed.riskLevel === 'phishing' || parsed.riskLevel === 'suspicious' ? parsed.riskLevel : 'safe';
    return {
      spamReport: {
        riskLevel,
        score: Number(parsed.score ?? 10),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
        advice: parsed.advice || 'Inspect URLs carefully before clicking.',
      },
      model: 'gemini-4-hydrogen',
    };
  }

  if (mode === 'image_spec' || mode === 'sticker_spec') {
    const promptText = (input.text ?? '').trim();
    if (!promptText) throw new Error('Describe the artwork or 3D sticker you want to generate.');
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Design a crisp geometric SVG emblem/artwork (${mode === 'sticker_spec' ? '256x256 compact sticker badge' : '512x512 futuristic vector poster'}) for the prompt: "${promptText}". Use deep obsidian, chrome silver, and neon purple aesthetic unless specified otherwise.`,
      config: {
        systemInstruction:
          'Return valid JSON matching the schema. Keep svgMarkup strictly clean standalone <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">...</svg> with ZERO <script> tags, ZERO foreignObject, and ZERO external URLs.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            shape: { type: Type.STRING },
            color: { type: Type.STRING },
            glowColor: { type: Type.STRING },
            label: { type: Type.STRING },
            svgMarkup: { type: Type.STRING },
          },
        },
      },
    });
    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      title?: string;
      shape?: string;
      color?: string;
      glowColor?: string;
      label?: string;
      svgMarkup?: string;
    };
    const safeSvg = String(parsed.svgMarkup ?? '')
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/on\w+=/gi, '')
      .trim();
    const shape = ['cube', 'torus', 'prism', 'star'].includes(String(parsed.shape))
      ? (parsed.shape as 'cube' | 'torus' | 'prism' | 'star')
      : 'prism';
    return {
      generatedArt: {
        title: parsed.title || promptText.slice(0, 32),
        shape,
        color: parsed.color || '#A855F7',
        glowColor: parsed.glowColor || '#E2E8F0',
        label: (parsed.label || promptText.slice(0, 12)).toUpperCase(),
        svgMarkup: safeSvg.startsWith('<svg')
          ? safeSvg
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="44" fill="#090B12"/><circle cx="128" cy="112" r="64" fill="#9333EA" opacity="0.28"/><polygon points="128,44 190,148 66,148" fill="#A855F7" stroke="#E2E8F0" stroke-width="5"/><text x="128" y="212" text-anchor="middle" fill="#F8FAFC" font-family="sans-serif" font-size="20" font-weight="bold">${(parsed.label || 'RRchat 1').slice(0, 14)}</text></svg>`,
      },
      model: 'gemini-4-hydrogen',
    };
  }

  throw new Error('Unsupported AI assistant mode.');
}

export async function transcribeAudioWithGemini(
  audioBase64: string,
  mimeType: string
): Promise<{ transcript: string }> {
  const ai = getGeminiClient();
  const cleanB64 = audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanB64) {
    throw new Error('Audio data is required for transcription.');
  }
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'audio/webm',
            data: cleanB64,
          },
        },
        {
          text: 'Transcribe the spoken words accurately in plain text.',
        },
      ],
    },
  });
  return { transcript: (response.text ?? '').trim() };
}

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_TEXT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_MAX_AUDIO_FILES = 6;
const DEFAULT_MAX_CLIP_SECONDS = 40;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const TTS_COST_PER_SECOND_USD = 0.0005; // Approx. paid-tier output cost at 25 audio tokens/sec and $20/1M tokens.

const VOICES = [
  "Iapetus",     // Clear
  "Kore",        // Firm
  "Gacrux",      // Mature
  "Achird",      // Friendly
  "Aoede",       // Breezy
  "Puck",        // Upbeat
  "Charon",      // Informative
  "Sulafat",     // Warm
  "Schedar",     // Even
  "Leda",        // Youthful
];

const LANGUAGE_CODE = {
  English: "en",
  Hindi: "hi",
  Odia: "or",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        ok: true,
        service: "SKS Audio Assistant",
        telegram_webhook: "/telegram",
        text_model: env.TEXT_MODEL || DEFAULT_TEXT_MODEL,
        tts_model: env.TTS_MODEL || DEFAULT_TTS_MODEL,
        sessions_binding: Boolean(env.SESSIONS),
      });
    }

    if (url.pathname === "/telegram" && request.method === "GET") {
      return new Response("Telegram webhook endpoint is ready.", { status: 200 });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // Return to Telegram immediately. The actual work continues in the background.
      ctx.waitUntil(
        handleUpdate(update, env).catch((error) => {
          console.error("Unhandled update error:", error?.stack || error);
        }),
      );

      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleUpdate(update, env) {
  validateEnvironment(env);

  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  const message = update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  if (!chatId || !userId) return;

  // /whoami intentionally works before authorization so setup/recovery is easy.
  if (normalizeCommand(text) === "/whoami") {
    await sendMessage(env, chatId, `Your Telegram user ID is: ${userId}`);
    return;
  }

  if (!isAuthorized(userId, env)) {
    await sendMessage(env, chatId, "This bot is private. Your Telegram account is not authorized.");
    return;
  }

  if (!text) {
    await sendMessage(env, chatId, "Please send a text description or script for the audio you want to create.");
    return;
  }

  const command = normalizeCommand(text);

  if (command === "/start" || command === "/help") {
    await sendHelp(env, chatId);
    return;
  }

  if (command === "/models") {
    await sendMessage(
      env,
      chatId,
      `Text model: ${textModel(env)}\nTTS model: ${ttsModel(env)}\n\nSupported output languages: English, Hindi, Odia (Oriya).`,
    );
    return;
  }

  if (command === "/voices") {
    await sendMessage(
      env,
      chatId,
      [
        "Available voice choices used by this bot:",
        "Iapetus — clear",
        "Kore — firm",
        "Gacrux — mature",
        "Achird — friendly",
        "Aoede — breezy",
        "Puck — upbeat",
        "Charon — informative",
        "Sulafat — warm",
        "Schedar — even",
        "Leda — youthful",
        "",
        "You do not need to name a voice. Describe the style you want and Gemini will choose one.",
      ].join("\n"),
    );
    return;
  }

  if (command === "/new") {
    const session = await loadSession(env, userId);
    session.draft = null;
    session.generating = false;
    session.awaitingRevision = false;
    await saveSession(env, userId, session);
    await sendMessage(env, chatId, "New request started. Send the overview or exact script for the audio you want.");
    return;
  }

  if (command === "/cancel") {
    const session = await loadSession(env, userId);
    session.draft = null;
    session.generating = false;
    session.awaitingRevision = false;
    await saveSession(env, userId, session);
    await sendMessage(env, chatId, "Current draft cancelled. Send a new request whenever you are ready.");
    return;
  }

  if (command === "/status") {
    const session = await loadSession(env, userId);
    if (!session.draft) {
      await sendMessage(env, chatId, "There is no active draft. Send a new audio request first.");
      return;
    }
    await sendDraft(env, chatId, session.draft);
    return;
  }

  if (command === "/usage") {
    const session = await loadSession(env, userId);
    const seconds = Number(session.usage?.ttsSeconds || 0);
    const files = Number(session.usage?.filesGenerated || 0);
    const estimate = seconds * TTS_COST_PER_SECOND_USD;
    await sendMessage(
      env,
      chatId,
      `Current session usage:\nAudio files generated: ${files}\nGenerated/planned TTS seconds: ${seconds.toFixed(0)}\nApprox. paid-tier TTS output cost: $${estimate.toFixed(4)}\n\nThis is an estimate and does not include the very small text-model cost.`,
    );
    return;
  }

  if (command === "/generate") {
    await generateCurrentDraft(env, chatId, userId);
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(env, chatId, "Unknown command. Send /help to see the available commands.");
    return;
  }

  const lower = text.toLowerCase();
  if (["generate", "confirm", "confirmed", "approve", "approved", "yes generate", "generate audio"].includes(lower)) {
    await generateCurrentDraft(env, chatId, userId);
    return;
  }

  const session = await loadSession(env, userId);

  if (!session.draft) {
    await sendMessage(env, chatId, "Preparing your audio script draft...");
    try {
      const draft = await buildDraft(env, text, null);
      session.draft = draft;
      session.generating = false;
      session.awaitingRevision = false;
      await saveSession(env, userId, session);
      await sendDraft(env, chatId, draft);
    } catch (error) {
      console.error("Draft creation failed:", error?.stack || error);
      await sendMessage(env, chatId, `I could not prepare the draft. ${safeError(error)}`);
    }
    return;
  }

  await sendMessage(env, chatId, "Updating the current draft...");
  try {
    const draft = await buildDraft(env, text, session.draft);
    session.draft = draft;
    session.awaitingRevision = false;
    await saveSession(env, userId, session);
    await sendDraft(env, chatId, draft);
  } catch (error) {
    console.error("Draft revision failed:", error?.stack || error);
    await sendMessage(env, chatId, `I could not revise the draft. ${safeError(error)}`);
  }
}

async function handleCallback(callback, env) {
  const userId = callback.from?.id;
  const chatId = callback.message?.chat?.id;
  const data = callback.data || "";

  if (!userId || !chatId) return;

  await answerCallbackQuery(env, callback.id, data === "generate" ? "Starting audio generation..." : undefined);

  if (!isAuthorized(userId, env)) {
    await sendMessage(env, chatId, "This bot is private. Your Telegram account is not authorized.");
    return;
  }

  if (data === "generate") {
    await generateCurrentDraft(env, chatId, userId);
    return;
  }

  if (data === "revise") {
    const session = await loadSession(env, userId);
    if (!session.draft) {
      await sendMessage(env, chatId, "There is no active draft to revise.");
      return;
    }
    session.awaitingRevision = true;
    await saveSession(env, userId, session);
    await sendMessage(env, chatId, "Send the changes you want as a normal message. I will update the existing draft and keep the parts you did not ask to change.");
    return;
  }

  if (data === "cancel") {
    const session = await loadSession(env, userId);
    session.draft = null;
    session.generating = false;
    session.awaitingRevision = false;
    await saveSession(env, userId, session);
    await sendMessage(env, chatId, "Current draft cancelled.");
  }
}

async function buildDraft(env, userInstruction, currentDraft) {
  const maxFiles = maxAudioFiles(env);
  const maxSeconds = maxClipSeconds(env);

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      notes: { type: "string" },
      clips: {
        type: "array",
        minItems: 1,
        maxItems: maxFiles,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            language: { type: "string", enum: ["English", "Hindi", "Odia"] },
            language_code: { type: "string", enum: ["en", "hi", "or"] },
            target_seconds: { type: "integer", minimum: 3, maximum: maxSeconds },
            script: { type: "string" },
            voice_name: { type: "string", enum: VOICES },
            voice_style: { type: "string" },
          },
          required: [
            "title",
            "language",
            "language_code",
            "target_seconds",
            "script",
            "voice_name",
            "voice_style",
          ],
        },
      },
    },
    required: ["summary", "notes", "clips"],
  };

  const baseRules = `You are the planning and script-writing engine for a low-cost Telegram audio generator.

Return ONLY JSON matching the supplied schema.

Rules:
1. Supported final audio languages are English, Hindi and Odia. Treat Oriya and Odiya as Odia.
2. Write English in natural English, Hindi in natural Devanagari Hindi, and Odia in natural Odia script.
3. The user can request one language, multiple languages, one clip, or multiple clips. Produce only what the user actually requested. Never create all three languages unless requested.
4. Maximum files: ${maxFiles}. Maximum duration per clip: ${maxSeconds} seconds.
5. If duration is not specified, choose a practical 10-15 second duration. Keep the script concise enough to fit the target duration naturally.
6. If the user provides an exact script and says not to rewrite it, preserve it. If translation is requested, translate naturally while preserving meaning.
7. If the same content is requested in multiple languages, keep meaning and approximate duration aligned across versions.
8. voice_name must be chosen only from: ${VOICES.join(", ")}.
9. Pick a voice and voice_style that best match the user's requested delivery (professional, warm, energetic, calm, etc.).
10. Avoid unnecessary filler, headings inside the spoken script, quotation marks around the script, or explanations that should not be spoken.
11. notes should contain only a short useful note for the user, or an empty string.
12. Never exceed the requested number of clips or languages because TTS costs money.`;

  let prompt;
  if (currentDraft) {
    prompt = `${baseRules}

This is a REVISION request.
Keep every part of the current draft unchanged unless the user's new instruction asks to change it.
Do not add extra clips or languages unless explicitly requested.

CURRENT DRAFT JSON:
${JSON.stringify(currentDraft)}

USER REVISION:
${userInstruction}`;
  } else {
    prompt = `${baseRules}

USER REQUEST:
${userInstruction}`;
  }

  const response = await geminiInteraction(env, {
    model: textModel(env),
    input: prompt,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema,
    },
    generation_config: {
      thinking_level: "minimal",
    },
  });

  const outputText = extractText(response);
  if (!outputText) throw new Error("Gemini returned no text draft.");

  let draft;
  try {
    draft = JSON.parse(outputText);
  } catch {
    throw new Error("Gemini returned an invalid JSON draft.");
  }

  return validateDraft(draft, env);
}

function validateDraft(draft, env) {
  const maxFiles = maxAudioFiles(env);
  const maxSeconds = maxClipSeconds(env);

  if (!draft || !Array.isArray(draft.clips) || draft.clips.length < 1) {
    throw new Error("The generated draft contains no audio clips.");
  }

  if (draft.clips.length > maxFiles) {
    throw new Error(`The request produced ${draft.clips.length} clips, above the configured limit of ${maxFiles}. Please ask for fewer clips.`);
  }

  const clips = draft.clips.map((clip, index) => {
    const language = ["English", "Hindi", "Odia"].includes(clip.language) ? clip.language : "English";
    const expectedCode = LANGUAGE_CODE[language];
    const seconds = Math.round(Number(clip.target_seconds || 10));

    if (seconds > maxSeconds) {
      throw new Error(`Clip ${index + 1} exceeds the ${maxSeconds}-second limit.`);
    }

    if (!String(clip.script || "").trim()) {
      throw new Error(`Clip ${index + 1} has an empty script.`);
    }

    return {
      title: String(clip.title || `Clip ${index + 1}`).trim(),
      language,
      language_code: expectedCode,
      target_seconds: Math.max(3, seconds),
      script: String(clip.script).trim(),
      voice_name: VOICES.includes(clip.voice_name) ? clip.voice_name : "Iapetus",
      voice_style: String(clip.voice_style || "Natural, clear and professional").trim(),
    };
  });

  return {
    summary: String(draft.summary || "Audio draft").trim(),
    notes: String(draft.notes || "").trim(),
    clips,
  };
}

async function sendDraft(env, chatId, draft) {
  const totalSeconds = draft.clips.reduce((sum, clip) => sum + Number(clip.target_seconds || 0), 0);
  const estimate = totalSeconds * TTS_COST_PER_SECOND_USD;

  const lines = [
    "Draft ready",
    "",
    draft.summary || "Audio draft",
    "",
  ];

  draft.clips.forEach((clip, index) => {
    lines.push(`Clip ${index + 1} — ${clip.language} — ~${clip.target_seconds}s`);
    lines.push(`Voice: ${clip.voice_name} (${clip.voice_style})`);
    lines.push(clip.script);
    lines.push("");
  });

  if (draft.notes) {
    lines.push(`Note: ${draft.notes}`);
    lines.push("");
  }

  lines.push(`Approx. paid-tier TTS output cost if generated: $${estimate.toFixed(4)}`);
  lines.push("No TTS call has been made yet.");

  await sendLongMessage(env, chatId, lines.join("\n"), {
    inline_keyboard: [
      [
        { text: "Generate Audio", callback_data: "generate" },
        { text: "Revise", callback_data: "revise" },
      ],
      [{ text: "Cancel", callback_data: "cancel" }],
    ],
  });
}

async function generateCurrentDraft(env, chatId, userId) {
  const session = await loadSession(env, userId);
  if (!session.draft) {
    await sendMessage(env, chatId, "There is no active draft. Send an audio request first.");
    return;
  }

  if (session.generating) {
    await sendMessage(env, chatId, "Audio generation is already running for this draft. Please wait for it to finish.");
    return;
  }

  session.generating = true;
  await saveSession(env, userId, session);

  const clips = session.draft.clips;
  const totalSeconds = clips.reduce((sum, clip) => sum + Number(clip.target_seconds || 0), 0);
  const estimate = totalSeconds * TTS_COST_PER_SECOND_USD;

  await sendMessage(
    env,
    chatId,
    `Generating ${clips.length} audio file(s) now. Approx. paid-tier TTS output cost: $${estimate.toFixed(4)}.\n\nNo automatic TTS retry will be made if a clip fails.`,
  );

  try {
    // Generate all requested clips concurrently so short multi-clip jobs have a better chance
    // of completing within a serverless webhook invocation.
    const results = await Promise.all(
      clips.map(async (clip, index) => {
        try {
          const audio = await generateTts(env, clip);
          return { ok: true, index, clip, audio };
        } catch (error) {
          console.error(`TTS generation failed for clip ${index + 1}:`, error?.stack || error);
          return { ok: false, index, clip, error };
        }
      }),
    );

    let successCount = 0;
    let generatedSeconds = 0;

    for (const result of results) {
      if (!result.ok) {
        await sendMessage(
          env,
          chatId,
          `Clip ${result.index + 1} (${result.clip.language}) failed: ${safeError(result.error)}\n\nIt was not automatically retried, to avoid accidental extra TTS cost.`,
        );
        continue;
      }

      const filename = `clip_${String(result.index + 1).padStart(2, "0")}_${result.clip.language_code}.wav`;
      await sendDocument(
        env,
        chatId,
        result.audio.bytes,
        filename,
        `Clip ${result.index + 1} — ${result.clip.language} — ${result.clip.voice_name}`,
        "audio/wav",
      );
      successCount += 1;
      generatedSeconds += Number(result.clip.target_seconds || 0);
    }

    session.usage = session.usage || { ttsSeconds: 0, filesGenerated: 0 };
    session.usage.ttsSeconds = Number(session.usage.ttsSeconds || 0) + generatedSeconds;
    session.usage.filesGenerated = Number(session.usage.filesGenerated || 0) + successCount;
    session.generating = false;
    session.lastGeneratedAt = new Date().toISOString();
    await saveSession(env, userId, session);

    if (successCount === 0) {
      await sendMessage(env, chatId, "No audio files were generated successfully. The draft is still active, so you can revise it or use /generate again.");
    } else {
      await sendMessage(
        env,
        chatId,
        `Finished. ${successCount}/${clips.length} audio file(s) generated successfully.\n\nThe draft remains active. You can revise it or use /new for another request.`,
      );
    }
  } catch (error) {
    session.generating = false;
    await saveSession(env, userId, session);
    console.error("Audio generation job failed:", error?.stack || error);
    await sendMessage(env, chatId, `Audio generation stopped: ${safeError(error)}`);
  }
}

async function generateTts(env, clip) {
  const ttsPrompt = `Synthesize speech only. Do not read these instructions aloud.

### AUDIO PROFILE
Language: ${clip.language}
Voice character and delivery: ${clip.voice_style}

### DIRECTOR'S NOTES
Speak naturally and clearly in ${clip.language}.
Keep the delivery close to ${clip.target_seconds} seconds.
Do not add, remove, translate, summarize, or paraphrase the transcript.
Do not say section labels or instructions.

### TRANSCRIPT
${clip.script}`;

  const response = await geminiInteraction(env, {
    model: ttsModel(env),
    input: ttsPrompt,
    response_format: {
      type: "audio",
    },
    generation_config: {
      speech_config: [
        {
          voice: clip.voice_name,
          language: clip.language_code,
        },
      ],
    },
  });

  const audio = extractAudio(response);
  if (!audio?.data) throw new Error("Gemini returned no audio data.");

  const rawBytes = base64ToBytes(audio.data);

  // Gemini TTS examples currently return PCM that should be wrapped as a WAV file.
  // If a future response already contains a RIFF/WAV container, do not wrap it twice.
  if (looksLikeWav(rawBytes)) {
    return { bytes: rawBytes };
  }

  const sampleRate = Number(audio.sample_rate || 24000);
  const channels = Number(audio.channels || 1);
  return { bytes: pcm16ToWav(rawBytes, sampleRate, channels) };
}

async function geminiInteraction(env, body) {
  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || text || `Gemini HTTP ${response.status}`;
    throw new Error(message);
  }

  if (!data) throw new Error("Gemini returned an unreadable response.");
  return data;
}

function extractText(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      if (content[j]?.type === "text" && typeof content[j].text === "string") {
        return content[j].text;
      }
    }
  }
  return "";
}

function extractAudio(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      if (content[j]?.type === "audio" && typeof content[j].data === "string") {
        return content[j];
      }
    }
  }
  return null;
}

function base64ToBytes(base64) {
  // Use the modern fast path when available in the Workers runtime.
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(base64);
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function looksLikeWav(bytes) {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function pcm16ToWav(pcmBytes, sampleRate = 24000, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  out.set(pcmBytes, 44);

  return out;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

async function sendHelp(env, chatId) {
  await sendMessage(
    env,
    chatId,
    [
      "SKS Audio Assistant",
      "",
      "Send a normal message describing the audio you want. You can specify English, Hindi, Odia/Oriya, duration, number of clips, tone, voice style, or provide an exact script.",
      "",
      "Flow: request → draft → revise if needed → Generate Audio → WAV file(s).",
      "",
      "Commands:",
      "/new — start a fresh request",
      "/status — show the current draft",
      "/generate — generate the approved draft",
      "/cancel — cancel the current draft",
      "/usage — show session generation estimate",
      "/models — show configured Gemini models",
      "/voices — show common voice choices",
      "/whoami — show your Telegram user ID",
      "/help — show this message",
      "",
      "TTS is called only after you explicitly generate the audio.",
    ].join("\n"),
  );
}

async function sendMessage(env, chatId, text, replyMarkup = undefined) {
  return telegramJson(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function sendLongMessage(env, chatId, text, replyMarkup = undefined) {
  const chunks = splitText(text, 3900);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    await sendMessage(env, chatId, chunks[i], isLast ? replyMarkup : undefined);
  }
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.6) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.6) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendDocument(env, chatId, bytes, filename, caption, mimeType) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.append("document", new Blob([bytes], { type: mimeType }), filename);

  const response = await fetch(telegramUrl(env, "sendDocument"), {
    method: "POST",
    body: form,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram sendDocument failed with HTTP ${response.status}`);
  }
  return data.result;
}

async function answerCallbackQuery(env, callbackQueryId, text = undefined) {
  try {
    await telegramJson(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch (error) {
    console.error("answerCallbackQuery failed:", error?.message || error);
  }
}

async function telegramJson(env, method, payload) {
  const response = await fetch(telegramUrl(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return data.result;
}

function telegramUrl(env, method) {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function loadSession(env, userId) {
  const raw = await env.SESSIONS.get(sessionKey(userId));
  if (!raw) return newSession();
  try {
    const parsed = JSON.parse(raw);
    return {
      ...newSession(),
      ...parsed,
      usage: {
        ...newSession().usage,
        ...(parsed.usage || {}),
      },
    };
  } catch {
    return newSession();
  }
}

async function saveSession(env, userId, session) {
  session.updatedAt = new Date().toISOString();
  await env.SESSIONS.put(sessionKey(userId), JSON.stringify(session), {
    expirationTtl: sessionTtl(env),
  });
}

function newSession() {
  return {
    draft: null,
    generating: false,
    awaitingRevision: false,
    lastGeneratedAt: null,
    usage: {
      ttsSeconds: 0,
      filesGenerated: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

function sessionKey(userId) {
  return `session:${userId}`;
}

function isAuthorized(userId, env) {
  const allowed = String(env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(String(userId));
}

function normalizeCommand(text) {
  const first = String(text || "").trim().split(/\s+/)[0];
  if (!first.startsWith("/")) return "";
  return first.split("@")[0].toLowerCase();
}

function textModel(env) {
  return env.TEXT_MODEL || DEFAULT_TEXT_MODEL;
}

function ttsModel(env) {
  return env.TTS_MODEL || DEFAULT_TTS_MODEL;
}

function maxAudioFiles(env) {
  const value = Number.parseInt(env.MAX_AUDIO_FILES || "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 6) : DEFAULT_MAX_AUDIO_FILES;
}

function maxClipSeconds(env) {
  const value = Number.parseInt(env.MAX_CLIP_SECONDS || "", 10);
  return Number.isFinite(value) && value >= 3 ? Math.min(value, 40) : DEFAULT_MAX_CLIP_SECONDS;
}

function sessionTtl(env) {
  const value = Number.parseInt(env.SESSION_TTL_SECONDS || "", 10);
  return Number.isFinite(value) && value >= 60 ? value : DEFAULT_SESSION_TTL_SECONDS;
}

function validateEnvironment(env) {
  const missing = [];
  if (!env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.TELEGRAM_ALLOWED_USER_ID) missing.push("TELEGRAM_ALLOWED_USER_ID");
  if (!env.SESSIONS) missing.push("SESSIONS KV binding");
  if (missing.length) {
    throw new Error(`Missing Cloudflare configuration: ${missing.join(", ")}`);
  }
}

function safeError(error) {
  const message = String(error?.message || error || "Unknown error");
  // Do not accidentally echo huge provider responses or secrets into Telegram.
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

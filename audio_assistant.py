#!/usr/bin/env python3
"""Telegram + Gemini multilingual audio assistant.

Single-file application designed to run from GitHub Actions with Telegram long polling.
Supported output languages: English, Hindi, Odia (Oriya/Odiya aliases accepted by Gemini planner).

Flow:
1. User describes the audio they want.
2. Gemini Flash-Lite prepares one or more short scripts.
3. Bot shows the scripts and waits for confirmation/revision.
4. Only after confirmation does Gemini TTS generate audio.
5. Bot wraps Gemini PCM output as WAV and sends the WAV files back in Telegram.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import sys
import tempfile
import wave
import time
from pathlib import Path
from typing import Dict, List, Literal, Optional

import requests
from google import genai
from pydantic import BaseModel, Field, ValidationError


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()

# Accept either one ID or a comma-separated list. The singular name is kept
# because it is easiest to configure as a GitHub Secret for a personal bot.
_ALLOWED_RAW = os.getenv("TELEGRAM_ALLOWED_USER_ID", "").strip()
ALLOWED_USER_IDS = {
    int(value.strip())
    for value in _ALLOWED_RAW.split(",")
    if value.strip().lstrip("-").isdigit()
}

TEXT_MODEL = os.getenv("TEXT_MODEL", "gemini-3.5-flash-lite").strip()
TTS_MODEL = os.getenv("TTS_MODEL", "gemini-3.1-flash-tts-preview").strip()

MAX_CLIP_SECONDS = max(3, min(int(os.getenv("MAX_CLIP_SECONDS", "40")), 40))
MAX_AUDIO_FILES = max(1, min(int(os.getenv("MAX_AUDIO_FILES", "6")), 12))
TTS_AUDIO_OUTPUT_USD_PER_MILLION_TOKENS = float(
    os.getenv("TTS_AUDIO_OUTPUT_USD_PER_MILLION_TOKENS", "20")
)
TTS_AUDIO_TOKENS_PER_SECOND = float(os.getenv("TTS_AUDIO_TOKENS_PER_SECOND", "25"))
TELEGRAM_POLL_TIMEOUT = max(5, min(int(os.getenv("TELEGRAM_POLL_TIMEOUT", "45")), 50))
REQUEST_TIMEOUT = 90

LANGUAGE_CODES = {
    "English": "en",
    "Hindi": "hi",
    "Odia": "or",
}

VOICE_OPTIONS = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
LOGGER = logging.getLogger("audio-assistant")


# -----------------------------------------------------------------------------
# Structured Gemini response models
# -----------------------------------------------------------------------------

LanguageName = Literal["English", "Hindi", "Odia"]
VoiceName = Literal[
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]


class ClipDraft(BaseModel):
    clip_group: int = Field(
        ge=1,
        description="Logical clip number. Language variants of the same clip share this number.",
    )
    language: LanguageName
    title: str = Field(min_length=1, max_length=80)
    target_duration_seconds: int = Field(ge=3, le=40)
    script: str = Field(min_length=1, max_length=1600)
    delivery_style: str = Field(min_length=1, max_length=240)
    voice_name: VoiceName


class AudioDraft(BaseModel):
    summary: str = Field(min_length=1, max_length=300)
    requested_languages: List[LanguageName] = Field(min_length=1, max_length=3)
    clips: List[ClipDraft] = Field(min_length=1, max_length=12)
    notes: str = Field(default="", max_length=500)


# -----------------------------------------------------------------------------
# Telegram helpers
# -----------------------------------------------------------------------------

class TelegramAPI:
    def __init__(self, token: str) -> None:
        self.base_url = f"https://api.telegram.org/bot{token}"
        self.session = requests.Session()

    def _post(self, method: str, *, json_data=None, data=None, files=None, timeout=REQUEST_TIMEOUT):
        url = f"{self.base_url}/{method}"
        response = self.session.post(
            url,
            json=json_data,
            data=data,
            files=files,
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("ok"):
            raise RuntimeError(f"Telegram {method} failed: {payload}")
        return payload.get("result")

    def get_updates(self, offset: Optional[int]) -> list:
        payload = {
            "timeout": TELEGRAM_POLL_TIMEOUT,
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = offset
        return self._post(
            "getUpdates",
            json_data=payload,
            timeout=TELEGRAM_POLL_TIMEOUT + 15,
        )

    def delete_webhook(self) -> None:
        self._post("deleteWebhook", json_data={"drop_pending_updates": False})

    def send_message(self, chat_id: int, text: str, reply_markup: Optional[dict] = None):
        payload = {
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return self._post("sendMessage", json_data=payload)

    def send_long_message(self, chat_id: int, text: str, reply_markup: Optional[dict] = None):
        """Send text safely under Telegram's 4096-character message limit."""
        limit = 3900
        remaining = text
        chunks = []
        while remaining:
            if len(remaining) <= limit:
                chunks.append(remaining)
                break
            split_at = remaining.rfind("\n", 0, limit)
            if split_at < limit // 2:
                split_at = limit
            chunks.append(remaining[:split_at].rstrip())
            remaining = remaining[split_at:].lstrip("\n")

        result = None
        for index, chunk in enumerate(chunks):
            markup = reply_markup if index == len(chunks) - 1 else None
            result = self.send_message(chat_id, chunk, markup)
        return result

    def answer_callback(self, callback_query_id: str, text: Optional[str] = None):
        payload = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text[:200]
        return self._post("answerCallbackQuery", json_data=payload)

    def send_chat_action(self, chat_id: int, action: str = "typing"):
        try:
            self._post("sendChatAction", json_data={"chat_id": chat_id, "action": action})
        except Exception:
            LOGGER.debug("sendChatAction failed", exc_info=True)

    def send_document(self, chat_id: int, path: Path, *, caption: str):
        """Send a general file. WAV is sent as a document because Telegram sendAudio requires MP3/M4A."""
        with path.open("rb") as handle:
            files = {"document": (path.name, handle, "audio/wav")}
            data = {
                "chat_id": str(chat_id),
                "caption": caption[:1024],
            }
            return self._post("sendDocument", data=data, files=files, timeout=180)


# -----------------------------------------------------------------------------
# Gemini helpers
# -----------------------------------------------------------------------------

PLANNER_SYSTEM_INSTRUCTION = f"""
You are the planning and script-writing layer for a Telegram text-to-speech assistant.
Your output must follow the provided JSON schema exactly.

Supported final audio languages are ONLY English, Hindi, and Odia.
Treat "Oriya" and "Odiya" as aliases for "Odia".

Rules:
- Generate only the language version(s) explicitly requested by the user. Do not create all three unless asked.
- If no language is stated, use English unless the user's clear intent indicates Hindi or Odia.
- If the user asks for multiple languages, create a corresponding language variant for every requested logical clip.
- Default to one logical clip if the user does not specify a clip count.
- Keep every audio file between 3 and {MAX_CLIP_SECONDS} seconds.
- If the user specifies a duration, obey it as closely as practical and keep the spoken script naturally short enough for that duration.
- Prefer concise speech rather than fast speech. Do not stuff too many words into a short clip.
- If the user gives an exact script and says not to rewrite it, preserve it exactly when the target language is the same. If translation is requested, translate naturally while preserving meaning.
- Hindi output must use natural Hindi (normally Devanagari unless the user explicitly asks for Roman Hindi).
- Odia output must use natural Odia script unless the user explicitly asks for Romanized Odia.
- English output must be natural spoken English.
- For translations, adapt naturally rather than doing awkward word-for-word translation.
- Keep product names, company names, abbreviations, numbers, URLs, and brand names correct.
- Do not add claims or facts that the user did not provide.
- Choose one valid Gemini TTS voice_name from the allowed enum based primarily on the requested delivery style.
- Google's public voice descriptions are style-oriented, not formal gender labels. Preserve any requested male/female preference inside delivery_style so the TTS prompt can attempt to follow it.
- delivery_style should be a concise director instruction: tone, pace, emphasis, pauses, and any requested voice preference.
- clip_group identifies the logical clip number. For example, if clip 1 is requested in English and Hindi, both variants use clip_group=1.
- Use clip_group values starting from 1.
- Never exceed {MAX_AUDIO_FILES} total generated language/clip variants.
- notes should be short and only mention something genuinely useful (for example, a duration had to be clamped to the maximum).
""".strip()


def planner_prompt(user_request: str, existing: Optional[AudioDraft] = None) -> str:
    if existing is None:
        return f"""
Create an audio draft from this Telegram user request:

--- USER REQUEST ---
{user_request}
--- END REQUEST ---

Return the complete proposed draft. This is only a text-planning step; do not generate audio.
""".strip()

    return f"""
The user already has the following proposed draft:

--- CURRENT DRAFT JSON ---
{existing.model_dump_json(indent=2)}
--- END CURRENT DRAFT ---

They sent this revision instruction:

--- REVISION ---
{user_request}
--- END REVISION ---

Return the complete revised draft, preserving everything the user did not ask to change.
This is only a text-planning step; do not generate audio.
""".strip()


class GeminiAudioService:
    def __init__(self, api_key: str) -> None:
        self.client = genai.Client(api_key=api_key)

    def create_or_revise_draft(self, user_request: str, existing: Optional[AudioDraft]) -> AudioDraft:
        interaction = self.client.interactions.create(
            model=TEXT_MODEL,
            input=planner_prompt(user_request, existing),
            system_instruction=PLANNER_SYSTEM_INSTRUCTION,
            response_format={
                "type": "text",
                "mime_type": "application/json",
                "schema": AudioDraft.model_json_schema(),
            },
            generation_config={
                "thinking_level": "minimal",
                "max_output_tokens": 5000,
            },
        )
        draft = AudioDraft.model_validate_json(interaction.output_text)
        return normalize_draft(draft)

    def generate_wav(self, clip: ClipDraft, output_path: Path) -> None:
        """Generate Gemini TTS and wrap its raw 24 kHz mono 16-bit PCM as WAV."""
        language_code = LANGUAGE_CODES[clip.language]
        tts_prompt = (
            f"Generate exactly one finished narration clip.\n"
            f"Language: {clip.language} ({language_code}).\n"
            f"Target duration: about {clip.target_duration_seconds} seconds.\n"
            f"Director notes: {clip.delivery_style}\n"
            f"Do not speak these instructions. Speak only the script below.\n\n"
            f"SCRIPT:\n{clip.script}"
        )

        # Gemini 3.1 TTS currently documents response_format={"type": "audio"}.
        # The returned payload is raw PCM: 24 kHz, mono, signed 16-bit little-endian.
        interaction = self.client.interactions.create(
            model=TTS_MODEL,
            input=tts_prompt,
            response_format={"type": "audio"},
            generation_config={
                "speech_config": [
                    {
                        "voice": clip.voice_name,
                        "language": language_code,
                    }
                ]
            },
        )

        audio = interaction.output_audio
        if audio is None or not getattr(audio, "data", None):
            raise RuntimeError("Gemini returned no audio data.")

        raw = audio.data
        if isinstance(raw, str):
            pcm = base64.b64decode(raw)
        elif isinstance(raw, (bytes, bytearray)):
            # Current SDK docs expose base64 text, but tolerate raw bytes safely.
            try:
                pcm = base64.b64decode(raw, validate=True)
            except Exception:
                pcm = bytes(raw)
        else:
            pcm = base64.b64decode(str(raw))

        if not pcm:
            raise RuntimeError("Gemini returned an empty audio payload.")

        with wave.open(str(output_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(24000)
            wav_file.writeframes(pcm)


# -----------------------------------------------------------------------------
# Draft display, cost estimate, and state
# -----------------------------------------------------------------------------


def normalize_draft(draft: AudioDraft) -> AudioDraft:
    """Apply deterministic cost/safety limits even if a model response is unusual."""
    if len(draft.clips) > MAX_AUDIO_FILES:
        draft.clips = draft.clips[:MAX_AUDIO_FILES]
        suffix = f"Limited to {MAX_AUDIO_FILES} audio files for cost control."
        draft.notes = f"{draft.notes} {suffix}".strip()

    for clip in draft.clips:
        clip.target_duration_seconds = min(clip.target_duration_seconds, MAX_CLIP_SECONDS)
        if clip.voice_name not in VOICE_OPTIONS:
            clip.voice_name = "Kore"  # Pydantic should normally make this unreachable.

    # Ensure requested_languages accurately reflects the actual clip set.
    ordered = []
    for name in ("English", "Hindi", "Odia"):
        if any(c.language == name for c in draft.clips):
            ordered.append(name)
    draft.requested_languages = ordered or draft.requested_languages
    return draft


def estimate_tts_cost_usd(draft: AudioDraft) -> float:
    total_seconds = sum(c.target_duration_seconds for c in draft.clips)
    estimated_tokens = total_seconds * TTS_AUDIO_TOKENS_PER_SECOND
    return (estimated_tokens / 1_000_000.0) * TTS_AUDIO_OUTPUT_USD_PER_MILLION_TOKENS


def format_draft(draft: AudioDraft) -> str:
    lines = [
        "Draft ready",
        f"Languages: {', '.join(draft.requested_languages)}",
        f"Audio files: {len(draft.clips)}",
        "",
    ]

    for idx, clip in enumerate(draft.clips, start=1):
        lines.extend(
            [
                f"[{idx}] Clip {clip.clip_group} | {clip.language} | ~{clip.target_duration_seconds}s",
                f"Voice: {clip.voice_name}",
                f"Style: {clip.delivery_style}",
                f"Script: {clip.script}",
                "",
            ]
        )

    estimated = estimate_tts_cost_usd(draft)
    total_seconds = sum(c.target_duration_seconds for c in draft.clips)
    lines.append(f"Planned audio: ~{total_seconds}s total")
    lines.append(f"Approx. paid-tier TTS output cost: ${estimated:.4f}")
    lines.append("No TTS charge is triggered until you confirm generation.")
    if draft.notes:
        lines.append(f"Note: {draft.notes}")
    return "\n".join(lines)


def confirmation_keyboard() -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "Generate Audio", "callback_data": "generate"},
                {"text": "Revise", "callback_data": "revise"},
            ],
            [{"text": "Cancel", "callback_data": "cancel"}],
        ]
    }


class SessionState(BaseModel):
    draft: AudioDraft
    original_request: str
    updated_at: float = Field(default_factory=time.time)


SESSIONS: Dict[int, SessionState] = {}
USAGE_SECONDS: Dict[int, int] = {}
USAGE_GENERATIONS: Dict[int, int] = {}


# -----------------------------------------------------------------------------
# Bot logic
# -----------------------------------------------------------------------------

HELP_TEXT = f"""Gemini Audio Assistant

Send a normal message describing the audio you need. I will draft the script first, then wait for your approval before generating any TTS audio.

Supported final languages:
- English
- Hindi
- Odia (Oriya/Odiya also understood)

Examples:
• Create one 12-second professional English audio about our CRM add-in.
• Make two Hindi clips: first 10s for the problem, second 15s for the solution.
• Use this English script but generate the final narration in Odia: ...
• Generate the same clip in English, Hindi and Odia.

Commands:
/start - show the introduction
/new - clear the current draft and start a new request
/status - show the current draft
/generate - generate the approved draft
/cancel - cancel the current draft
/usage - show estimated TTS usage for this running session
/models - show configured Gemini models
/voices - show suggested voice styles
/whoami - show your Telegram numeric user ID
/help - show this help

Limits for this project: max {MAX_CLIP_SECONDS}s per audio file and max {MAX_AUDIO_FILES} generated files per confirmed request.
""".strip()

VOICE_HELP = """Suggested Gemini voice styles:
Kore — Firm
Charon — Informative
Iapetus — Clear
Schedar — Even
Gacrux — Mature
Achird — Friendly
Sulafat — Warm
Puck — Upbeat
Achernar — Soft
Sadachbia — Lively

You can say, for example: “Use a warm professional voice” or “Use voice Charon.”
The bot can also choose automatically from Gemini's supported voice list."""


def is_authorized(user_id: int) -> bool:
    return bool(ALLOWED_USER_IDS) and user_id in ALLOWED_USER_IDS


def unauthorized_message(user_id: int) -> str:
    if not ALLOWED_USER_IDS:
        return (
            "Audio generation is locked because TELEGRAM_ALLOWED_USER_ID is not configured.\n"
            f"Your Telegram user ID is: {user_id}\n"
            "Add this value as the GitHub Actions secret TELEGRAM_ALLOWED_USER_ID, then restart the workflow."
        )
    return (
        "This bot is private and this Telegram account is not authorized.\n"
        f"Your Telegram user ID is: {user_id}"
    )


def handle_command(tg: TelegramAPI, gemini: GeminiAudioService, chat_id: int, user_id: int, text: str) -> None:
    command = text.split()[0].split("@")[0].lower()

    if command == "/whoami":
        tg.send_message(chat_id, f"Your Telegram user ID is: {user_id}")
        return

    if not is_authorized(user_id):
        tg.send_message(chat_id, unauthorized_message(user_id))
        return

    if command in ("/start", "/help"):
        tg.send_message(chat_id, HELP_TEXT)
    elif command == "/new":
        SESSIONS.pop(user_id, None)
        tg.send_message(chat_id, "Current draft cleared. Send the next audio request.")
    elif command == "/cancel":
        SESSIONS.pop(user_id, None)
        tg.send_message(chat_id, "Current draft cancelled.")
    elif command == "/status":
        session = SESSIONS.get(user_id)
        if not session:
            tg.send_message(chat_id, "No draft is active. Send an audio request to create one.")
        else:
            tg.send_long_message(chat_id, format_draft(session.draft), confirmation_keyboard())
    elif command == "/models":
        tg.send_message(
            chat_id,
            f"Text/script model: {TEXT_MODEL}\nTTS model: {TTS_MODEL}\n"
            "Both can be overridden with GitHub Actions environment variables without changing the Python file.",
        )
    elif command == "/voices":
        tg.send_message(chat_id, VOICE_HELP)
    elif command == "/usage":
        seconds = USAGE_SECONDS.get(user_id, 0)
        generations = USAGE_GENERATIONS.get(user_id, 0)
        estimated_tokens = seconds * TTS_AUDIO_TOKENS_PER_SECOND
        estimated_cost = (
            estimated_tokens / 1_000_000.0
        ) * TTS_AUDIO_OUTPUT_USD_PER_MILLION_TOKENS
        tg.send_message(
            chat_id,
            f"This workflow session generated {generations} audio file(s), ~{seconds}s planned audio.\n"
            f"Approx. paid-tier TTS output cost: ${estimated_cost:.4f}\n"
            "This is an estimate based on planned duration/list pricing; actual billing can differ and free-tier usage may be $0.",
        )
    elif command == "/generate":
        generate_current_draft(tg, gemini, chat_id, user_id)
    else:
        tg.send_message(chat_id, "Unknown command. Use /help.")


def handle_text(tg: TelegramAPI, gemini: GeminiAudioService, chat_id: int, user_id: int, text: str) -> None:
    if not is_authorized(user_id):
        tg.send_message(chat_id, unauthorized_message(user_id))
        return

    existing_session = SESSIONS.get(user_id)
    tg.send_chat_action(chat_id, "typing")

    try:
        draft = gemini.create_or_revise_draft(
            user_request=text,
            existing=existing_session.draft if existing_session else None,
        )
    except ValidationError as exc:
        LOGGER.exception("Gemini structured output validation failed")
        tg.send_message(chat_id, f"I could not validate the generated draft. Please try again.\n{exc.errors()[0].get('msg', '')}")
        return
    except Exception as exc:
        LOGGER.exception("Failed to create/revise draft")
        tg.send_message(chat_id, f"Could not prepare the script draft: {friendly_error(exc)}")
        return

    SESSIONS[user_id] = SessionState(
        draft=draft,
        original_request=existing_session.original_request if existing_session else text,
    )
    tg.send_long_message(chat_id, format_draft(draft), confirmation_keyboard())


def handle_callback(tg: TelegramAPI, gemini: GeminiAudioService, callback: dict) -> None:
    callback_id = callback.get("id", "")
    data = callback.get("data", "")
    user = callback.get("from", {})
    user_id = int(user.get("id", 0))
    message = callback.get("message", {})
    chat_id = int((message.get("chat") or {}).get("id", user_id))

    try:
        tg.answer_callback(callback_id)
    except Exception:
        LOGGER.debug("Failed answering callback", exc_info=True)

    if not is_authorized(user_id):
        tg.send_message(chat_id, unauthorized_message(user_id))
        return

    if data == "cancel":
        SESSIONS.pop(user_id, None)
        tg.send_message(chat_id, "Current draft cancelled.")
    elif data == "revise":
        if user_id not in SESSIONS:
            tg.send_message(chat_id, "No active draft. Send a new request first.")
        else:
            tg.send_message(
                chat_id,
                "Send your changes as a normal message, for example: “Make clip 2 shorter and use Odia instead of Hindi.”",
            )
    elif data == "generate":
        generate_current_draft(tg, gemini, chat_id, user_id)


def generate_current_draft(tg: TelegramAPI, gemini: GeminiAudioService, chat_id: int, user_id: int) -> None:
    session = SESSIONS.get(user_id)
    if not session:
        tg.send_message(chat_id, "No active draft. Send an audio request first.")
        return

    draft = session.draft
    estimated_cost = estimate_tts_cost_usd(draft)
    tg.send_message(
        chat_id,
        f"Generating {len(draft.clips)} audio file(s) now. Approx. paid-tier TTS output cost: ${estimated_cost:.4f}.",
    )

    successful = 0
    failed = 0
    with tempfile.TemporaryDirectory(prefix="gemini_tts_") as temp_dir:
        temp_path = Path(temp_dir)

        for index, clip in enumerate(draft.clips, start=1):
            tg.send_chat_action(chat_id, "upload_voice")
            lang_code = LANGUAGE_CODES[clip.language]
            filename = f"clip_{clip.clip_group:02d}_{lang_code}_{index:02d}.wav"
            output_path = temp_path / filename

            try:
                gemini.generate_wav(clip, output_path)
                tg.send_document(
                    chat_id,
                    output_path,
                    caption=(
                        f"{clip.language} | ~{clip.target_duration_seconds}s | Voice: {clip.voice_name}\n"
                        f"{clip.title}"
                    ),
                )
                successful += 1
                USAGE_SECONDS[user_id] = USAGE_SECONDS.get(user_id, 0) + clip.target_duration_seconds
                USAGE_GENERATIONS[user_id] = USAGE_GENERATIONS.get(user_id, 0) + 1
            except Exception as exc:
                failed += 1
                LOGGER.exception("TTS generation failed for clip %s", index)
                tg.send_message(
                    chat_id,
                    f"Clip {index} ({clip.language}) failed: {friendly_error(exc)}\n"
                    "It was not automatically retried, to avoid accidental extra TTS cost.",
                )

    if successful:
        SESSIONS.pop(user_id, None)
        tg.send_message(
            chat_id,
            f"Finished. Sent {successful} audio file(s)" + (f"; {failed} failed." if failed else ".") +
            " Send a new request whenever you need the next audio.",
        )
    elif failed:
        tg.send_message(
            chat_id,
            "No audio files were generated successfully. The draft is still active, so you can revise it or try /generate again.",
        )


def friendly_error(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    lowered = message.lower()
    if "429" in message or "quota" in lowered or "resource_exhausted" in lowered:
        return "Gemini quota/rate limit was reached. Check the Gemini API quota/billing and try again later."
    if "401" in message or "403" in message or "api key" in lowered or "permission" in lowered:
        return "Gemini authentication/permission failed. Check GEMINI_API_KEY and model access."
    if "404" in message or "not found" in lowered:
        return f"A configured model or endpoint was not found. TEXT_MODEL={TEXT_MODEL}, TTS_MODEL={TTS_MODEL}."
    # Avoid dumping huge provider responses into Telegram.
    return message[:500]


def validate_environment() -> None:
    missing = []
    if not GEMINI_API_KEY:
        missing.append("GEMINI_API_KEY")
    if not TELEGRAM_BOT_TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")
    if missing:
        raise RuntimeError("Missing required environment variable(s): " + ", ".join(missing))


def main() -> int:
    validate_environment()
    tg = TelegramAPI(TELEGRAM_BOT_TOKEN)
    gemini = GeminiAudioService(GEMINI_API_KEY)

    LOGGER.info("Starting Gemini Telegram Audio Assistant")
    LOGGER.info("Text model: %s", TEXT_MODEL)
    LOGGER.info("TTS model: %s", TTS_MODEL)
    if ALLOWED_USER_IDS:
        LOGGER.info("Authorized Telegram user count: %s", len(ALLOWED_USER_IDS))
    else:
        LOGGER.warning("TELEGRAM_ALLOWED_USER_ID is not set. Only /whoami setup assistance will be available.")

    # Long polling and webhooks are mutually exclusive in Telegram.
    try:
        tg.delete_webhook()
    except Exception:
        LOGGER.warning("Could not clear Telegram webhook; polling may fail if a webhook is configured.", exc_info=True)

    offset: Optional[int] = None
    consecutive_errors = 0

    while True:
        try:
            updates = tg.get_updates(offset)
            consecutive_errors = 0
            for update in updates:
                update_id = int(update["update_id"])
                offset = update_id + 1

                if "callback_query" in update:
                    handle_callback(tg, gemini, update["callback_query"])
                    continue

                message = update.get("message") or {}
                text = (message.get("text") or "").strip()
                if not text:
                    continue

                chat = message.get("chat") or {}
                sender = message.get("from") or {}
                chat_id = int(chat.get("id", 0))
                user_id = int(sender.get("id", 0))
                if not chat_id or not user_id:
                    continue

                if text.startswith("/"):
                    handle_command(tg, gemini, chat_id, user_id, text)
                else:
                    handle_text(tg, gemini, chat_id, user_id, text)

        except KeyboardInterrupt:
            LOGGER.info("Stopped by user.")
            return 0
        except requests.RequestException:
            consecutive_errors += 1
            wait = min(30, 2 ** min(consecutive_errors, 5))
            LOGGER.exception("Telegram network error. Retrying in %ss", wait)
            time.sleep(wait)
        except Exception:
            consecutive_errors += 1
            wait = min(30, 2 ** min(consecutive_errors, 5))
            LOGGER.exception("Unexpected bot-loop error. Retrying in %ss", wait)
            time.sleep(wait)


if __name__ == "__main__":
    sys.exit(main())

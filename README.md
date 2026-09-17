# Gemini Telegram Audio Assistant

A small, deployment-free audio-generation assistant designed to run on demand in **GitHub Actions** and interact through a **Telegram bot**.

You describe the audio you want. The bot uses Gemini to prepare the script first, shows it to you, lets you revise it, and calls TTS **only after you confirm**. This avoids wasting TTS calls while you are still editing.

## What it supports

- English audio
- Hindi audio
- Odia audio (`Oriya` / `Odiya` are understood as Odia)
- One or multiple short audio clips
- Multiple language versions when explicitly requested
- Natural-language script creation and revision
- User-provided exact scripts
- Telegram inline **Generate Audio / Revise / Cancel** controls
- MP3 delivery directly in Telegram
- Cost estimate before generation
- No Flask, Django, webhook server, database, VPS, or public deployment
- Authorized Telegram user restriction
- No automatic TTS retry after a failed generation, to reduce accidental spend

## Default Gemini models

```text
TEXT_MODEL=gemini-3.5-flash-lite
TTS_MODEL=gemini-3.1-flash-tts-preview
```

The model names are environment-driven, so they can be changed later without changing `audio_assistant.py`.

The text model is used only for planning, translation and script revision. TTS is called only after you approve the draft.

## Project structure

```text
gemini-telegram-audio-assistant/
├── audio_assistant.py
├── requirements.txt
├── README.md
├── .env.example
├── .gitignore
└── .github/
    └── workflows/
        └── audio-assistant.yml
```

## 1. Create a Telegram bot

1. Open Telegram and message **@BotFather**.
2. Run `/newbot`.
3. Choose the bot name and username.
4. BotFather will give you a token such as:

   ```text
   123456789:AAExampleToken...
   ```

5. Keep it private. It will become the GitHub secret `TELEGRAM_BOT_TOKEN`.

## 2. Create a Gemini API key

Create a Gemini Developer API key in Google AI Studio. Keep the key private. It will become `GEMINI_API_KEY`.

## 3. Find your Telegram user ID

The bot is intentionally private. You need your numeric Telegram user ID.

You can obtain it using any normal Telegram user-ID method. The application also supports `/whoami` even for an unauthorized account, but to use that setup route you would first run the workflow without the allowed-user secret, send `/whoami`, then add the returned ID and restart the workflow.

## 4. Put the project in GitHub

Create a **private GitHub repository** and upload the project files.

Do not put API keys inside the Python file, workflow YAML, `.env.example`, or repository settings visible in code.

## 5. Add GitHub Actions secrets

In your repository:

**Settings → Secrets and variables → Actions → New repository secret**

Create these three secrets:

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini API key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID |

The allowed-user secret can also contain comma-separated IDs if you intentionally want several people to use the bot.

## 6. Start the bot

Go to:

**GitHub repository → Actions → Telegram Gemini Audio Assistant → Run workflow**

Choose a session duration:

- 15 minutes
- 30 minutes
- 55 minutes
- 120 minutes
- 300 minutes

Then click **Run workflow**.

While the workflow is running, the Telegram bot is online. When the selected session ends, the workflow exits automatically.

This approach is intentionally on-demand because GitHub Actions is a CI runner rather than an always-on application host.

## Example Telegram requests

### One English clip

```text
Create a 12-second English narration for our CRM Outlook add-in.
Professional, clear and confident.
```

### Two Hindi clips

```text
Create two Hindi audio clips.
Clip 1: about 10 seconds explaining the sales problem.
Clip 2: about 15 seconds explaining that our CRM works inside Outlook.
Professional style.
```

### Odia / Oriya

```text
Create one 15-second audio in Oriya about our CRM add-in.
Keep it natural and professional.
```

The planner normalizes Oriya/Odiya to Odia.

### All three language versions

```text
Create one 12-second product-introduction clip and give me English, Hindi and Odia versions.
```

The draft will contain three proposed scripts. No audio is created until you confirm.

### Supply your own script

```text
Use this exact English script. Do not rewrite it. Make a 10-second audio:
Our CRM assistant keeps client, bid and lead information directly inside Outlook.
```

### Revise the draft

After the bot shows a draft, send a normal message such as:

```text
Make clip 2 shorter and more conversational. Keep clip 1 unchanged.
```

or:

```text
Change the final output from Hindi to Odia.
```

The text draft is regenerated; TTS is still not called.

## Telegram commands

```text
/start      introduction
/new        clear the draft and start over
/status     show current draft
/generate   generate the current approved draft
/cancel     cancel current draft
/usage      estimated TTS usage in this running workflow
/models     show configured Gemini model IDs
/voices     voice-style examples
/whoami     show your Telegram numeric user ID
/help       help
```

## Cost-control behavior

The project is deliberately conservative with paid audio calls:

1. Script creation/revision happens before TTS.
2. TTS runs only when you press **Generate Audio** or run `/generate`.
3. Only requested language versions are generated.
4. Default maximum duration is 40 seconds per audio file.
5. Default maximum is six files per confirmed request. This is enough for two clips × English/Hindi/Odia.
6. A failed TTS clip is **not automatically retried**.
7. Generated MP3 files are kept only in a temporary folder on the GitHub runner and deleted after the request finishes.
8. `/usage` shows a session estimate based on planned seconds.

The source uses the current Gemini TTS pricing assumption of **25 output audio tokens per second** and **$20 per 1M output audio tokens** for its estimate. You can override these values if pricing changes:

```text
TTS_AUDIO_TOKENS_PER_SECOND=25
TTS_AUDIO_OUTPUT_USD_PER_MILLION_TOKENS=20
```

The estimate is informational. Actual billing can differ, and eligible free-tier usage can cost $0.

## Voice handling

Gemini TTS provides predefined voice names with style descriptions. The bot selects a valid voice according to the requested tone and keeps your voice/delivery preference in the TTS director instructions.

You can request a style naturally:

```text
Warm and professional
Calm and clear
Energetic product-demo narration
Slightly slow with a pause after the first sentence
```

You can also explicitly say a supported voice name such as `Charon`, `Kore`, `Iapetus`, `Achird`, or `Sulafat`.

Google's public voice list describes voices primarily by style; it does not formally label the voice list by gender. If you request a male/female preference, the bot preserves that direction in the TTS instructions, but exact perceived voice characteristics should be tested with your preferred Gemini voice.

## GitHub Actions behavior

The bot uses Telegram **long polling**, so no public URL or webhook is needed.

The workflow runs:

```text
checkout
→ setup Python 3.12
→ install requirements
→ run audio_assistant.py for the selected duration
```

No port is opened.

## Local test (optional)

```bash
python -m venv .venv
source .venv/bin/activate      # Linux/macOS
# .venv\Scripts\activate       # Windows PowerShell
pip install -r requirements.txt
```

Set environment variables and run:

```bash
export GEMINI_API_KEY="..."
export TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_ALLOWED_USER_ID="123456789"
python audio_assistant.py
```

On Windows PowerShell:

```powershell
$env:GEMINI_API_KEY="..."
$env:TELEGRAM_BOT_TOKEN="..."
$env:TELEGRAM_ALLOWED_USER_ID="123456789"
python audio_assistant.py
```

## Important operational notes

- Conversation state is kept in memory. If the GitHub Action stops, an unfinished draft is lost. Finished files already sent to Telegram remain in Telegram.
- This project is intended for short, on-demand audio generation rather than 24/7 bot hosting.
- Do not commit a real `.env` file.
- Keep the repository private unless you specifically want the source public.
- If Google later retires a model ID, update the `TEXT_MODEL` or `TTS_MODEL` workflow environment value.

## Troubleshooting

### `401`, `403`, or API-key error
Check `GEMINI_API_KEY`, API access, and billing/quota settings.

### `404` model not found
A model may have been retired or your API project may not have access. Update `TEXT_MODEL` / `TTS_MODEL` in the workflow after checking Google's current Gemini model list.

### `429` / quota exhausted
Check Gemini API quota and billing. The bot deliberately does not automatically retry TTS generation.

### Bot does not answer
Open the GitHub Actions run and verify the workflow is still running. Check `TELEGRAM_BOT_TOKEN`. If a Telegram webhook was previously configured, the app attempts to clear it before starting long polling.

### Unauthorized message
Verify `TELEGRAM_ALLOWED_USER_ID`. Send `/whoami` to see the numeric ID of the Telegram account currently messaging the bot.

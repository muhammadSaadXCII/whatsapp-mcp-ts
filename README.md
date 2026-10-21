# WhatsApp MCP Server (TypeScript/Baileys)

This is a Model Context Protocol (MCP) server for WhatsApp, built with TypeScript and using the `@whiskeysockets/baileys` library.

It connects your personal WhatsApp account to an AI agent (such as Anthropic Claude Desktop, Cursor, or your own LangChain.js agent) so that the agent can:

* Search and read your WhatsApp messages (individual chats, groups and channels).
* Search your contacts.
* List your recent chats.
* Filter message history by chat, chat name, sender, text, date range or media type.
* Download media attachments (images, videos, audio, documents, stickers) from stored messages.
* Send text messages.
* Send files and audio files, from a dedicated outbox folder only.
* Send text-to-speech voice notes in English or Urdu.

It connects directly to your **personal WhatsApp account** using the WhatsApp Web multi-device API. Your messages, contacts and authentication details are stored **locally** in a SQLite database (`./data/`) and an authentication cache (`./auth_info/`). Data is only sent to the connected AI agent, and on to its model provider, when the agent uses one of the MCP tools. Voice notes are the one exception: the text to be spoken is sent to Microsoft's online text-to-speech service (see [Voice messages](#voice-messages)).

## Example

**User:**
Download the most recent document in the "Project Team" chat.

---

**Assistant:**
*Using tool: `whatsapp.list_messages`*
```json
{
  "chat_name": "Project Team",
  "media_type": "document",
  "limit": 1
}
```

---

**Tool Result:** *(abridged)*
```json
[
  {
    "id": "ABC123...",
    "chat_jid": "1203...@g.us",
    "chat_name": "Project Team",
    "sender_display": "Alex",
    "content": "[Document] report.pdf",
    "media_type": "document"
  }
]
```

---

**Assistant:**
*Using tool: `whatsapp.download_media`*
```json
{
  "message_id": "ABC123...",
  "chat_jid": "1203...@g.us"
}
```

---

**Tool Result:**
```json
{
  "success": true,
  "file_path": "<repo>/downloads/document_ABC123..._report.pdf",
  "media_type": "document",
  "size_bytes": 120345
}
```

## Key Features (MCP Tools)

| Tool | What it does |
|---|---|
| `search_contacts` | Search contacts by name, push name or phone number. Matches on words and ranks by how many words match. A person who has both a phone-number ID and an `@lid` ID is returned once, as the phone-number ID. |
| `list_messages` | Retrieve messages. Filters: `chat_jid`, `chat_name`, `sender`, `query`, `media_type`, `after`, `before`. Supports pagination (`limit` up to 100, `page`) and optional surrounding context. |
| `list_chats` | List chats sorted by activity or name, optionally filtered, with optional last-message details. Direct chats with no stored messages are hidden. Groups are always listed. |
| `get_chat` | Get details for one chat by JID. |
| `get_direct_chat_by_contact` | Find direct chats by contact name or phone number. Returns up to 5 ranked candidates. A phone-number chat and its `@lid` twin are merged into one result. |
| `get_contact_chats` | List chats involving a contact: their direct chat, plus groups where they have sent messages. |
| `get_last_interaction` | Get the most recent message involving a contact (JID or phone number). |
| `get_message_context` | Retrieve messages sent immediately before and after a message ID. |
| `search_messages` | Search message text globally or within one chat. |
| `download_media` | Save the media of a stored message into `./downloads/`. Only works for messages whose `media_type` is not null. |
| `list_outbox` | List the files in `./outbox/` and whether each one can be sent. |
| `send_message` | Send a text message to an existing chat (user or group JID). |
| `send_file` | Send a file from `./outbox/` to an existing chat (see [Sending files](#sending-files)). |
| `send_audio_message` | Send an audio file from `./outbox/` as a voice note. Files that are not Ogg/Opus are converted with ffmpeg. |
| `send_voice_message` | Convert text to speech and send it as a voice note (see [Voice messages](#voice-messages)). |

## Installation

### Prerequisites

* **Node.js:** Version 23.10.0 or higher (the server runs TypeScript directly and uses the built-in `node:sqlite`). Check with `node -v`.
* **npm** (or yarn/pnpm): Usually comes with Node.js.
* **ffmpeg:** Voice notes need it. The `ffmpeg-static` package installs a binary with `npm install`. If that is not available on your platform, the server falls back to an `ffmpeg` on your PATH.
* **An MCP-compatible client:** Claude Desktop, Cursor, Cline, Roo Code, or your own client such as a LangChain.js agent.

### Steps

1.  **Clone this repository:**
    ```bash
    git clone https://github.com/<username>/whatsapp-mcp-ts.git
    cd whatsapp-mcp-ts
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Run the server for the first time:**
    ```bash
    node src/main.ts
    ```
    * The first time you run it, it generates a QR code link using `quickchart.io` and tries to open it in your default browser. (The QR payload is part of that link, so if you prefer not to send it to a third party, change this in `src/whatsapp/index.ts`.)
    * Scan the QR code with WhatsApp on your phone (Settings > Linked Devices > Link a Device).
    * Credentials are saved in `auth_info/` and messages are synced into `data/whatsapp.db`. Check `info/wa_logs.txt` for progress.
    * When syncing has settled, stop the server with Ctrl+C. Your AI client will start it from then on.

    Only one process may use `auth_info/` at a time. Do not leave this running while your client starts the server.

## Configuration for AI Client

You need to tell your AI client how to start this MCP server.

1.  **Prepare the configuration JSON:**
    Replace `{{PATH_TO_REPO}}` with the **absolute path** to this repository (on Windows, use forward slashes, for example `C:/Projects/whatsapp-mcp-ts`).

    ```json
    {
      "mcpServers": {
        "whatsapp": {
          "command": "node",
          "args": [
            "{{PATH_TO_REPO}}/src/main.ts"
          ],
          "timeout": 15,
          "disabled": false
        }
      }
    }
    ```

2.  **Save the configuration file:**
    * **Claude Desktop:** `claude_desktop_config.json` in
        * macOS: `~/Library/Application Support/Claude/`
        * Windows: `%APPDATA%\Claude\`
        * Linux: `~/.config/Claude/`
    * **Cursor:** `~/.cursor/mcp.json`

3.  **Restart your client.** It should detect the "whatsapp" server and its tools.

Note that desktop clients may call the sending tools (`send_message`, `send_file`, `send_audio_message`, `send_voice_message`) without asking you first. See [Security](#security) before connecting one.

## Usage

Once the server is running and connected to your client, ask it to search contacts, list chats, read or filter messages, download media, or send messages, files and voice notes. Each message returned by the tools includes its `id`, `chat_jid`, `chat_name`, `sender_display`, `content`, `timestamp` and `media_type`.

Tips:

* Ask for a chat by name and the agent can use `list_messages` with `chat_name` directly.
* Your own "Message yourself" chat is stored under your own IDs and is saved as the contact **Me**, so "send a message to Me" works by name.
* Phone-number lookups need the full number with country code. Chats that exist only under an `@lid` ID carry a phone number only when WhatsApp provided one, so find the others by name.

## Phone-number IDs and `@lid` IDs

WhatsApp identifies the same person in two ways: a phone-number ID (`923...@s.whatsapp.net`) and an anonymous ID (`...@lid`). Your history sync can create a chat for each, so one contact may appear twice. The server handles this as follows:

* **Searches** (`search_contacts`, `get_direct_chat_by_contact`) merge an `@lid` entry into its phone-number entry when the `@lid` row has a stored phone number. Of the two, the chat with the newer messages is returned.
* **Sending** converts a recipient given as an `@lid` ID into the phone-number ID when the number is known, and accepts a recipient if either ID has an existing chat.
* **Your own account** is saved as the contact "Me" under both of its IDs when you connect.
* The send tools tell the agent to prefer the `@s.whatsapp.net` ID.

Limit: linking only works when the `@lid` row has a phone number. Baileys 6.x does not always provide one. Those contacts stay separate, and sending to them uses the `@lid` ID itself.

## Downloading media

* `download_media` needs the message ID of a message whose `media_type` is not null (`image`, `video`, `audio`, `document` or `sticker`).
* Media is tracked for messages stored after this feature was added. Older messages return "No stored media data".
* Files are saved in `./downloads/` with sanitized names, up to 25 MB.
* **Channel (newsletter) posts cannot be downloaded this way.** They arrive without an encryption key.
* Media that has expired on WhatsApp's servers may fail, and your phone may need to be online to re-upload it.
* The server does not transcribe audio or describe images. It only saves the file.

## Sending files

`send_file` and `send_audio_message` are deliberately restrictive so that a manipulated agent cannot send arbitrary local files:

* Files must be placed in `./outbox/` by you first. The tools take **only a bare file name**, never a path. Folders, `..` and drive letters are rejected, and the resolved real path must stay inside the outbox (links pointing elsewhere are rejected).
* Allowed types for `send_file`: `jpg`, `jpeg`, `png`, `webp`, `gif`, `mp4`, `3gp`, `mp3`, `m4a`, `aac`, `ogg`, `wav`, `opus`, `amr`, `flac`, `webm`, `pdf`, `txt`, `csv`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `zip`, `js`, `ts`, `py`, `json`, `html`, `css`, `c`, `cpp`, `java`, `go`, `rs`, `sh`. Maximum size 25 MB.
* The recipient must be a chat that already exists in the database. Channels and broadcast lists are rejected.
* `send_file` accepts an optional `caption`, and `as_document` to send an image or video uncompressed. Audio sent with `send_file` is a regular audio message, not a voice note.
* `send_audio_message` sends an audio file as a voice note (allowed: `ogg`, `opus`, `mp3`, `m4a`, `aac`, `wav`, `amr`, `flac`, `webm`). Anything that is not already Ogg/Opus is converted with ffmpeg first.
* `list_outbox` shows what is available. Only put files there that you actually want to send.

These checks run inside the server. They do not ask you for confirmation. See [Security](#security).

## Voice messages

`send_voice_message` turns text into speech and sends it as a WhatsApp voice note.

* **How it works:** the text goes to Microsoft's Edge online text-to-speech service through `msedge-tts`, the returned MP3 is converted to Ogg/Opus with ffmpeg, and the result is sent as a push-to-talk voice note.
* **Voices:** only these four are accepted.

  | Voice | Language | Gender |
  |---|---|---|
  | `en-US-AriaNeural` (default) | English | Female |
  | `en-US-GuyNeural` | English | Male |
  | `ur-PK-UzmaNeural` | Urdu | Female |
  | `ur-PK-AsadNeural` | Urdu | Male |

* The voice has to match the language of the text. An English voice reading Urdu text (or the reverse) produces poor audio, and the server does not check this for you.
* **Limits:** up to 1,500 characters per message. The speech request times out after 20 seconds and returns an error. Voice notes cannot be sent to channels or broadcast lists, and the recipient must be an existing chat.
* **Privacy:** the text you ask it to speak is sent to Microsoft. Do not use this for anything you would not want leaving your machine.
* **Reliability:** this is an unofficial endpoint, and Microsoft changed its handshake in October 2026, which broke older client libraries. Use `msedge-tts` 2.1.0 or newer, and see [Troubleshooting](#troubleshooting) if voice notes fail.

## Security

Treat everything an agent reads from WhatsApp as untrusted. Anyone who can message you, or post in a group or channel you follow, can put text in front of your agent. Hidden instructions in a message may try to make it leak data or send things.

* **Prefer read-only.** Only expose the sending tools (`send_message`, `send_file`, `send_audio_message`, `send_voice_message`) to an agent if you need them.
* **Add human approval for sends.** The restrictions in the file tools limit what can be sent, but approval is something your client has to provide. A model must never be the one confirming its own send.
* **Keep sensitive folders private.** `auth_info/` is a full login to your WhatsApp account. `data/` holds all your messages, the media keys and recent sent messages. `downloads/` and `outbox/` may hold personal files. All four, and the `info/` log folder, are excluded from git. Never commit or share them.
* **Know where your data goes.** Anything a tool returns, such as message text and contact names, is sent to your AI client and to its model provider. Text for voice notes also goes to Microsoft's text-to-speech service.
* **Account risk.** Baileys is unofficial and WhatsApp can restrict accounts that automate heavily. Keep sending rare and targeted.

## Architecture Overview

This application is a single Node.js process that:

1.  Uses `@whiskeysockets/baileys` to connect to the WhatsApp Web API, handling authentication, contact sync and real-time messaging events.
2.  Stores chats, messages, contacts, raw media records and recently sent messages locally in a SQLite database (`./data/whatsapp.db`) using `node:sqlite`.
3.  Runs an MCP server using `@modelcontextprotocol/sdk` that listens for requests from an AI client over standard input/output (stdio).
4.  Provides MCP tools that query the local database or use the Baileys socket to send messages, files and voice notes and to download media.
5.  Uses `pino` for logging (`info/wa_logs.txt` for WhatsApp events, `info/mcp_logs.txt` for MCP activity). Both files are cleared on each start. By default the log folder is `./info/`. Set `WHATSAPP_MCP_DATA_DIR` to use another folder.

### Project layout

```
src/
├── main.ts              # entry point: logging, database setup, starts WhatsApp and MCP
├── database/
│   ├── client.ts        # SQLite connection, schema, shared helpers
│   ├── chats.ts         # chat storage and queries, @lid merging, send-JID resolution
│   ├── contacts.ts      # contact storage and search
│   ├── messages.ts      # message storage, filters, context
│   ├── media.ts         # raw media records used for downloads
│   └── sent.ts          # copies of recently sent messages
├── whatsapp/
│   ├── index.ts         # connection, event handling, message parsing, text sending
│   └── files.ts         # file and audio sending, outbox, media download, text-to-speech
└── mcp/
    ├── index.ts         # MCP server setup and the schema resource
    ├── read.ts          # read-only tools (database queries)
    ├── action.ts        # tools that send, download or list the outbox
    └── helper.ts        # result helpers
```

## Data Storage & Privacy

* **Authentication:** `./auth_info/`
* **Messages, contacts and raw media records:** `./data/whatsapp.db`. Only text, captions and labels such as `[Image]` are stored as message content, but the `media_raw` table keeps what is needed to download media later.
* **Sent messages:** the `sent_raw` table keeps an encoded copy of each message the server sends, so it could be resent if a device asks for it. Rows older than 7 days are deleted whenever a new message is recorded. The hook in `src/whatsapp/index.ts` that reads this table (`getMessage`) is currently commented out, so the copies are stored but not yet used.
* **Downloaded files:** `./downloads/`. **Files to send:** `./outbox/`.
* **Temporary files:** voice-note audio is written to your system's temp folder while it is being converted, and removed afterwards.
* **Not stored:** other people's Status posts (`status@broadcast`).
* `auth_info/`, `data/`, `downloads/`, `outbox/` and `info/` (logs) are excluded from git. **Treat them as sensitive.** The logs include short previews of incoming messages.

## Technical Details

* **Language:** TypeScript
* **Runtime:** Node.js (>= v23.10.0)
* **WhatsApp API:** `@whiskeysockets/baileys`
* **MCP SDK:** `@modelcontextprotocol/sdk`
* **Database:** `node:sqlite` (built into Node.js)
* **Text to speech:** `msedge-tts`
* **Audio conversion:** `ffmpeg-static` (or `ffmpeg` on your PATH)
* **Logging:** `pino`
* **Schema validation:** `zod` (for MCP tool inputs)

## Troubleshooting

* **QR code issues:**
    * If the QR link does not open automatically, find the `quickchart.io` URL in `info/wa_logs.txt` and open it manually.
    * Scan the code promptly with the WhatsApp app.
* **Logged out:**
    * If the connection closes with `loggedOut`, stop the server, delete `./auth_info/`, and run `node src/main.ts` again for a new QR code.
* **Messages missing or out of sync:**
    * Initial sync takes time. Check `info/wa_logs.txt`.
    * For a full reset, stop the server, delete **both** `./auth_info/` and `./data/`, and restart to re-authenticate and resync. Older media will not be downloadable afterwards unless it is delivered again by the sync.
* **Messages you send show "Waiting for this message" on the phone:**
    * The tool can report success while the phone cannot decrypt the message. This is a known Baileys session problem, and it is most common with your own chat and with `@lid` IDs.
    * Stop every running process, then move the `session-*.json` and `sender-key-*.json` files out of `./auth_info/` into a backup folder. Keep `creds.json`. Start the server again and send a test. If connecting then fails, move the files back.
    * If it keeps coming back, the underlying fix is a newer Baileys release with better `@lid` handling. Upgrade on a copy of the project first, because the API changed.
* **"Bad MAC" or "Failed to decrypt message" lines:**
    * These can appear at startup with Baileys sessions and did not prevent reading messages in testing. Make sure only one process uses `auth_info/`. If they never stop, see the Baileys issue tracker.
* **Voice notes fail or time out:**
    * The error is returned to the agent, for example `Speech generation failed: TTS timed out after 20000ms`.
    * Check that `msedge-tts` is 2.1.0 or newer (`npm ls msedge-tts`). Older Edge text-to-speech libraries stopped working when Microsoft changed its handshake in October 2026. If it breaks again, look for a newer release with `npm view msedge-tts time`.
    * `ffmpeg binary was not found` means `ffmpeg-static` did not install. Run `npm install ffmpeg-static`, or install ffmpeg and put it on your PATH.
* **MCP connection problems:**
    * Check the `command` and `args` path in your client's config. It must be absolute and correct.
    * Verify Node.js is installed and on your PATH, and the version is at least 23.10.
    * Check the client's logs and `info/mcp_logs.txt`.
* **Agent loops, keeps retrying contact lookups, or asks which of two IDs to use:**
    * Contact names are searched by word. If the saved name is not in the database (WhatsApp only syncs some names), search with the phone number or the chat's JID.
    * If it asks about two IDs for the same person, see [Phone-number IDs and `@lid` IDs](#phone-number-ids-and-lid-ids). You can also tell the agent in its system prompt to always use the `@s.whatsapp.net` ID.
* **Errors downloading or sending:**
    * `No stored media data`: the message has no stored media record (see [Downloading media](#downloading-media)).
    * Channel posts report a missing media key and cannot be downloaded.
    * `Recipient is not an existing chat`: messages, files and voice notes can only go to chats that already exist in the database.
    * For `send_file` and `send_audio_message`, check the message returned. It names the rule that failed (file name, type, size, missing file or unknown chat).
    * Check `info/wa_logs.txt` for Baileys errors.
* **General:** check both `info/wa_logs.txt` and `info/mcp_logs.txt`.

For further MCP integration issues, see the [official MCP documentation](https://modelcontextprotocol.io/quickstart/server#claude-for-desktop-integration-issues).

## Credits

- [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), which inspired it (written in Go and Python).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
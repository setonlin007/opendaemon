# Plan 004: File & Image Upload

## Architecture

```
Browser                          Server                          Engine
  |                                |                               |
  |-- [attach files] ------------> |                               |
  |   POST /api/upload             |                               |
  |   multipart/form-data          |                               |
  |   (files + conv_id)            |                               |
  |                                |-- save to data/uploads/{uuid} |
  |                                |-- insert into attachments tbl |
  |<-- [{id, filename, type, url}] |                               |
  |                                |                               |
  |-- [send message] ------------> |                               |
  |   POST /api/chat               |                               |
  |   {prompt, attachment_ids}     |                               |
  |                                |-- load attachments from DB    |
  |                                |-- build multimodal content    |
  |                                |-- for images: base64 encode   |
  |                                |-- for files: extract text     |
  |                                |                               |
  |                                |-- Claude: content blocks ---> |
  |                                |   [{type:"image",source:...}, |
  |                                |    {type:"text",text:"..."}]  |
  |                                |                               |
  |                                |-- OpenAI: content array ----> |
  |                                |   [{type:"image_url",...},    |
  |                                |    {type:"text",text:"..."}]  |
```

## Data Model

### New table: `attachments`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID (e.g. `a1b2c3d4`) |
| conv_id | TEXT FK | References conversations(id) ON DELETE CASCADE |
| msg_id | INTEGER FK | References messages(id), set when message is sent (NULL until then) |
| filename | TEXT | Original filename |
| mime_type | TEXT | e.g. `image/png`, `text/plain`, `application/pdf` |
| size_bytes | INTEGER | File size |
| disk_path | TEXT | Relative path under data/uploads/ |
| category | TEXT | `image` or `file` |
| created_at | INTEGER | Unix ms |

### Messages table

The existing `metadata` JSON column on `messages` stores attachment IDs:

```json
{"attachments": ["a1b2c3d4", "e5f6g7h8"]}
```

No schema migration needed -- `metadata` is already a TEXT column storing JSON.

## API Changes

### POST /api/upload

Upload files before sending a message. Uses custom multipart parser (no external dependency).

**Request**: `multipart/form-data` with fields:
- `conv_id` (required) -- conversation to associate with
- `file` (one or more) -- the file(s)

**Response**:
```json
[
  {
    "id": "a1b2c3d4",
    "filename": "screenshot.png",
    "mime_type": "image/png",
    "size_bytes": 245000,
    "category": "image",
    "url": "/api/uploads/a1b2c3d4"
  }
]
```

**Validation**:
- Max 10MB per file
- Max 5 files per request
- Allowed MIME types: image/* (png, jpg, gif, webp), text/*, application/pdf, application/json
- Reject if conversation not found

### GET /api/uploads/:id

Serve uploaded file from disk. Used for thumbnail display and history rendering.

**Response**: Raw file with correct Content-Type header.

### POST /api/chat (modified)

Add optional `attachment_ids` field:

```json
{
  "conversation_id": "abc123",
  "prompt": "What's in this image?",
  "attachment_ids": ["a1b2c3d4"]
}
```

### GET /api/conversations/:id/messages (modified)

Include attachment metadata with each message that has attachments.

## Multipart Parsing

Custom minimal multipart parser (~60 lines):

1. Read raw body as Buffer
2. Extract boundary from Content-Type header
3. Split by boundary, parse each part's headers (Content-Disposition for name/filename, Content-Type)
4. Extract body bytes for each part

Only handles the simple case (no nested multipart).

## Engine Adapter Changes

### engine-claude.mjs

Build content blocks array when attachments are present:

```js
const content = [];

// Images --> native vision
content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } });

// PDF --> native document
content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });

// Text files --> text block
content.push({ type: "text", text: "--- filename ---\n<content>\n---" });

// User prompt
content.push({ type: "text", text: userPrompt });
```

Pass content array as `prompt` to `query()` (the Claude Agent SDK accepts content arrays matching the Anthropic Messages API format).

### engine-openai.mjs

Build content array for OpenAI format:

```js
const content = [];

// Images --> image_url with data URI
content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } });

// Text files / PDF text extraction --> text block
content.push({ type: "text", text: "--- filename ---\n<content>\n---" });

// User prompt
content.push({ type: "text", text: userPrompt });
```

### Shared helper: lib/attachments.mjs

| Function | Description |
|----------|-------------|
| `initUploads()` | Create `data/uploads/` directory |
| `saveAttachment(convId, filename, mimeType, buffer)` | Save file + insert DB row |
| `getAttachment(id)` | Query DB for metadata |
| `getAttachmentBuffer(id)` | Read file from disk |
| `getAttachmentsByMessage(msgId)` | Query by msg_id |
| `getAttachmentsByConversation(convId)` | Query by conv_id |
| `linkAttachmentsToMessage(attachmentIds, msgId)` | Update msg_id on rows |
| `deleteAttachmentFiles(convId)` | Delete files from disk |
| `buildClaudeContent(prompt, attachments)` | Build Claude content blocks |
| `buildOpenAIContent(prompt, attachments)` | Build OpenAI content array |
| `extractTextContent(buffer, mimeType)` | Read text from file buffer |

## Frontend Changes

### Input Area

```html
<div class="input-area">
  <div class="attachment-preview" id="attachmentPreview"></div>
  <div class="input-row">
    <button class="attach-btn" id="attachBtn">📎</button>
    <input type="file" id="fileInput" multiple accept="..." style="display:none">
    <div class="input-wrapper">
      <textarea id="input" ...></textarea>
    </div>
    <button id="sendBtn">Send</button>
  </div>
</div>
```

### Client-side Image Compression

Before upload, compress images >1MB:
1. Load into `<img>` element
2. Draw to Canvas at reduced dimensions (max 1600px longest side)
3. Export as JPEG at quality 0.85
4. If still >1MB, reduce quality further

### Upload Flow

1. User attaches files (button, drag, paste)
2. Client compresses images if needed
3. `POST /api/upload` immediately (don't wait for send)
4. Server returns attachment records
5. Client shows previews
6. On send: `POST /api/chat` includes `attachment_ids`
7. Server loads attachments, builds multimodal content, sends to engine

### Drag & Drop

- `.main` element is the drop target
- Visual feedback (dashed border) on dragover
- Extract files from `dataTransfer.files`

### Paste Handler

- Listen for `paste` event on textarea
- Check `clipboardData.items` for image types
- Create File from clipboard item, pass to upload flow
- Only prevent default when image data found (preserve text paste)

### Message Rendering

- Image attachments: inline `<img>` thumbnails (max-width 300px), click for full-size
- File attachments: chip showing filename + size
- Historical messages: reconstruct from metadata.attachments

## File Storage

```
data/uploads/
  {uuid}.{ext}      # a1b2c3d4.png, e5f6g7h8.txt
```

UUID names avoid collisions. Original filename in DB.

## Cleanup

When conversation is deleted:
1. Query attachment disk_paths for the conversation
2. Delete files from disk (best-effort)
3. DB CASCADE handles row deletion

## Security

- Server-side MIME validation (check magic bytes for images)
- Sanitize filenames (strip path traversal, limit length)
- `Content-Disposition: inline` for images, `attachment` for other files
- Auth required for `/api/uploads/:id` (existing global auth middleware)
- No directory listing

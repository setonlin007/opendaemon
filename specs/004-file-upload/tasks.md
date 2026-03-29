# Tasks 004: File & Image Upload

## Dependency Graph

```
T1 (DB schema) --+
                  +-- T3 (attachments module) -- T5 (upload API) -- T7 (chat integration)
T2 (file store) --+                                                       |
                                                                    T8 (Claude adapter)
T4 (multipart parser) -- T5                                         T9 (OpenAI adapter)
                                                                          |
                                                               T10 (frontend: input UI)
                                                               T11 (frontend: drag/drop/paste)
                                                               T12 (frontend: upload flow)
                                                               T13 (frontend: message rendering)
                                                               T14 (messages API + attachments)
                                                                          |
                                                               T15 (cleanup on delete)
                                                               T16 (validation & testing)
```

## Stage 1: Storage Foundation

### T1: Database Schema -- Attachments Table
**File:** `lib/db.mjs`
**Depends on:** nothing

- [ ] Add `attachments` table: id TEXT PK, conv_id TEXT FK (ON DELETE CASCADE), msg_id INTEGER FK (ON DELETE SET NULL), filename TEXT, mime_type TEXT, size_bytes INTEGER, disk_path TEXT, category TEXT, created_at INTEGER
- [ ] Add index: `idx_attachments_conv` on conv_id
- [ ] Add index: `idx_attachments_msg` on msg_id

### T2: Uploads Directory Setup
**File:** `lib/attachments.mjs` (new)
**Depends on:** nothing

- [ ] `initUploads()` -- create `data/uploads/` directory if it doesn't exist
- [ ] Call `initUploads()` from `server.mjs` startup

### T3: Attachments Module -- Core CRUD
**File:** `lib/attachments.mjs`
**Depends on:** T1, T2

- [ ] `saveAttachment(convId, filename, mimeType, buffer)` -- generate UUID id, determine category (image vs file), write buffer to `data/uploads/{id}.{ext}`, insert DB row, return attachment record
- [ ] `getAttachment(id)` -- query DB, return attachment metadata
- [ ] `getAttachmentsByMessage(msgId)` -- query by msg_id
- [ ] `getAttachmentsByConversation(convId)` -- query by conv_id
- [ ] `getAttachmentBuffer(id)` -- read file from disk, return Buffer
- [ ] `linkAttachmentsToMessage(attachmentIds, msgId)` -- UPDATE msg_id on attachment rows
- [ ] `deleteAttachmentFiles(convId)` -- query disk_paths for conv, delete files from disk (best-effort)
- [ ] `extractTextContent(buffer, mimeType)` -- read text from buffer for text-based files (UTF-8 decode)
- [ ] Filename sanitization: strip path components, limit to 200 chars, replace unsafe characters
- [ ] MIME type validation: whitelist of allowed types (image/png, image/jpeg, image/gif, image/webp, text/*, application/pdf, application/json)
- [ ] Size validation: reject files >10MB

### T4: Multipart Form-Data Parser
**File:** `lib/multipart.mjs` (new)
**Depends on:** nothing

- [ ] `parseMultipart(req)` -- read raw body as Buffer, extract boundary from Content-Type, parse parts
- [ ] Return array of `{ name, filename, contentType, data: Buffer }` for file parts and `{ name, value }` for field parts
- [ ] Handle standard multipart boundary format (RFC 2046 basics)
- [ ] Set max body size limit: 50MB

## Stage 2: Server API

### T5: Upload Endpoint
**File:** `server.mjs`
**Depends on:** T3, T4

- [ ] Add route: `POST /api/upload` -- parse multipart, validate conv_id, save each file via `saveAttachment()`, return array of attachment records
- [ ] Validate: conv_id exists, max 5 files per request, size limits
- [ ] Return 400 with descriptive error for validation failures

### T6: Serve Uploads Endpoint
**File:** `server.mjs`
**Depends on:** T3

- [ ] Add route: `GET /api/uploads/:id` -- load attachment metadata, serve file from disk with correct Content-Type
- [ ] Set `Content-Disposition: inline` for images, `attachment; filename="..."` for other files
- [ ] Return 404 if attachment not found

## Stage 3: Engine Integration

### T7: Chat Endpoint -- Attachment Support
**File:** `server.mjs`
**Depends on:** T3, T5

- [ ] Modify `POST /api/chat` to accept optional `attachment_ids` array in body
- [ ] Load attachments from DB, validate they belong to the conversation
- [ ] Store attachment IDs in message metadata: `{ attachments: attachmentIds }`
- [ ] Link attachments to the message via `linkAttachmentsToMessage()`
- [ ] Pass attachments to engine handler functions

### T8: Claude Engine -- Multimodal Content
**File:** `lib/engine-claude.mjs`
**Depends on:** T3, T7

- [ ] Add `buildClaudeContent(prompt, attachments)` to `lib/attachments.mjs`:
  - Images: `{ type: "image", source: { type: "base64", media_type, data } }`
  - PDF: `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`
  - Text files: `{ type: "text", text: "--- filename ---\n<content>\n---" }`
  - User prompt as final text block
- [ ] Modify `streamClaude()` to accept `attachments` parameter
- [ ] When attachments present, pass content array instead of string prompt to SDK
- [ ] Test with Claude SDK: verify multimodal prompt format works with `query()`

### T9: OpenAI Engine -- Multimodal Content
**File:** `lib/engine-openai.mjs`
**Depends on:** T3, T7

- [ ] Add `buildOpenAIContent(prompt, attachments)` to `lib/attachments.mjs`:
  - Images: `{ type: "image_url", image_url: { url: "data:{mime};base64,{data}" } }`
  - Text files / PDF text: `{ type: "text", text: "--- filename ---\n<content>\n---" }`
  - User prompt as final text block
- [ ] Modify `handleOpenAIChat()` to accept attachments
- [ ] For current message with attachments, use content array instead of string
- [ ] For historical messages with attachments (re-building from DB), reconstruct content array

## Stage 4: Frontend

### T10: Input Area UI -- Attach Button & Preview
**File:** `public/index.html`
**Depends on:** T5

- [ ] Add attach button (📎 icon) to `.input-row`, left of `.input-wrapper`
- [ ] Add hidden `<input type="file" multiple>` with accept attribute for supported types
- [ ] Add `<div class="attachment-preview">` above `.input-row`
- [ ] CSS: attach button styling to match existing input area
- [ ] CSS: attachment preview bar (horizontal scroll, flex row)
- [ ] CSS: image thumbnails (60px height, rounded corners, X button overlay)
- [ ] CSS: file chips (pill shape with filename, size, X button)
- [ ] JS: `pendingAttachments` array to track uploaded attachment objects
- [ ] JS: `triggerFileSelect()` -- click the hidden file input
- [ ] JS: `removeAttachment(id)` -- remove from pending and DOM
- [ ] JS: `clearAttachments()` -- clear all pending after send
- [ ] Mobile: `capture="environment"` for camera access

### T11: Drag & Drop and Paste
**File:** `public/index.html`
**Depends on:** T10

- [ ] Drag & drop: add dragover/dragleave/drop handlers on `.main`
- [ ] CSS: drag-over state visual feedback (dashed border overlay)
- [ ] On drop: extract files from `dataTransfer.files`, pass to `handleFiles()`
- [ ] Paste: listen for `paste` on textarea, check `clipboardData.items` for images
- [ ] On image paste: create File from clipboard item, pass to `handleFiles()`
- [ ] Preserve normal text paste (only intercept when image data found)

### T12: Upload Flow & Send Integration
**File:** `public/index.html`
**Depends on:** T10, T5

- [ ] Client-side image compression: Canvas resize for images >1MB (max 1600px, JPEG 0.85)
- [ ] `uploadFile(file)` -- create FormData, POST to `/api/upload`, return attachment object
- [ ] Upload progress indicator (spinner or opacity on thumbnail/chip)
- [ ] Handle upload errors (show toast)
- [ ] Modify `sendMessage()`: include `attachment_ids` in POST body when attachments present
- [ ] Clear attachment preview after send
- [ ] Disable send while uploads in progress
- [ ] Allow image-only messages (empty text prompt)

### T13: Message Rendering with Attachments
**File:** `public/index.html`
**Depends on:** T6

- [ ] Modify user message bubble to render image attachments as inline `<img>` (max-width 300px)
- [ ] Render file attachments as download chips below text
- [ ] Click image thumbnail: open full-size in lightbox overlay or new tab
- [ ] Handle image-only messages (no text, just images)

### T14: Messages API -- Include Attachments
**File:** `server.mjs`
**Depends on:** T3

- [ ] Modify `GET /api/conversations/:id/messages` to include attachment metadata
- [ ] For each message with metadata.attachments, join with attachments table
- [ ] Return `{ ...message, attachments: [{id, filename, mime_type, size_bytes, category, url}] }`
- [ ] Modify `selectConversation()` in frontend to use attachment data when rendering history

## Stage 5: Cleanup & Polish

### T15: File Cleanup on Conversation Delete
**File:** `server.mjs`, `lib/attachments.mjs`
**Depends on:** T3

- [ ] Before deleting conversation, call `deleteAttachmentFiles(convId)`
- [ ] Wire into conversation delete handler in `server.mjs`

### T16: Validation & Error Handling
**Depends on:** all above

- [ ] Server-side magic byte validation for images (PNG: 0x89504E47, JPEG: 0xFFD8FF, GIF: 0x474946, WebP: 0x52494646)
- [ ] Graceful handling when attachment file missing from disk (show placeholder)
- [ ] Empty prompt with attachments should work
- [ ] Test Claude engine multimodal format
- [ ] Test OpenAI engine multimodal format
- [ ] Test drag & drop (Chrome, Firefox, Safari)
- [ ] Test clipboard paste
- [ ] Test mobile (iOS Safari, Android Chrome)
- [ ] Test conversation delete cleans up files
- [ ] Test file size limit enforcement (client + server)

## Implementation Order

1. **T1 + T2 + T4** -- foundation (parallel, no dependencies)
2. **T3** -- attachments module (needs T1 + T2)
3. **T5 + T6** -- upload/serve API (parallel)
4. **T7** -- chat endpoint changes
5. **T8 + T9** -- engine adapters (parallel)
6. **T10** -- frontend input UI
7. **T11 + T12** -- drag/drop/paste + upload flow (parallel)
8. **T13 + T14** -- message rendering + API (parallel)
9. **T15 + T16** -- cleanup + validation

**Estimated: 4-6 days**

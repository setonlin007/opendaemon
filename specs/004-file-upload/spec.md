# Spec 004: File & Image Upload

## Problem

OpenDaemon users cannot share images or files with the LLM. Both Claude and OpenAI engines support vision (image analysis) and document reading, but the chat interface is text-only. Users must describe screenshots, copy-paste file contents manually, or use external tools to share visual/document context.

This is a basic capability gap. Every major chat interface supports attachments.

## Goals

1. **Image upload** -- Attach images (PNG, JPG, GIF, WebP) to chat messages; the LLM receives them as vision input and can analyze their content
2. **File upload** -- Attach documents (PDF, TXT, code files, Markdown, etc.) to chat messages; file content is extracted as text and sent to the LLM
3. **Drag & drop** -- Drop files anywhere in the chat area to attach them
4. **Clipboard paste** -- Paste images from clipboard (Ctrl+V / Cmd+V) to attach them
5. **Mobile support** -- Camera capture via `accept="image/*;capture=camera"` and native file picker
6. **Attachment persistence** -- Uploaded files stored on disk (`data/uploads/`) with DB references, viewable when loading conversation history

## Non-Goals (this phase)

- Audio/video upload or transcription
- Inline image generation (the LLM generating images)
- File previews beyond thumbnails (no PDF viewer, no code editor)
- Cloud storage integration (S3, GCS)
- Multi-file drag-and-drop of 10+ files (reasonable limit: 5 per message)

## User Stories

### US-1: Image Attachment

As a user, I want to attach an image to my chat message so the LLM can see and analyze it.

- Click an attach button or drag/drop an image into the chat input area
- See a thumbnail preview of the attached image before sending
- Remove an attachment before sending
- The LLM response demonstrates it can see the image content
- When loading conversation history, attached images are visible inline

### US-2: File Attachment

As a user, I want to attach a document (PDF, code file, text file) so the LLM can read its contents.

- Attach files via button click, drag/drop, or file picker
- See file name and size in a preview chip before sending
- The LLM receives the file content as text (extracted server-side)
- Supported types: .txt, .md, .json, .csv, .py, .js, .ts, .html, .css, .pdf, .xml, .yaml, .toml, .sh, .sql, .log, .cfg, .ini, .env (text-based)
- PDF: Claude API supports native PDF; OpenAI falls back to basic text extraction

### US-3: Paste from Clipboard

As a user, I want to paste a screenshot (Cmd+V) directly into the chat input to share it with the LLM.

- Paste event on the textarea captures image data from clipboard
- Shows thumbnail preview, same as drag/drop
- Works on both desktop and mobile browsers

### US-4: Mobile Camera

As a mobile user, I want to take a photo with my camera and send it to the LLM.

- The attach button on mobile triggers native file picker with camera option
- `accept="image/*"` attribute enables camera capture on iOS/Android

## Constraints

- **File size limit**: 10MB per file, 20MB total per message
- **Image compression**: Images over 1MB are resized/compressed to ~1MB before upload (client-side) to keep API costs reasonable
- **Max attachments**: 5 files per message
- **Storage**: Local disk only (`data/uploads/`), no cloud
- **No new npm dependencies**: Use built-in Node.js APIs; client-side image compression via Canvas API

## Key Design Decisions

1. **Upload-then-send** -- Files upload immediately on attach (via `POST /api/upload`), not bundled with the chat message. This provides instant feedback and avoids large multipart chat requests.
2. **Claude native PDF** -- Claude's API accepts PDF as a `document` content block; no need for text extraction. OpenAI falls back to basic extraction.
3. **Client-side compression** -- Images are compressed before upload using Canvas API. Keeps server simple and reduces bandwidth.
4. **UUID file storage** -- Files stored as `{uuid}.{ext}` to avoid collisions and path traversal. Original filename preserved in DB.
5. **Custom multipart parser** -- Avoid adding multer/busboy dependency. Minimal parser (~60 lines) handles our simple use case.

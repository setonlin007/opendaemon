/**
 * Minimal multipart/form-data parser.
 * No external dependencies — handles the simple case (flat parts, no nesting).
 */

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

/**
 * Parse a multipart/form-data request.
 * @param {http.IncomingMessage} req
 * @returns {Promise<{fields: Record<string,string>, files: Array<{name:string, filename:string, contentType:string, data:Buffer}>}>}
 */
export async function parseMultipart(req) {
  const contentType = req.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!match) throw new Error("Missing multipart boundary");
  const boundary = match[1] || match[2];

  // Read full body as Buffer
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) throw new Error(`Body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`);
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);

  const delimiterBuf = Buffer.from(`--${boundary}`);
  const closingBuf = Buffer.from(`--${boundary}--`);
  const fields = {};
  const files = [];

  // Find all boundary positions
  const positions = [];
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const idx = bufferIndexOf(body, delimiterBuf, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + delimiterBuf.length;
  }

  // Extract parts between consecutive boundaries
  for (let i = 0; i < positions.length - 1; i++) {
    const partStart = positions[i] + delimiterBuf.length;
    const partEnd = positions[i + 1];

    // Skip the \r\n after boundary marker
    let dataStart = partStart;
    if (body[dataStart] === 0x0d && body[dataStart + 1] === 0x0a) dataStart += 2;

    // Remove trailing \r\n before next boundary
    let dataEnd = partEnd;
    if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;

    if (dataStart >= dataEnd) continue;
    const partBuf = body.subarray(dataStart, dataEnd);

    // Find header/body separator (double CRLF)
    const sepIdx = bufferIndexOf(partBuf, DOUBLE_CRLF, 0);
    if (sepIdx === -1) continue;

    const headerStr = partBuf.subarray(0, sepIdx).toString("utf-8");
    const bodyBuf = partBuf.subarray(sepIdx + 4);

    // Parse headers
    const headers = {};
    for (const line of headerStr.split("\r\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      headers[line.substring(0, colonIdx).trim().toLowerCase()] = line.substring(colonIdx + 1).trim();
    }

    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/\bname="([^"]*)"/) || disposition.match(/\bname=([^\s;]+)/);
    // Support: filename="...", filename*=utf-8''..., filename=...
    const filenameMatch = disposition.match(/\bfilename="([^"]*)"/) || disposition.match(/\bfilename=([^\s;]+)/);
    const name = nameMatch ? nameMatch[1] : "unknown";

    if (filenameMatch && filenameMatch[1]) {
      let filename = filenameMatch[1];
      // Decode percent-encoded filenames (filename*=utf-8''...)
      try { filename = decodeURIComponent(filename); } catch {}

      files.push({
        name,
        filename,
        contentType: headers["content-type"] || "application/octet-stream",
        data: bodyBuf,
      });
    } else if (!filenameMatch) {
      // Regular form field (no filename = not a file)
      fields[name] = bodyBuf.toString("utf-8");
    }
    // Skip entries with empty filename (browser sends filename="" for empty file inputs)
  }

  return { fields, files };
}

/**
 * Find buffer needle in haystack starting from offset.
 * More reliable than Buffer.indexOf with string arguments.
 */
function bufferIndexOf(haystack, needle, offset) {
  if (offset >= haystack.length) return -1;
  const idx = haystack.indexOf(needle, offset);
  return idx;
}

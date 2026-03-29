/**
 * Minimal multipart/form-data parser.
 * No external dependencies — handles the simple case (flat parts, no nesting).
 */

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB

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
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const delimiterBuf = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  // Split body by boundary
  let pos = 0;
  const parts = [];
  while (true) {
    const idx = body.indexOf(delimiterBuf, pos);
    if (idx === -1) break;
    if (parts.length > 0) {
      // Content between previous boundary and this one (strip leading \r\n and trailing \r\n)
      let start = pos;
      let end = idx;
      if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
      if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
      parts.push(body.subarray(start, end));
    }
    pos = idx + delimiterBuf.length;
    // Check for closing --
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
  }

  for (const part of parts) {
    // Find header/body separator (double CRLF)
    const sepIdx = part.indexOf("\r\n\r\n");
    if (sepIdx === -1) continue;

    const headerStr = part.subarray(0, sepIdx).toString("utf-8");
    const bodyBuf = part.subarray(sepIdx + 4);

    // Parse headers
    const headers = {};
    for (const line of headerStr.split("\r\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      headers[line.substring(0, colonIdx).trim().toLowerCase()] = line.substring(colonIdx + 1).trim();
    }

    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/\bname="([^"]+)"/);
    const filenameMatch = disposition.match(/\bfilename="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : "unknown";

    if (filenameMatch) {
      files.push({
        name,
        filename: filenameMatch[1],
        contentType: headers["content-type"] || "application/octet-stream",
        data: bodyBuf,
      });
    } else {
      fields[name] = bodyBuf.toString("utf-8");
    }
  }

  return { fields, files };
}

// Extension to MIME map for the containers this engine emits. A full MIME
// database is ~200KB of lookup data for the handful of types that can
// actually come out of the pipeline.

const types = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    "3gp": "video/3gpp",
    ts: "video/mp2t",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    heic: "image/heic",
    bmp: "image/bmp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    opus: "audio/opus",
    ogg: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    vtt: "text/vtt",
    srt: "application/x-subrip",
};

export function getType(filename) {
    if (!filename) return;
    const ext = filename.split(".").pop()?.toLowerCase();
    return types[ext];
}

export function extensionFor(contentType) {
    if (!contentType) return;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    for (const [ext, type] of Object.entries(types)) {
        if (type === mime) return ext;
    }
    return mime.split("/")[1];
}

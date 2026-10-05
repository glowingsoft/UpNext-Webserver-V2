const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const mime = require("mime-types");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const { PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("@config/s3Client");
const { getMediaType } = require("./imageHelper");

// Thumbnails are produced server-side so a client never has to pull a full-size
// photo — let alone an entire video or PDF — just to paint a grid cell. Images
// go through sharp; videos have a single frame pulled with ffmpeg and PDFs have
// their first page rendered, and both then go through that same sharp step, so
// every thumbnail comes out one consistent format regardless of what was
// uploaded.

const THUMB_WIDTH = 400;
const THUMB_SUFFIX = "-thumb.webp";
const THUMB_CONTENT_TYPE = "image/webp";
// Frame 0 of a video is very often a black or blank fade-in, so seek past it.
const FRAME_SECONDS = 1;
// A corrupt or truncated clip can leave ffmpeg spinning; a portfolio save must
// not hang behind it.
const FFMPEG_TIMEOUT_MS = 30 * 1000;
// Videos are decoded one temp file at a time — a portfolio can carry 20 of them
// and unbounded parallelism would mean 20 simultaneous downloads and decodes.
const THUMB_CONCURRENCY = 4;

// The bundled binary keeps deploys off a system-wide ffmpeg install; FFMPEG_PATH
// overrides it on hosts that already have one. A missing package is not fatal —
// video thumbnails degrade to null while image thumbnails carry on.
const resolveFfmpegPath = () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return null;
  }
};

const ffmpegPath = resolveFfmpegPath();
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// pdfjs-dist is ESM-only and, with its canvas backend, weighs tens of megabytes.
// A memoized dynamic import keeps this file CJS and keeps all of that out of
// memory until a PDF actually turns up.
let pdfjsPromise;
const loadPdfjs = () => {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
};

const isPdf = (key) => mime.lookup(key || "") === "application/pdf";

// Media is stored as a bare key, but a full S3 URL (or a query-signed one) can
// reach here from older rows and from clients round-tripping a GET response —
// reduce every form to the key the bucket actually knows.
const storageKey = (media) => {
  if (typeof media !== "string") return null;
  const trimmed = media.trim().split(/[?#]/)[0];
  if (!trimmed) return null;
  return trimmed.split("/").pop() || null;
};

// `cleanfiles` flattens anything containing a slash down to its last segment, so
// the thumbnail sits beside the original as `<name>-thumb.webp` rather than
// under a `thumbs/` prefix that would not survive a round trip through a
// request body. Anything that is neither an image, a video nor a PDF gets no
// key — there is nothing to render. In practice that is only media with no
// usable extension, since the upload filter accepts nothing else.
const thumbKeyFor = (media) => {
  const key = storageKey(media);
  if (!key) return null;

  const type = getMediaType(key);
  if (type !== "image" && type !== "video" && !isPdf(key)) return null;

  return `${key.slice(0, key.length - path.extname(key).length)}${THUMB_SUFFIX}`;
};

const resizeToThumb = (buffer) =>
  sharp(buffer)
    .rotate() // honour the EXIF orientation tag, which resizing would otherwise drop
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

const grabFrame = (source, output, seconds) =>
  new Promise((resolve, reject) => {
    const command = ffmpeg(source)
      .inputOptions(["-ss", String(seconds)])
      .outputOptions(["-y", "-frames:v", "1", "-an"])
      .output(output);

    const timer = setTimeout(() => {
      command.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    command
      .on("end", () => {
        clearTimeout(timer);
        resolve();
      })
      .on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      })
      .run();
  });

const frameWritten = async (file) => {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
};

// ffmpeg seeks by byte offset, so the clip has to be a real file on disk — a
// buffer piped through stdin is not seekable and `-ss` yields nothing.
const extractVideoFrame = async (buffer, extension) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "upnext-thumb-"));
  const source = path.join(dir, `source${extension || ".mp4"}`);
  const frame = path.join(dir, "frame.png");

  try {
    await fs.writeFile(source, buffer);

    // A clip shorter than the seek point writes no frame at all, yet ffmpeg
    // still exits 0 ("Output file is empty") — so whether the output file
    // actually appeared, not the exit code, decides if the seek found anything.
    // Falling back to frame 0 keeps short clips from losing their thumbnail.
    for (const seconds of [FRAME_SECONDS, 0]) {
      try {
        await grabFrame(source, frame, seconds);
      } catch {
        continue;
      }
      if (await frameWritten(frame)) return await fs.readFile(frame);
    }

    throw new Error("ffmpeg produced no frame");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

// sharp's prebuilt libvips has PDF input compiled out, so the first page is
// rasterized with pdfjs instead and handed to sharp as a PNG like any other
// image.
const renderPdfFirstPage = async (buffer) => {
  const [pdfjs, { createCanvas }] = await Promise.all([loadPdfjs(), Promise.resolve(require("@napi-rs/canvas"))]);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  // pdfjs validates these as URLs and rejects anything without a trailing
  // forward slash, so a Windows path separator will not do.
  const assetUrl = (dir) => `${path.join(pdfjsRoot, dir).replace(/\\/g, "/")}/`;

  // The loading task, not the document, owns teardown — leaving it undestroyed
  // leaks the worker behind every PDF thumbnail.
  const loadingTask = pdfjs.getDocument({
    // pdfjs detaches the buffer it is handed, and `buffer` is the same one the
    // caller may still upload — hand over a copy.
    data: new Uint8Array(buffer),
    // Resolved from the installed package so embedded-font-less PDFs still
    // render their text rather than coming out blank.
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    // Uploaded PDFs are untrusted input; neither is needed to draw a page.
    isEvalSupported: false,
    disableFontFace: true,
  });

  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / unscaled.width });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");

    // A PDF page carries no background of its own; without this the untouched
    // areas stay transparent and flatten to black in the thumbnail.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return canvas.toBuffer("image/png");
  } finally {
    await loadingTask.destroy();
  }
};

const buildThumbnail = async ({ buffer, key }) => {
  const name = storageKey(key);
  const type = getMediaType(name);
  if (type === "image") return resizeToThumb(buffer);
  if (type === "video") return resizeToThumb(await extractVideoFrame(buffer, path.extname(name || "")));
  if (isPdf(name)) return resizeToThumb(await renderPdfFirstPage(buffer));
  return null;
};

const putThumbnail = (key, body) =>
  s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: THUMB_CONTENT_TYPE,
    }),
  );

const objectExists = async (key) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
};

const fetchObject = async (key) => {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
  return Buffer.from(await Body.transformToByteArray());
};

// The upload path already holds the bytes, so it skips the round trip back to
// S3 that `ensureThumbnail` would otherwise pay for.
const createThumbnail = async ({ buffer, key }) => {
  const thumbKey = thumbKeyFor(key);
  if (!thumbKey) return null;

  try {
    const thumb = await buildThumbnail({ buffer, key });
    if (!thumb) return null;

    await putThumbnail(thumbKey, thumb);
    return thumbKey;
  } catch (error) {
    // A missing thumbnail is a degraded grid cell, never a failed upload.
    console.error(`Thumbnail generation failed for ${key}:`, error.message);
    return null;
  }
};

// Backfill path: for media that arrives without a thumbnail — clients that
// predate the upload endpoint returning one, or media whose generation failed —
// pull the original back out of the bucket and encode it now.
const ensureThumbnail = async (media) => {
  const thumbKey = thumbKeyFor(media);
  if (!thumbKey) return null;

  try {
    // The upload may have made one anyway; that costs a single HEAD rather than
    // a download and re-encode.
    if (await objectExists(thumbKey)) return thumbKey;

    const buffer = await fetchObject(storageKey(media));
    const thumb = await buildThumbnail({ buffer, key: media });
    if (!thumb) return null;

    await putThumbnail(thumbKey, thumb);
    return thumbKey;
  } catch (error) {
    console.error(`Thumbnail backfill failed for ${media}:`, error.message);
    return null;
  }
};

const mapWithConcurrency = async (items, worker, concurrency) => {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
};

// Normalizes a write's media into the stored `{ file, thumbnail }` shape.
//
// The upload endpoint already generated and returned a thumbnail key, so an
// entry that arrives carrying one is taken at its word and costs nothing —
// re-deriving it would mean a HEAD against the bucket per item to confirm what
// the caller just told us. Only entries with no thumbnail (a bare key, an older
// client, or the migration replaying pre-thumbnail rows) fall back to
// generating one.
const attachThumbnails = (media = []) =>
  mapWithConcurrency(
    media,
    async (item) => {
      const { file, thumbnail } = typeof item === "string" ? { file: item } : item || {};
      return { file, thumbnail: thumbnail || (await ensureThumbnail(file)) };
    },
    THUMB_CONCURRENCY,
  );

module.exports = {
  thumbKeyFor,
  createThumbnail,
  ensureThumbnail,
  attachThumbnails,
};

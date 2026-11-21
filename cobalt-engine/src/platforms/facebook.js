import { getCookie, updateCookie } from "../cookie-store.js";
import { genericUserAgent } from "../settings.js";

const headers = {
    'User-Agent': genericUserAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
}

// m.facebook serves a lightweight photo page (with og:image) to mobile
// user agents without requiring a login, unlike www/mbasic
const photoHeaders = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36',
    'Accept': headers.Accept,
    'Accept-Language': headers['Accept-Language'],
}

const resolveUrl = (url, dispatcher) => {
    return fetch(url, { headers, dispatcher })
        .then(r => {
            if (r.headers.get('location')) {
                return decodeURIComponent(r.headers.get('location'));
            }
            if (r.headers.get('link')) {
                const linkMatch = r.headers.get('link').match(/<(.*?)\/>/);
                return decodeURIComponent(linkMatch[1]);
            }
            return false;
        })
        .catch(() => false);
}

const getPhoto = async (photoId, dispatcher) => {
    let html = await fetch(`https://web.facebook.com/photo/?fbid=${photoId}`, {
        headers, dispatcher
    }).then(r => r.text())
    .catch(() => false);

    let image;
    if (html) {
        // the signed photo url is embedded in the page right
        // after the graphql node of the photo itself
        const node = html.indexOf(`"__isNode":"Photo","id":"${photoId}"`);
        if (node !== -1) {
            image = html.slice(node, node + 3000)
                .match(/"(?:image|prefetch_uris_v2)":(?:\[\{|\{)"uri":"([^"]+)"/)?.[1];
        }
    }

    if (!image) {
        // fallback: m.facebook photo page (mobile user agent)
        html = await fetch(`https://m.facebook.com/photo.php?fbid=${photoId}`, {
            headers: photoHeaders, dispatcher
        }).then(r => r.text())
        .catch(() => false);
        image = html?.match?.(/<meta property="og:image" content="([^"]+)"/)?.[1];
    }

    if (!image) return { error: "fetch.empty" };

    // decode escaped url params and strip the /sNNNxNNN/ size
    // transform some fbcdn urls carry, to get the original image
    const url = image
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\\//g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/&amp;/g, '&')
        .replace(/\/s\d+x\d+\//g, '/');

    // fbcdn's stp=dst-jpg transform re-encodes any source to jpeg while
    // keeping the original path extension, so it decides the extension
    const ext = url.includes('stp=dst-jpg')
        ? 'jpg'
        : url.match(/\.(png|webp|jpe?g)(\?|$)/i)?.[1] || 'jpg';

    return {
        isPhoto: true,
        urls: url,
        filename: `facebook_${photoId}.${ext}`,
    };
}

const jsonBlobs = html => {
    const blobs = [];
    for (const match of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
            blobs.push(JSON.parse(match[1]));
        } catch {}
    }
    return blobs;
}

/** The post the document is about: its own `og:url` ends in the numeric post id. */
const pagePostId = html => {
    const url = /<meta property="og:url" content="([^"]*)"/.exec(html)?.[1];
    return url?.replace(/\/+$/, '').split('/').pop() ?? null;
}

// The permalink, the words and the attachments arrive in different nodes of the same post, and the
// pfbid in a link is one encoding of an id Facebook may re-encode in the canonical permalink. So the
// document's own og:url picks the post, and every node that states its post_id contributes to it.
const merge = (left, right) => ({
    ...left,
    ...right,
    message: left.message?.text ? left.message : right.message,
    attachments: left.attachments?.length ? left.attachments : right.attachments,
    permalink_url: left.permalink_url ?? right.permalink_url,
    actors: left.actors?.length ? left.actors : right.actors,
});

const storyOf = html => {
    const stories = new Map();
    const walk = (value, depth) => {
        if (value === null || typeof value !== "object" || depth > 64) return;
        if (Array.isArray(value)) return value.forEach(item => walk(item, depth + 1));
        if (value.post_id) {
            const key = String(value.post_id);
            stories.set(key, stories.has(key) ? merge(stories.get(key), value) : value);
        }
        Object.values(value).forEach(child => walk(child, depth + 1));
    };

    for (const blob of jsonBlobs(html)) walk(blob, 0);

    return stories.get(pagePostId(html))
        ?? [...stories.values()].find(story => story.attachments?.length)
        ?? null;
}

// A photo is a Photo node with a rendered uri; a link preview's `image.uri` and the actor's
// profile picture are not, which is why the typename is part of the test (same markers RSSHub reads).
const photoUrl = node => node?.__typename === "Photo"
    ? node.photo_image?.uri ?? node.image?.uri ?? node.large_share_image?.uri
    : undefined;

const videoUrl = node => node?.__typename !== "Video" ? undefined : (
    node.videoDeliveryLegacyFields?.browser_native_hd_url
    ?? node.videoDeliveryLegacyFields?.browser_native_sd_url
    ?? node.playable_url
    ?? node.video_grid_renderer?.video?.videoDeliveryLegacyFields?.browser_native_hd_url
    ?? node.video_grid_renderer?.video?.videoDeliveryLegacyFields?.browser_native_sd_url
);

// Every Photo/Video node under the story's attachments, in post order, deduped.
const mediaOf = attachments => {
    const media = [], seen = new Set();
    const add = (type, url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        media.push({ type, url });
    };
    const walk = (value, depth) => {
        if (value === null || typeof value !== "object" || depth > 24) return;
        if (Array.isArray(value)) return value.forEach(item => walk(item, depth + 1));
        add("photo", photoUrl(value));
        add("video", videoUrl(value));
        Object.values(value).forEach(child => walk(child, depth + 1));
    };

    walk(attachments, 0);
    return media;
}

/**
 * Pure, so the fixture drives it: the post the document is about, its words, its author and its
 * media. The album's photos keep Facebook's own order; the urls ship verbatim because removing the
 * `stp`/`cstp`/`ctp` size params breaks the `oh=` signature (403, measured).
 */
export const parseFacebookPost = html => {
    const story = storyOf(html);
    if (!story) return null;

    return {
        text: (story.message?.text ?? story.comet_sections?.message?.story?.message?.text ?? "").trim(),
        author: story.actors?.[0]?.name?.trim() ?? "",
        permalink: story.permalink_url,
        media: mediaOf([...(story.attachments ?? []), ...(story.attached_story?.attachments ?? [])]),
    };
}

/** The house shapes for a parsed post; pure, so the fixture drives every branch. */
export const postResult = (post, id) => {
    if (!post.media.length) return { error: "fetch.empty" };

    const meta = post.text || post.author
        ? { fileMetadata: { ...(post.text && { title: post.text }), ...(post.author && { artist: post.author }) } }
        : {};

    if (post.media.length > 1) return { picker: post.media, ...meta };

    const [only] = post.media;

    if (only.type === "video") {
        return {
            urls: only.url,
            filename: `facebook_${id}.mp4`,
            audioFilename: `facebook_${id}_audio`,
            ...meta,
        };
    }

    return {
        isPhoto: true,
        urls: only.url,
        filename: `facebook_${id}.jpg`,
        ...meta,
    };
}

const getPost = async ({ username, postId, dispatcher }) => {
    const cookie = getCookie('facebook');
    const res = await fetch(`https://www.facebook.com/${username}/posts/${postId}`, {
        headers: {
            ...headers,
            // A permalink is a page navigation, and the document is the one that carries the post.
            'Sec-Fetch-Dest': 'document',
            ...(cookie && { cookie: cookie.toString() }),
        },
        dispatcher
    }).catch(() => null);

    if (res) updateCookie(cookie, res.headers);

    const post = res ? parseFacebookPost(await res.text().catch(() => "")) : null;
    if (!post) return { error: "content.post.unavailable" };

    return postResult(post, postId);
}

export default async function({ id, shareType, shortLink, photoId, postId, username, dispatcher }) {
    if (photoId) return getPhoto(photoId, dispatcher);
    if (postId) return getPost({ username, postId, dispatcher });

    let url = `https://www.facebook.com/reel/${id}`;

    if (shareType) url = `https://www.facebook.com/share/${shareType}/${id}`;
    if (shortLink) url = await resolveUrl(`https://fb.watch/${shortLink}`, dispatcher);

    const html = await fetch(url, { headers, dispatcher })
        .then(r => r.text())
        .catch(() => false);

    if (!html && shortLink) return { error: "fetch.short_link" }
    if (!html) return { error: "fetch.fail" };

    const urls = [];
    const hd = html.match('"browser_native_hd_url":(".*?")');
    const sd = html.match('"browser_native_sd_url":(".*?")');

    if (hd?.[1]) urls.push(JSON.parse(hd[1]));
    if (sd?.[1]) urls.push(JSON.parse(sd[1]));

    if (!urls.length) {
        return { error: "fetch.empty" };
    }

    const baseFilename = `facebook_${id || shortLink}`;

    return {
        urls: urls[0],
        filename: `${baseFilename}.mp4`,
        audioFilename: `${baseFilename}_audio`,
    };
}

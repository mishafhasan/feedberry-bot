import Cookie from "../cookie.js";

import { extract, normalizeURL } from "../links.js";
import { genericUserAgent, mobileUserAgent } from "../settings.js";
import { updateCookie } from "../cookie-store.js";
import { createStream } from "../compat.js";
import { convertLanguageCode } from "../language-codes.js";

const shortDomain = "https://vt.tiktok.com/";
const dataMarker = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';

// Tiktok picks a page template from the user agent fingerprint: the desktop and
// mobile ones get a stripped "reflow" document, a bot-ish one gets the classic
// SSR document that still embeds the post. Try them in order and keep the
// first that actually contains the video detail block.
const fingerprints = [genericUserAgent, mobileUserAgent, "curl/8.4.0"];

const fetchPostHTML = async (postId, cookie) => {
    for (const userAgent of fingerprints) {
        const res = await fetch(`https://www.tiktok.com/@i/video/${postId}`, {
            headers: {
                "user-agent": userAgent,
                cookie,
            }
        });
        updateCookie(cookie, res.headers);

        const html = await res.text();
        if (html.includes("webapp.video-detail")) return html;
    }
}

const selectScriptJSON = (html) => {
    const start = html.indexOf(dataMarker);
    if (start === -1) return;

    const open = html.indexOf(">", start) + 1;
    const close = html.indexOf("</script>", open);
    if (open <= 0 || close === -1) return;

    return html.slice(open, close);
}

/*
    A post carries many equivalent play URLs. The CDN hosts
    (v16/v19-webapp-prime) answer plain HTTP requests with 403 unless the
    caller holds a signed session, while the /aweme/v1/play/ endpoints on the
    main host serve the same file to anyone. Rank the main host first and keep
    bitrate order inside each group, so the highest working quality wins.
*/
const rankPlayAddr = (url) => {
    try {
        return new URL(url).hostname === "www.tiktok.com" ? 0 : 1;
    } catch {
        return 2;
    }
}

const pickPlayAddr = (detail) => {
    const candidates = [];
    const push = (url) => {
        if (url && !candidates.includes(url)) candidates.push(url);
    }

    push(detail.video?.playAddr);
    push(detail.video?.downloadAddr);

    const byBitrate = [...(detail.video?.bitrateInfo ?? [])]
        .sort((a, b) => (b.Bitrate ?? 0) - (a.Bitrate ?? 0));

    for (const entry of byBitrate) {
        for (const url of entry.PlayAddr?.UrlList ?? []) push(url);
    }

    return candidates.sort((a, b) => rankPlayAddr(a) - rankPlayAddr(b))[0];
}

export default async function(obj) {
    const cookie = new Cookie({});
    let postId = obj.postId;

    if (!postId) {
        let html = await fetch(`${shortDomain}${obj.shortLink}`, {
            redirect: "manual",
            headers: {
                "user-agent": genericUserAgent.split(' Chrome/1')[0]
            }
        }).then(r => r.text()).catch(() => {});

        if (!html) return { error: "fetch.fail" };

        if (html.startsWith('<a href="https://')) {
            const extractedURL = html.split('<a href="')[1].split('?')[0];
            const { host, patternMatch } = extract(normalizeURL(extractedURL));
            if (host === "tiktok") {
                postId = patternMatch?.postId;
            }
        }
    }
    if (!postId) return { error: "fetch.short_link" };

    // should always be /video/, even for photos
    const html = await fetchPostHTML(postId, cookie);

    if (!html) return { error: "fetch.fail" };

    let detail;
    try {
        const data = JSON.parse(selectScriptJSON(html));
        const videoDetail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"];

        if (!videoDetail) throw "no video detail found";

        // status_deleted or etc
        if (videoDetail.statusMsg) {
            return { error: "content.post.unavailable"};
        }

        detail = videoDetail?.itemInfo?.itemStruct;
    } catch {
        return { error: "fetch.fail" };
    }

    if (detail.isContentClassified) {
        return { error: "content.post.age" };
    }

    if (!detail.author) {
        return { error: "fetch.empty" };
    }

    let video, videoFilename, audioFilename, audio, images,
        filenameBase = `tiktok_${detail.author?.uniqueId}_${postId}`,
        bestAudio; // will get defaulted to m4a later on in match-action

    // The caption travels with the media (same contract as instagram.js).
    const caption = (detail.desc || '').trim();

    images = detail.imagePost?.images;

    let playAddr = pickPlayAddr(detail);

    if (obj.h265) {
        const h265PlayAddr = detail?.video?.bitrateInfo?.find(b => b.CodecType.includes("h265"))?.PlayAddr.UrlList[0]
        playAddr = h265PlayAddr || playAddr
    }

    if (!obj.isAudioOnly && !images) {
        video = playAddr;
        videoFilename = `${filenameBase}.mp4`;
    } else {
        audio = playAddr;
        audioFilename = `${filenameBase}_audio`;

        if (obj.fullAudio || !audio) {
            audio = detail.music.playUrl;
            audioFilename += `_original`
        }
        if (audio.includes("mime_type=audio_mpeg")) bestAudio = 'mp3';
    }

    // Tiktok's media hosts check referer and fingerprint. Sending the session
    // cookie here makes them answer 403 (the signature is bound to the page
    // request), so media URLs are fetched without it.
    const headers = {
        "user-agent": genericUserAgent,
        referer: "https://www.tiktok.com/",
    };

    if (video) {
        let subtitles, fileMetadata;
        if (obj.subtitleLang && detail?.video?.subtitleInfos?.length) {
            const langCode = convertLanguageCode(obj.subtitleLang);
            const subtitle = detail?.video?.subtitleInfos.find(
                s => s.LanguageCodeName.startsWith(langCode) && s.Format === "webvtt"
            )
            if (subtitle) {
                subtitles = subtitle.Url;
                fileMetadata = {
                    sublanguage: langCode,
                }
            }
        }
        return {
            urls: video,
            subtitles,
            ...((caption || fileMetadata) && { fileMetadata: { ...(caption && { title: caption }), ...fileMetadata } }),
            filename: videoFilename,
            headers
        }
    }

    if (images && obj.isAudioOnly) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers
        }
    }

    if (images) {
        let imageLinks = images
            .map(i => i.imageURL.urlList.find(p => p.includes(".jpeg?")))
            .map((url, i) => {
                if (obj.alwaysProxy) url = createStream({
                    service: "tiktok",
                    type: "proxy",
                    url,
                    filename: `${filenameBase}_photo_${i + 1}.jpg`
                })

                return {
                    type: "photo",
                    url
                }
            });

        return {
            picker: imageLinks,
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers,
            ...(caption && { fileMetadata: { title: caption } })
        }
    }

    if (audio) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers,
            ...(caption && { fileMetadata: { title: caption } })
        }
    }

    return { error: "fetch.empty" };
}

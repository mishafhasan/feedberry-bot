// URL patterns and sanity limits for every supported platform.
//
// A link only reaches a handler when its host matches `services` and its path
// matches one of `patterns` *and* `testers` accepts the captured values. The
// testers stop absurd inputs (megabyte-long ids) from hitting the network.

import UrlPattern from "url-pattern";

export const services = {
    bsky: {
        patterns: [
            "profile/:user/post/:post"
        ],
        tld: "app",
    },
    facebook: {
        patterns: [
            "_shortLink/:shortLink",
            ":username/videos/:caption/:id",
            ":username/videos/:id",
            "reel/:id",
            "share/:shareType/:id",
            "photo?fbid=:photoId",
            "photo.php?fbid=:photoId"
        ],
        subdomains: ["web", "m"],
        altDomains: ["fb.watch"],
    },
    instagram: {
        patterns: [
            "p/:postId",
            "tv/:postId",
            "reel/:postId",
            "reels/:postId",
            "stories/:username/:storyId",

            /*
                share & username links use the same url pattern,
                so we test the share pattern first, cuz id type is different.
            */
            "share/:shareId",
            "share/p/:shareId",
            "share/reel/:shareId",

            ":username/p/:postId",
            ":username/reel/:postId",
        ],
        altDomains: ["ddinstagram.com"],
    },
    pinterest: {
        patterns: [
            "pin/:id",
            "pin/:id/:garbage",
            "url_shortener/:shortLink"
        ],
    },
    snapchat: {
        patterns: [
            ":shortLink",
            "spotlight/:spotlightId",
            ":username/spotlight/:spotlightId",
            "add/:username/:storyId",
            "u/:username/:storyId",
            "add/:username",
            "u/:username",
            "t/:shortLink",
            "o/:spotlightId",
        ],
        subdomains: ["t", "story"],
    },
    threads: {
        patterns: [
            "post/:postId",              // threads.com/post/CODE
            "post/:postId/:slug",        // threads.com/post/CODE/slug
            "t/:postId",                 // legacy share links threads.com/t/CODE
            ":username/post/:postId",    // @user/post/CODE and user/post/CODE
            ":username/post/:postId/:slug",
        ],
        altDomains: ["threads.com"],
    },
    tiktok: {
        patterns: [
            ":user/video/:postId",
            "i18n/share/video/:postId",
            ":shortLink",
            "t/:shortLink",
            ":user/photo/:postId",
            "v/:postId.html"
        ],
        subdomains: ["vt", "vm", "m", "t", "pro"],
    },
    tumblr: {
        patterns: [
            "post/:id",
            "blog/view/:user/:id",
            ":user/:id",
            ":user/:id/:trackingId"
        ],
        subdomains: "*",
    },
    twitter: {
        patterns: [
            ":user/status/:id",
            ":user/status/:id/video/:index",
            ":user/status/:id/photo/:index",
            ":user/status/:id/mediaviewer",
            ":user/status/:id/mediaViewer",
            "i/bookmarks?post_id=:id"
        ],
        subdomains: ["mobile"],
        altDomains: ["x.com", "vxtwitter.com", "fixvx.com"],
    },
    youtube: {
        patterns: [
            "watch?v=:id",
            "embed/:id",
            "watch/:id",
            "v/:id"
        ],
        subdomains: ["music", "m"],
    },
};

Object.values(services).forEach(service => {
    service.patterns = service.patterns.map(
        pattern => new UrlPattern(pattern, {
            segmentValueCharset: UrlPattern.defaultOptions.segmentValueCharset + '@\\.:'
        })
    )
});

export const testers = {
    "bsky": pattern =>
        pattern.user?.length <= 128 && pattern.post?.length <= 128,

    "facebook": pattern =>
        pattern.shortLink?.length <= 11 ||
        pattern.username?.length <= 30 ||
        pattern.caption?.length <= 255 ||
        pattern.id?.length <= 20 && !pattern.shareType ||
        pattern.id?.length <= 20 && pattern.shareType?.length === 1 ||
        pattern.photoId?.length <= 100,

    "instagram": pattern =>
        pattern.postId?.length <= 48 ||
        pattern.shareId?.length <= 16 ||
        (pattern.username?.length <= 30 && pattern.storyId?.length <= 24),

    "pinterest": pattern =>
        pattern.id?.length <= 128 ||
        pattern.shortLink?.length <= 32,

    "snapchat": pattern =>
        (pattern.username?.length <= 32 && (!pattern.storyId || pattern.storyId?.length <= 255)) ||
        pattern.spotlightId?.length <= 255 ||
        pattern.shortLink?.length <= 16,

    "threads": pattern =>
        pattern.postId?.length <= 30,

    "tiktok": pattern =>
        pattern.postId?.length <= 21 ||
        pattern.shortLink?.length <= 21,

    "tumblr": pattern =>
        pattern.id?.length < 21 ||
        (pattern.id?.length < 21 && pattern.user?.length <= 32),

    "twitter": pattern =>
        pattern.id?.length < 20,

    "youtube": pattern =>
        pattern.id?.length <= 11,
};

const friendlyNames = {
    bsky: "bluesky",
};

export const friendlyServiceName = (service) =>
    service in friendlyNames ? friendlyNames[service] : service;

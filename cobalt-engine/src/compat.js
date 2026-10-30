// Compatibility shim so ported service code keeps its original shape.
//
// cobalt's services hand media URLs to a tunnel server through createStream().
// A library has no server, so a "stream" is just the origin URL itself: the
// caller fetches it directly, or proxies it if it needs to hide its IP.
//
// shortcut: alwaysProxy therefore only records intent, it cannot rewrite URLs.

export function createStream(obj) {
    const url = obj?.url;
    return Array.isArray(url) ? url[0] : url;
}

export function createProxyTunnels(info) {
    const urls = [info?.url].flat().filter(Boolean);
    if (info?.subtitles) urls.push(info.subtitles);
    if (info?.cover) urls.push(info.cover);
    return urls;
}

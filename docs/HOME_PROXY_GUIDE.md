# FeedBerry home proxy guide: Oracle + Android phone

Use a phone on home Wi-Fi to give **RSSHub's Instagram and Facebook requests** a residential public IP.
Everything else stays where it is:

```text
Oracle bot  -->  Oracle RSSHub  --[Tailscale]-->  phone Tinyproxy  -->  Instagram/Facebook
    |                 |
    |                 +--> all other RSSHub routes go direct
    +--> Telegram, native RSS, media downloads, Gemini and Telegraph go direct
```

This is the setup that was tested on Oracle Cloud, Tailscale, Termux and Tinyproxy. Follow it in order.
A first setup takes roughly 30–45 minutes, plus a phone reboot test.

## Read first

### What this fixes

- Scheduled public Instagram profile feeds.
- Scheduled public Facebook page feeds, where the page is accessible without a login.
- Datacenter-IP throttling for those RSSHub requests.

### What it does not fix

- Download Mode or single-post requests made by the bot itself.
- Private profiles, login-walled pages or followed-private accounts.
- Media CDN downloads and video extraction.
- Threads, even though Threads is owned by Meta: only `instagram.com` and `facebook.com` match.

This guide does **not** change bot code, `RSSHUB_BASE`, `sources.feed_url`, SQLite, Telegram polling or
Tailscale exit-node settings.

### Safety rules

- Never test with a primary personal Instagram or Facebook account.
- Prefer public pages and no cookies. If a login is unavoidable, use a dedicated secondary account.
- Stop immediately if Meta asks for a challenge or reports unusual activity.
- Never commit `.env`, paste the proxy password into logs/issues, or expose port `8888` on your router.
- Keep `.env` and its backups at mode `600`.
- Do not give the bot `HOME_PROXY_URI`. Compose explicitly clears it.
- Do not give the bot `INSTAGRAM_COOKIE` or `FACEBOOK_COOKIE`. Compose explicitly clears both.
- Do not restore a home-minted personal cookie to a bot that still requests Meta directly from Oracle.
- Do not configure Oracle to use the phone as a Tailscale exit node.

A residential IP reduces IP/session mismatch risk; it does not make automated collection risk-free or
override a platform's rules.

---

## 1. Prepare

### 1.1 Requirements

You need:

- A working FeedBerry deployment on an Oracle Ubuntu VM using Docker Compose, `apt` and `systemd`.
- SSH access to the VM and permission to use `sudo`.
- Docker Compose v2 with `up --wait` support.
- The repository's Node 24 bot image, whose `node:sqlite` support is used by the verification commands.
- The current RSSHub image, which includes Undici for the early container gate and `curl` for the
  post-preload checks.
- An Android phone connected to stable home Wi-Fi. No root access is required.
- Termux and Termux:Boot installed from F-Droid, not Google Play.
- The Tailscale app on the phone and Tailscale installed on Oracle.
- One Tailscale account signed in on both devices.
- The bot operator's Telegram account, so you can add a source, tap **Check now** and open `/status`.
- About 100 MB of free phone storage and a charger nearby.
- A text editor you know. Oracle examples use `nano`: save with `Ctrl+O`, Enter, then `Ctrl+X`.

If FeedBerry is not deployed yet, follow [HOSTING_GUIDE.md](HOSTING_GUIDE.md) first.

### 1.2 Write down these values

Do not put real passwords or personal network addresses into this document.

| Placeholder | Where to find it |
|---|---|
| `<ORACLE_PUBLIC_IP>` | Oracle Cloud VM's public IPv4 address |
| `<ORACLE_SSH_KEY>` | Path to your Oracle SSH private key |
| `<PHONE_TAILSCALE_IP>` | Tailscale app → phone details → IPv4 address (`100.x.y.z`) |
| `<ORACLE_TAILSCALE_IP>` | Oracle command: `tailscale ip -4` |
| `<HOME_PUBLIC_IP>` | Open `https://api.ipify.org` in a browser on home Wi-Fi |
| `<INSTAGRAM_USERNAME>` | A public account used only for testing, such as `nasa` |

You will generate `<PROXY_PASSWORD>` in section 3. Use the generated hexadecimal value; do not invent a
password containing URL-reserved characters.

### 1.3 Know where each command runs

- **Phone** means inside Termux on the Android phone.
- **Oracle** means in an SSH session on the VM.
- **Windows** means PowerShell or Git Bash on your computer.

Unless a block says otherwise, commands in sections 4–10 run on Oracle in `~/feedberry-bot`.

### 1.4 Check the existing deployment

On Oracle:

```bash
cd ~/feedberry-bot
docker compose version
docker compose ps
```

Expected: Compose v2 and healthy `bot` and `rsshub` services. Fix an unhealthy deployment before adding
the proxy.

---

## 2. Connect Tailscale

Skip any installation step that is already complete, but still verify the final state.

### 2.1 Phone

1. Open Tailscale and sign in.
2. Turn the VPN switch on.
3. Write down the phone's IPv4 address as `<PHONE_TAILSCALE_IP>`.
4. Enable **Always-on VPN** if your Android version offers it.
5. Do **not** select an exit node.

Expected: Tailscale shows a green connected indicator and the phone is using home Wi-Fi for normal
internet traffic.

### 2.2 Oracle

Install Tailscale only if `tailscale version` is not found:

```bash
curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale-install.sh
sh /tmp/tailscale-install.sh
sudo tailscale up
```

Open the printed login URL, sign in to the same account and approve the VM. Then run:

```bash
tailscale ip -4
tailscale status
```

Expected: one `100.x.y.z` address for Oracle and two connected devices in `tailscale status`. Save the
Oracle address as `<ORACLE_TAILSCALE_IP>`.

Verify Oracle is not using an exit node:

```bash
tailscale debug prefs | grep -E 'ExitNodeID|RouteAll'
```

Expected values:

```text
"ExitNodeID":""
"RouteAll":false
```

If either value differs, stop and fix Tailscale before continuing.

---

## 3. Set up Tinyproxy on the phone

Tinyproxy is a small forward proxy. HTTPS traffic travels through an encrypted `CONNECT` tunnel;
Tinyproxy does not decrypt the Instagram/Facebook page content.

### 3.1 Install packages

In Termux:

```sh
pkg update -y
pkg install -y tinyproxy openssl curl
tinyproxy -v
```

Expected: a Tinyproxy version number and no package error.

### 3.2 Generate the password

In Termux:

```sh
openssl rand -hex 16
```

Expected: exactly 32 hexadecimal characters. Save it as `<PROXY_PASSWORD>` in your password manager.
You will enter it twice: once in Tinyproxy and once in Oracle's `.env`.

Do not paste it into Telegram, an issue, a commit or a shared terminal transcript.

### 3.3 Create the configuration

In Termux, run this block. It prompts for the Oracle Tailscale IP and the new proxy password so neither
is stored in shell history:

```sh
read -rsp 'Oracle Tailscale IP (100.x.y.z): ' ORACLE_TAILSCALE_IP; echo
read -rsp 'New proxy password: ' PROXY_PASS; echo

mkdir -p "$HOME/.config"
cat > "$HOME/.config/tinyproxy.conf" <<EOF
Port 8888
Listen 0.0.0.0
Bind 0.0.0.0
Timeout 600
LogLevel Connect
MaxClients 20

Allow 127.0.0.1
Allow ${ORACLE_TAILSCALE_IP}

BasicAuth feedberry ${PROXY_PASS}

ConnectPort 443
EOF

chmod 600 "$HOME/.config/tinyproxy.conf"
unset ORACLE_TAILSCALE_IP PROXY_PASS
```

Check the settings without printing the password:

```sh
grep -E '^(Port|Listen|Bind|Allow|ConnectPort) ' "$HOME/.config/tinyproxy.conf"
```

Expected:

```text
Port 8888
Listen 0.0.0.0
Bind 0.0.0.0
Allow 127.0.0.1
Allow <ORACLE_TAILSCALE_IP>
ConnectPort 443
```

`Bind 0.0.0.0` forces IPv4 outbound connections. Do not remove it from this tested configuration.

These settings mean:

- Only localhost and Oracle's Tailscale IP may connect.
- A valid username and password are also required.
- Only HTTPS `CONNECT` tunnels to port `443` are allowed.
- Port `8888` must remain private. Do not add router port forwarding.

### 3.4 Start Tinyproxy

In Termux:

```sh
termux-wake-lock
nohup tinyproxy -d -c "$HOME/.config/tinyproxy.conf" >> "$HOME/home-proxy.log" 2>&1 &
sleep 2
pgrep -a tinyproxy
cat "$HOME/home-proxy.log"
```

Expected: one `tinyproxy -d -c ...` process and no fatal error. An empty log before the first connection
is normal.

### 3.5 Test from the phone

In Termux:

```sh
read -rsp 'Proxy password: ' PROXY_PASS; echo
curl -fsS --proxy "http://feedberry:${PROXY_PASS}@127.0.0.1:8888" https://api.ipify.org
unset PROXY_PASS
```

Expected: `<HOME_PUBLIC_IP>`.

Now prove that a wrong password is rejected:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  --proxy "http://feedberry:wrong-password@127.0.0.1:8888" \
  https://api.ipify.org
```

Expected:

```text
407
```

`407 Proxy Authentication Required` is the correct result. If the wrong password returns an IP instead,
stop: BasicAuth is not being enforced.

### 3.6 Keep it running after reboot

On the phone:

1. Open Android **Settings → Device care → Battery** (names vary by Android version).
2. Set Termux to **Unrestricted** battery usage.
3. Remove Termux, Termux:Boot and Tailscale from sleeping/deep-sleeping apps.
4. Disable Samsung's automatic daily optimization if it puts Termux back on the sleeping list.

Optional ADB Doze whitelist, with Developer options and USB debugging enabled on Windows:

```powershell
adb devices
adb shell dumpsys deviceidle whitelist +com.termux
adb shell dumpsys deviceidle whitelist +com.termux.boot
adb shell dumpsys deviceidle whitelist +com.tailscale.ipn
```

Expected: each command reports that the package was added. In Git Bash, prefix an `adb shell` command
with `MSYS_NO_PATHCONV=1` if MSYS rewrites Android paths.

Create the Termux:Boot script in Termux:

```sh
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-home-proxy.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
nohup tinyproxy -d -c "$HOME/.config/tinyproxy.conf" >> "$HOME/home-proxy.log" 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/start-home-proxy.sh"
```

Open the **Termux:Boot** app once from the Android launcher. Android requires this one-time launch before
boot scripts run.

Reboot the phone, reconnect Tailscale and confirm Tinyproxy starts. The required container-level reboot
test is in section 4.4; do not skip it.

---

## 4. Prove Oracle and Docker can reach the proxy

### 4.1 Connect to Oracle

From Windows:

```powershell
ssh -i "<ORACLE_SSH_KEY>" ubuntu@<ORACLE_PUBLIC_IP>
```

Expected: an Ubuntu shell prompt.

### 4.2 Compare Oracle's direct and proxied IPs

On Oracle:

```bash
curl -fsS https://api.ipify.org
```

Expected: Oracle's public IP, not `<HOME_PUBLIC_IP>`.

Then test the phone proxy:

```bash
read -rsp 'Home proxy password: ' PROXY_PASS; echo
curl -fsS --proxy "http://feedberry:${PROXY_PASS}@<PHONE_TAILSCALE_IP>:8888" https://api.ipify.org
unset PROXY_PASS
```

Expected: `<HOME_PUBLIC_IP>`.

Stop if this fails. Check Tailscale on both devices, home Wi-Fi, Tinyproxy, the password and Oracle's IP
in Tinyproxy's `Allow` list.

### 4.3 Hard gate: test from inside a container

A successful host test is not enough. RSSHub runs in Docker and must reach the same address. Use the
image's Node/Undici client for this early gate: the production CA-restoring preload is not installed until
section 5, so a stock `curl` HTTPS test can fail on a clean image before proxy routing is even tested.

```bash
cd ~/feedberry-bot
read -rsp 'Home proxy password: ' PROXY_PASS; echo
docker compose run --rm --no-deps --entrypoint node \
  -e PROXY_URI="http://feedberry:${PROXY_PASS}@<PHONE_TAILSCALE_IP>:8888" \
  rsshub --input-type=module -e '
import { fetch, ProxyAgent } from "undici";
const dispatcher = new ProxyAgent(process.env.PROXY_URI);
try {
  const response = await fetch("https://api.ipify.org", { dispatcher });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(await response.text());
} catch (error) {
  console.error("Proxy test failed:", error.cause?.message ?? error.message);
  process.exitCode = 1;
} finally {
  await dispatcher.close();
}
' < /dev/null
unset PROXY_PASS
```

Expected: `<HOME_PUBLIC_IP>`.

**Do not continue if this test fails.** If the Oracle-host test passed, use the Docker relay fallback in
section 10.2. Host Tailscale routing and container routing are not interchangeable.

### 4.4 Hard gate: repeat after the phone reboot

After section 3.6's reboot, confirm the phone is on home Wi-Fi, Tailscale is connected and Tinyproxy is
running. For a direct setup, repeat section 4.3. If you adopted the relay fallback in section 10.2, retest
the container's loaded `$PROXY_URI` with that section's gateway-based command instead.

Expected: the same `<HOME_PUBLIC_IP>`. A proxy that works only until the next reboot is not ready.

---

## 5. Configure Oracle and RSSHub

### 5.1 Back up the deployment

On Oracle:

```bash
cd ~/feedberry-bot
cp docker-compose.yml "$HOME/feedberry-compose.pre-home-proxy.yml"
cp .env "$HOME/feedberry.env.pre-home-proxy"
chmod 600 "$HOME/feedberry.env.pre-home-proxy"
```

Expected: no output. Keep the backup outside the repository because `.env` contains secrets.

### 5.2 Add the proxy settings to `.env`

```bash
nano .env
```

Add or update these lines, replacing both placeholders:

```dotenv
HOME_PROXY_URI=http://feedberry:<PROXY_PASSWORD>@<PHONE_TAILSCALE_IP>:8888
RSSHUB_LOG_LEVEL=info
```

Do not remove existing `INSTAGRAM_COOKIE` or `FACEBOOK_COOKIE` values yet if you are following the full
test-first sequence. They remain **RSSHub-only** because of the bot guards in section 5.4, and will be
cleared after sections 6 and 7 pass. A public-page setup can leave them empty from the beginning.

Save, exit and protect the file:

```bash
chmod 600 .env
```

Never print `.env` or `docker compose config` without `--quiet`; both can reveal the password.

### 5.3 Install the RSSHub startup preload

RSSHub's stock proxy selector does not cover every composed authentication dispatcher. The preload keeps
non-Meta traffic direct, preserves RSSHub's authentication interceptors, fails closed when the URL
boundary is missing, restores a missing Linux CA bundle and avoids dropping RSSHub's larger HTTP header
setting.

Create the file on Oracle:

```bash
mkdir -p rsshub-patches
cat > rsshub-patches/meta-only-proxy.mjs <<'EOF'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import tls from 'node:tls';
import undici from 'undici';

export function ensureCaBundle(filePath) {
    if (existsSync(filePath)) return;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, tls.rootCertificates.join('\n') + '\n', { mode: 0o644 });
}

if (process.platform === 'linux' && process.env.NODE_ENV === 'production') {
    ensureCaBundle('/etc/ssl/certs/ca-certificates.crt');
}

const proxyUri = process.env.PROXY_URI;
const proxyUrlRegex = process.env.PROXY_URL_REGEX;

if (proxyUri && !proxyUrlRegex) {
    throw new Error('PROXY_URL_REGEX is required when PROXY_URI is set');
}

if (proxyUri && proxyUrlRegex) {
    const allowedUrl = new RegExp(proxyUrlRegex);
    const directDispatcher = new undici.Agent();
    const proxyDispatch = undici.ProxyAgent.prototype.dispatch;

    undici.ProxyAgent.prototype.dispatch = function (opts, handler) {
        let origin;
        try {
            origin = new URL(opts?.origin);
        } catch {}

        allowedUrl.lastIndex = 0;
        if (!origin || !['http:', 'https:'].includes(origin.protocol) || !allowedUrl.test(origin.href)) {
            return directDispatcher.dispatch(opts, handler);
        }
        return proxyDispatch.call(this, opts, handler);
    };
}
EOF
```

Do not replace this file with only the three RSSHub environment variables. The preload is required for
the tested routing and fail-closed behavior.

### 5.4 Update `docker-compose.yml`

```bash
nano docker-compose.yml
```

Under the existing `bot.environment`, keep current settings and ensure these exact guards are present:

```yaml
      FACEBOOK_COOKIE: ""
      INSTAGRAM_COOKIE: ""
      HOME_PROXY_URI: ""
```

Under the existing `rsshub.environment`, add or update:

```yaml
      NODE_OPTIONS: --max-http-header-size=32768
      LOGGER_LEVEL: ${RSSHUB_LOG_LEVEL:-info}
      PROXY_URI: ${HOME_PROXY_URI:-}
      PROXY_URL_REGEX: '^https?://(?:[a-z0-9-]+\.)*(?:instagram\.com|facebook\.com)(?::[0-9]+)?(?:/|$)'
      PROXY_STRATEGY: all
```

Keep the existing RSSHub image, cache, cookies, healthcheck and network placement. If `LOGGER_LEVEL`
already exists, replace it rather than adding a duplicate YAML key.

Add or replace the RSSHub `command`:

```yaml
    command: ["sh", "-c", "exec node --import /app/rsshub-patches/meta-only-proxy.mjs dist/index.mjs"]
```

Add this read-only mount to the existing `rsshub.volumes` list:

```yaml
      - ./rsshub-patches:/app/rsshub-patches:ro
```

Do not change:

- `RSSHUB_BASE: http://rsshub:1200`
- `bot.depends_on.rsshub.condition: service_healthy`
- any source rows in SQLite

`PROXY_STRATEGY: all` is intentional. `on_retry` can send the first cookie-bearing request directly from
Oracle. The regex is also mandatory: RSSHub otherwise treats all URLs as proxy candidates.

### 5.5 Validate and start

```bash
docker compose config --quiet
docker compose up -d --wait rsshub
docker compose up -d --wait bot
docker compose ps
```

Expected: no Compose validation output, both services `Up`, and RSSHub `(healthy)`.

Inspect the loaded proxy settings without printing the password:

```bash
docker compose exec -T rsshub node -e "const v=process.env.PROXY_URI||'';let u=null;try{if(v)u=new URL(v)}catch{};console.log({configured:!!u,protocol:u?.protocol,host:u?.hostname,port:u?.port,regex:process.env.PROXY_URL_REGEX,strategy:process.env.PROXY_STRATEGY})"
```

Expected: `configured: true`, protocol `http:`, the phone Tailscale IP, port `8888`, the documented regex
and strategy `all`.

Confirm the guards:

```bash
docker compose exec -T rsshub node -e "console.log({nodeOptions:process.env.NODE_OPTIONS})"
docker compose exec -T bot node -e "console.log({instagramCookieSet:!!process.env.INSTAGRAM_COOKIE,facebookCookieSet:!!process.env.FACEBOOK_COOKIE,homeProxyUriSet:!!process.env.HOME_PROXY_URI})"
docker compose exec -T rsshub sh -c 'test -s /etc/ssl/certs/ca-certificates.crt && wc -c /etc/ssl/certs/ca-certificates.crt'
```

Expected:

```text
{ nodeOptions: '--max-http-header-size=32768' }
{ instagramCookieSet: false, facebookCookieSet: false, homeProxyUriSet: false }
```

The last command prints a positive CA bundle size. Do not continue if the bot reports any `true` value
or RSSHub does not have the header setting and CA bundle.

---

## 6. Prove that only Meta uses the residential IP

### 6.1 Compare direct and proxied egress inside RSSHub

```bash
docker compose exec -T rsshub sh -c 'curl -fsS https://api.ipify.org'
docker compose exec -T rsshub sh -c 'curl -fsS --proxy "$PROXY_URI" https://api.ipify.org'
```

Expected, in order:

1. Oracle's public IP.
2. `<HOME_PUBLIC_IP>`.

Record this result. It proves container reachability, proxy authentication and residential egress.

### 6.2 Enable debug logging temporarily

```bash
nano .env
```

Set:

```dotenv
RSSHUB_LOG_LEVEL=debug
```

Save, exit and recreate RSSHub:

```bash
docker compose up -d --wait --force-recreate rsshub
docker compose ps rsshub
```

Expected: RSSHub is healthy. Recreating it also clears the five-minute memory cache.

### 6.3 Request one public Meta route

Replace the username; do not use a primary personal account:

```bash
docker compose exec -T rsshub sh -c 'curl -sS -m 60 -o /tmp/instagram-response -w "HTTP %{http_code}\n" "http://127.0.0.1:1200/instagram/user/<INSTAGRAM_USERNAME>"'
docker compose exec -T rsshub sh -c 'head -c 200 /tmp/instagram-response; echo'
docker compose logs --since 3m rsshub | grep -E 'Proxying request|instagram\.com|facebook\.com'
```

Expected: a log line like:

```text
Proxying request: https://www.instagram.com/...
```

For the functional gate, the response must be HTTP `200` and its body must begin with `<?xml` or `<rss`.
A platform error can prove routing without producing a usable feed, but do not proceed to cookie removal
until section 7's public-source fetch succeeds. Stop if Meta asks for a challenge or reports unusual
activity.

If you use Facebook, test one public page once:

```bash
docker compose exec -T rsshub sh -c 'curl -sS -m 60 -o /tmp/facebook-response -w "HTTP %{http_code}\n" "http://127.0.0.1:1200/facebook/page/NASA"'
docker compose exec -T rsshub sh -c 'head -c 200 /tmp/facebook-response; echo'
docker compose logs --since 2m rsshub | grep -E 'Proxying request|facebook\.com'
```

Expected for the functional gate: HTTP `200`, a body beginning with `<?xml` or `<rss`, and a
`Proxying request: https://www.facebook.com/...` line. A platform error can prove routing without producing
a usable feed, but section 7's public-source fetch must still pass before cookie removal. Login-walled pages
may remain unavailable.

### 6.4 Prove a non-Meta route stays direct

```bash
docker compose exec -T rsshub sh -c 'curl -sS -m 60 -o /tmp/github-response -w "HTTP %{http_code}\n" "http://127.0.0.1:1200/github/issue/DIYgod/RSSHub"'
docker compose exec -T rsshub sh -c 'head -c 200 /tmp/github-response; echo'
docker compose logs --since 2m rsshub | grep -E 'github\.com|Proxying request' || true
```

Expected: HTTP `200`, a body beginning with `<?xml` or `<rss`, a `github.com` request log and no
`Proxying request` line for GitHub. If there is no GitHub request log, the route was cached or failed
before dispatch; do not count that as a routing pass. Recreate RSSHub to clear its cache and retry once.

### 6.5 Restore normal logging

```bash
nano .env
```

Set:

```dotenv
RSSHUB_LOG_LEVEL=info
```

Save, exit and run:

```bash
docker compose up -d --wait --force-recreate rsshub
docker compose ps
```

Expected: both services healthy and normal logging restored.

RSSHub uses `CACHE_TYPE: memory` and `CACHE_EXPIRE: "300"`. Repeated checks within five minutes may not
make an upstream request. Do not shorten FeedBerry's schedule just to force tests.

---

## 7. Validate Telegram and scheduled checks

### 7.1 Add a public source

In Telegram:

1. Open FeedBerry and send `https://www.instagram.com/<INSTAGRAM_USERNAME>/`.
2. Choose the destination chat and content options.
3. Choose **Add without sending** if you do not want a backfill.
4. Confirm **Add**.

Expected: the preview names the account and shows recent items. For Facebook, repeat with a public page
such as `https://www.facebook.com/NASA`.

### 7.2 Confirm source URLs did not change

On Oracle:

```bash
docker compose exec -T bot node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DB_PATH || "/data/bot.db");
console.log(db.prepare("SELECT id, platform, canonical_url, feed_url, last_error_code FROM sources WHERE platform IN (?, ?) ORDER BY id DESC LIMIT 10").all("instagram", "facebook"));
db.close();
'
```

Expected: `feed_url` starts with `http://rsshub:1200/`. It must not contain the phone Tailscale IP or
proxy credentials. Record the test source's numeric `id` as `<SOURCE_ID>`.

### 7.3 Run **Check now** and inspect `fetch_done`

In Telegram, open **My sources**, select the test source and tap **Check now**.

On Oracle:

```bash
docker compose logs -f --since 5m bot | grep -E 'fetch_done|fetch_fail|job_retry|job_failed'
```

Expected:

```json
{"code":"fetch_done","source":<SOURCE_ID>,"fresh":0,"delivered":0,"failed":0}
```

`fresh: 0` is normal when the preview already recorded the current items. A positive number means new
posts were found. Press `Ctrl+C` to stop following logs; the bot keeps running.

### 7.4 Inspect `fetch_ok` in SQLite

FeedBerry writes `fetch_ok` to the `events` table, not stdout. Run this block and enter the numeric source
ID from section 7.2 when prompted:

```bash
read -rsp 'Source ID: ' SOURCE_ID; echo
docker compose exec -T bot node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DB_PATH || "/data/bot.db");
const rows = db.prepare("SELECT code, source_id, detail, at FROM events WHERE source_id = ? ORDER BY at DESC LIMIT 10").all(Number(process.argv[1]));
console.log(rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() })));
db.close();
' "$SOURCE_ID"
```

Expected: a recent `fetch_ok` row, for example `detail: "0 new"`. Delivered items also produce `send_ok`
rows. `events.at` is already milliseconds since the Unix epoch; do not multiply it by 1000.

### 7.5 Confirm the scheduler path

The worker checks due subscriptions every 30 seconds. A new subscription starts without a next slot, so
the next tick should queue a scheduled fetch. Watch for another successful result:

```bash
docker compose logs -f --since 10m bot | grep -E 'fetch_done|fetch_fail|job_retry|job_failed'
```

Expected: another `fetch_done` with `failed: 0`.

`CHECKS_PER_HOUR` limits manual **Check now** actions; it is not the scheduled polling interval.

Sections 6 and 7 are mandatory gates. Do not remove test cookies until they pass.

---

## 8. Remove test cookies and run final checks

### 8.1 Understand what cookie removal disables

For the public-feed setup, both values become empty:

```dotenv
INSTAGRAM_COOKIE=
FACEBOOK_COOKIE=
```

This intentionally disables these **RSSHub** capabilities:

- Login-walled/private Facebook pages.
- Followed-private Instagram accounts.
- Facebook's logged-in GraphQL session and its rate-limit advantage.

The bot already has no Instagram/Facebook cookies under this Compose configuration, so this later cleanup
does not newly disable bot cobalt or Download Mode; those bot-side paths were never proxied or given the
RSSHub session. Some bot-side Instagram Download Mode and video cases therefore remain unavailable.

If you need the disabled RSSHub capabilities, stop here. Do not give a home-minted personal cookie to the
bot while it still requests Instagram directly from Oracle; design a separate residential egress path for
the bot.

### 8.2 Clear cookies and restart in order

```bash
nano .env
```

Set `INSTAGRAM_COOKIE=` and `FACEBOOK_COOKIE=`. Leave `HOME_PROXY_URI` configured and
`RSSHUB_LOG_LEVEL=info`. Save and exit.

```bash
chmod 600 .env
docker compose up -d --wait rsshub
docker compose ps rsshub
docker compose up -d --wait bot
docker compose ps
```

Expected: RSSHub loads first and is healthy; the bot restarts second; both services are healthy.

### 8.3 Confirm the final runtime state

```bash
docker compose exec -T rsshub sh -c 'printf "INSTAGRAM_COOKIE_set=%s\nFACEBOOK_COOKIE_set=%s\nPROXY_URI_set=%s\n" "$([ -n "$INSTAGRAM_COOKIE" ] && echo yes || echo no)" "$([ -n "$FACEBOOK_COOKIE" ] && echo yes || echo no)" "$([ -n "$PROXY_URI" ] && echo yes || echo no)"'
docker compose exec -T bot sh -c 'printf "INSTAGRAM_COOKIE_set=%s\nFACEBOOK_COOKIE_set=%s\nHOME_PROXY_URI_set=%s\n" "$([ -n "$INSTAGRAM_COOKIE" ] && echo yes || echo no)" "$([ -n "$FACEBOOK_COOKIE" ] && echo yes || echo no)" "$([ -n "$HOME_PROXY_URI" ] && echo yes || echo no)"'
docker compose exec -T rsshub sh -c 'curl -fsS --proxy "$PROXY_URI" https://api.ipify.org'
```

Expected:

```text
INSTAGRAM_COOKIE_set=no
FACEBOOK_COOKIE_set=no
PROXY_URI_set=yes
INSTAGRAM_COOKIE_set=no
FACEBOOK_COOKIE_set=no
HOME_PROXY_URI_set=no
```

The final line is `<HOME_PUBLIC_IP>`.

### 8.4 Regression checks

Run **Check now** once for each source you use:

| Source | Expected |
|---|---|
| Public Instagram | `fetch_done` with `failed: 0` |
| Public Facebook, if used | `fetch_done` with `failed: 0` |
| Native RSS/news site | `fetch_done` with `failed: 0` |
| Non-Meta RSSHub source | Normal behavior; no home-proxy request for that domain |

Open `/status` in the bot's admin DM. Expected: a healthy queue and no failing tested sources.

If a scheduled video arrives as a still or link, that is the documented media scope limit, not necessarily
a proxy failure.

---

## 9. Maintenance and reboot checklist

After a phone reboot, home-network change, Oracle redeploy or RSSHub image upgrade:

1. Confirm the phone is on home Wi-Fi and Tailscale shows both devices connected.
2. Confirm Tinyproxy is running: `pgrep -a tinyproxy` in Termux.
3. Repeat the container test in section 4.3 for a direct setup, or the loaded-`$PROXY_URI` test in section
   10.2 if you use the relay fallback.
4. Confirm RSSHub's direct IP is Oracle and its proxied IP is home.
5. Run **Check now** on one public Meta source and one native RSS source.
6. Confirm `RSSHUB_LOG_LEVEL=info`, empty Meta cookies in the bot and no bot `HOME_PROXY_URI`.
7. Keep `.env` and its backups at mode `600`.

A home ISP can change your public IP. Update `<HOME_PUBLIC_IP>` in your notes; no proxy configuration
change is needed unless the phone's Tailscale IP changes.

Do not run a monitor that repeatedly requests Instagram/Facebook. A twice-daily source can make failure
alerts slow, but aggressive retries can create the throttling you are trying to avoid.

---

## 10. Troubleshooting

### 10.1 Quick diagnosis table

| Symptom | Likely cause | Fix |
|---|---|---|
| `407 Proxy Authentication Required` | Password mismatch or BasicAuth missing | Correct the same password in Tinyproxy and `HOME_PROXY_URI`; restart Tinyproxy, then recreate RSSHub |
| Phone test returns the Oracle IP | Request bypassed the proxy | Check `--proxy`, `PROXY_URI`, port `8888` and the username `feedberry` |
| Proxy test times out | Tailscale disconnected, phone off Wi-Fi, Tinyproxy stopped or Oracle IP not allowed | Check section 3.3, `pgrep -a tinyproxy`, both Tailscale apps and Oracle's `Allow` entry |
| Oracle host works; container times out | Docker cannot route to the phone Tailscale address | Use section 10.2 |
| Proxy works before reboot, then fails | Termux:Boot not launched, battery optimization or Tailscale not connected | Open Termux:Boot once, apply unrestricted battery settings, reconnect Tailscale |
| Tinyproxy logs `CONNECT port not allowed` | Destination is not HTTPS port `443` | Keep `ConnectPort 443`; this setup intentionally allows HTTPS only |
| RSSHub exits with `PROXY_URL_REGEX is required` | Proxy URI exists without a URL boundary | Restore the exact regex in section 5.4; do not bypass the check |
| No `Proxying request` log | Logging is `info`, RSSHub was not recreated, proxy is empty or response was cached | Set `debug`, force-recreate RSSHub, inspect loaded values, retry once |
| All RSSHub routes use home | Regex was removed or widened | Restore the exact Meta-only regex and recreate RSSHub |
| Native RSS or X regresses | Non-Meta traffic is being proxied or Oracle is an exit node | Check the regex and `tailscale debug prefs`; roll back if needed |
| `unable to get local issuer certificate` | Production CA bundle is missing | Confirm the preload is mounted and started; verify `/etc/ssl/certs/ca-certificates.crt` exists |
| Authenticated X/Twitter requests fail | Preload missing or authentication dispatcher behavior changed | Restore the tested preload/command; do not remove the boundary patch |
| Large request headers fail | RSSHub's header limit was lost | Restore `NODE_OPTIONS: --max-http-header-size=32768` |
| Meta returns `401`/`403` | Private/login-walled page or platform challenge | Use a public page; stop on a challenge; do not add a primary personal cookie |
| Meta returns `429`/`503` | Throttling or temporary platform failure | Wait, do not shorten schedules, verify home egress and inspect logs |
| `fetch_ok` is missing but stdout looks healthy | Looking in the wrong place | Query SQLite `events` as in section 7.4 |
| New source works; old source fails | Old source has a stale/manual `feed_url` | Inspect it; do not bulk-edit SQLite without a backup |

Never fix a timeout by opening router port `8888`, setting a Tailscale exit node, broadening the regex or
turning `PROXY_STRATEGY` into `on_retry`.

### 10.2 Docker relay fallback

Use this only when the Oracle-host proxy test passes but the container test fails. It binds a TCP relay to
the Docker gateway, not the public interface. Tinyproxy still enforces BasicAuth.

On Oracle:

```bash
sudo apt update
sudo apt install -y socat
RSSHUB_CID=$(docker compose ps -q rsshub)
NETWORK=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$RSSHUB_CID")
GATEWAY=$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}')
printf 'Docker network: %s\nDocker gateway: %s\n' "$NETWORK" "$GATEWAY"
```

Stop if either value is empty. Then replace `<PHONE_TAILSCALE_IP>` and `<DOCKER_GATEWAY>` below:

```bash
sudo tee /etc/systemd/system/feedberry-proxy-relay.service >/dev/null <<EOF
[Unit]
Description=FeedBerry home proxy relay
After=docker.service network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:8888,bind=<DOCKER_GATEWAY>,fork,reuseaddr TCP:<PHONE_TAILSCALE_IP>:8888
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now feedberry-proxy-relay
systemctl --no-pager --full status feedberry-proxy-relay
```

Expected: `active (running)`.

Update `.env` to use the Docker gateway:

```dotenv
HOME_PROXY_URI=http://feedberry:<PROXY_PASSWORD>@<DOCKER_GATEWAY>:8888
```

Recreate RSSHub, then test the gateway-based `HOME_PROXY_URI` that the container actually loaded:

```bash
docker compose up -d --wait --force-recreate rsshub
docker compose exec -T rsshub sh -c 'curl -fsS --proxy "$PROXY_URI" https://api.ipify.org'
```

Expected: `<HOME_PUBLIC_IP>`. Do not reuse section 4.3's phone-address command for this retest.

If Docker recreates its network and the gateway changes, update both the relay service and `.env`.

### 10.3 Inspect failing sources

```bash
docker compose exec -T bot node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DB_PATH || "/data/bot.db");
console.log(db.prepare("SELECT id, platform, canonical_url, feed_url, last_error_code FROM sources WHERE last_error_code IS NOT NULL ORDER BY id DESC LIMIT 20").all());
db.close();
'
```

If `feed_url` does not start with `http://rsshub:1200/`, it came from an older deployment or a manual
override. Fix that source deliberately; do not bulk-edit SQLite without a backup.

### 10.4 Useful logs

```bash
docker compose logs --since 10m rsshub
docker compose logs --since 10m bot | grep -E 'fetch_done|fetch_fail|job_retry|job_failed'
cat "$HOME/home-proxy.log"  # on the phone in Termux
```

Tinyproxy's connect log can contain client addresses and destination hosts. Redact it before sharing.

---

## 11. Roll back

### 11.1 Quick rollback: send RSSHub direct again

```bash
nano .env
```

Set:

```dotenv
HOME_PROXY_URI=
INSTAGRAM_COOKIE=
FACEBOOK_COOKIE=
RSSHUB_LOG_LEVEL=info
```

Save, exit and run:

```bash
docker compose up -d --wait --force-recreate rsshub
docker compose up -d --wait bot
docker compose ps
docker compose exec -T rsshub sh -c 'printf "PROXY_URI_set=%s\n" "$([ -n "$PROXY_URI" ] && echo yes || echo no)"'
```

Expected: both services healthy and `PROXY_URI_set=no`. Native RSS, Telegram and other direct routes
should continue normally; Meta routes may fail again on Oracle's datacenter IP.

### 11.2 Permanent rollback

1. If you made no Compose customizations after the backup, save the current file and restore the backup:

   ```bash
   cp docker-compose.yml "$HOME/feedberry-compose.pre-rollback.yml"
   cp "$HOME/feedberry-compose.pre-home-proxy.yml" docker-compose.yml
   ```

   Otherwise, remove only the proxy settings, preload command/mount and debug setting from `rsshub`,
   preserving unrelated custom changes.
2. Keep `INSTAGRAM_COOKIE: ""` and `HOME_PROXY_URI: ""` in the bot unless you deliberately accept the
   direct-from-Oracle session risk.
3. Remove `HOME_PROXY_URI` and `RSSHUB_LOG_LEVEL` from `.env` if they were not present before; keep both
   Meta cookies empty for the public-page setup.
4. Validate and restart:

```bash
docker compose config --quiet
docker compose up -d --wait
```

5. Disable the optional relay if you created it:

```bash
sudo systemctl disable --now feedberry-proxy-relay
```

6. Stop the phone proxy and remove its boot script so it does not restart:

```sh
pkill tinyproxy
mv "$HOME/.termux/boot/start-home-proxy.sh" "$HOME/start-home-proxy.sh.disabled"
```

Keep `~/.config/tinyproxy.conf` at mode `600`, or delete it if you no longer need the credential.

Never restore home-minted personal Instagram/Facebook cookies to a direct-from-Oracle setup.

### 11.3 Router alternative

A router running Linux, Tinyproxy and Tailscale can replace the phone. Allow only Oracle's Tailscale IP,
require BasicAuth, allow only `CONNECT` port `443`, bind outbound IPv4 and use the router's Tailscale IP as
`<PHONE_TAILSCALE_IP>`. Skip Termux/Boot/Doze steps. Do not enable router port forwarding.

---

## 12. Final go-live checklist

- [ ] Tinyproxy requires BasicAuth and allows only localhost plus Oracle's Tailscale IP.
- [ ] No router port forwarding is enabled.
- [ ] Phone/router is on home Wi-Fi; neither device uses a Tailscale exit node.
- [ ] Tinyproxy starts after a phone reboot; the direct (§4.3) or relay (§10.2) container retest passes.
- [ ] RSSHub's direct IP is Oracle; its proxied IP is home.
- [ ] `PROXY_STRATEGY=all` and the exact Meta-only regex are loaded.
- [ ] The startup preload is mounted, and the bot has no proxy URI or Meta cookies.
- [ ] RSSHub retains its 32 KiB header setting and has a CA bundle.
- [ ] `RSSHUB_LOG_LEVEL` is back to `info`.
- [ ] `.env` and backups are mode `600`; Meta cookies are empty for public pages.
- [ ] Public Instagram and, if used, public Facebook pass `fetch_done` and `fetch_ok`.
- [ ] Native RSS and non-Meta RSSHub routes still pass.
- [ ] `RSSHUB_BASE` and stored `feed_url` values are unchanged.
- [ ] Download Mode, private-page and video limits are understood.
- [ ] Rollback steps are understood.

## References

- [RSSHub proxy configuration](https://rsshub-doc.pages.dev/en/install/#proxy-configurations)
- [RSSHub request wrapper](https://github.com/DIYgod/RSSHub/blob/master/lib/utils/request-rewriter/fetch.ts)
- [Tinyproxy](https://tinyproxy.github.io/)
- [Tinyproxy configuration](https://manpages.debian.org/testing/tinyproxy/tinyproxy.conf.5.en.html)
- [Termux Tinyproxy package](https://github.com/termux/termux-packages/tree/master/packages/tinyproxy)
- [Tailscale installation](https://tailscale.com/install)
- [Docker bridge networking](https://docs.docker.com/engine/network/drivers/bridge/)

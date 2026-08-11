/**
 * Amber VPN community-list relay.
 *
 * Purpose: lets EVERY app install (not just the admin's device) publish a
 * newly self-served SSH/VLESS account into the shared GitHub community
 * config -- without the app ever holding the real GitHub write-token.
 *
 * The app only ever knows RELAY_KEY (a plain shared secret, set below as a
 * Cloudflare secret, and copied into RelayPublisher.java in the app). If
 * someone decompiles the APK and finds RELAY_KEY, the worst they can do is
 * call THIS endpoint to add spam entries shaped like a community server --
 * they can never get real GitHub write access, delete the repo, or touch
 * anything else, because GH_TOKEN never leaves this Worker.
 *
 * --- Deploy steps (Cloudflare dashboard, no CLI needed) ---
 * 1. workers.cloudflare.com -> sign up / log in (free tier is enough).
 * 2. "Create" -> "Create Worker" -> give it any name -> "Deploy".
 * 3. Click "Edit code", delete the sample code, paste this whole file in,
 *    click "Deploy" again.
 * 4. Go to the Worker's "Settings" -> "Variables" -> "Add variable" (as
 *    "Secret", not plaintext) for each of:
 *      GH_TOKEN   = your fine-grained GitHub token (Contents: Read/write,
 *                   scoped to ONLY the myvpnnew repo)
 *      GH_OWNER   = noelrubio143
 *      GH_REPO    = myvpnnew
 *      GH_PATH    = update
 *      RELAY_KEY  = a long random string YOU make up (e.g. 40+ random
 *                   characters) -- this is what goes into the app, not
 *                   GH_TOKEN.
 * 5. Copy the Worker's URL (shown at the top, ends in ".workers.dev") and
 *    the RELAY_KEY you chose into RelayPublisher.java in the app.
 */

const MAX_ENTRIES = 300; // safety cap so the file can't grow forever from abuse/spam

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const relayKey = request.headers.get("X-Relay-Key");
    if (!relayKey || relayKey !== env.RELAY_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    const label = String(body.label || "").slice(0, 80).trim();
    const serverType = String(body.serverType || "").trim();
    if (!label || (serverType !== "ssh" && serverType !== "v2ray")) {
      return new Response("Missing/invalid label or serverType", { status: 400 });
    }

    const entry = { label, serverType, enabled: true };
    if (serverType === "ssh") {
      entry.host = String(body.host || "").slice(0, 200);
      entry.port = String(body.port || "").slice(0, 10);
      entry.username = String(body.username || "").slice(0, 100);
      entry.password = String(body.password || "").slice(0, 200);
      if (!entry.host || !entry.username || !entry.password) {
        return new Response("Missing SSH fields", { status: 400 });
      }
    } else {
      entry.v2rayLink = String(body.v2rayLink || "").slice(0, 2000);
      if (!entry.v2rayLink) {
        return new Response("Missing v2rayLink", { status: 400 });
      }
    }

    const apiUrl = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${env.GH_PATH}`;
    const ghHeaders = {
      "Authorization": `token ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "amber-vpn-relay",
    };

    const getResp = await fetch(apiUrl, { headers: ghHeaders });

    let sha = null;
    let root = { announcement: "", servers: [] };

    if (getResp.status === 200) {
      const meta = await getResp.json();
      sha = meta.sha;
      try {
        const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ""))));
        root = JSON.parse(decoded);
      } catch (e) {
        root = { announcement: "", servers: [] };
      }
      if (!Array.isArray(root.servers)) root.servers = [];
      if (typeof root.announcement !== "string") root.announcement = "";
    } else if (getResp.status !== 404) {
      return new Response("GitHub read failed: " + getResp.status, { status: 502 });
    }

    let replaced = false;
    for (let i = 0; i < root.servers.length; i++) {
      if (root.servers[i].label === label) {
        root.servers[i] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      root.servers.push(entry);
      // Drop the oldest entries if we've grown past the cap, instead of
      // growing the file forever.
      if (root.servers.length > MAX_ENTRIES) {
        root.servers = root.servers.slice(root.servers.length - MAX_ENTRIES);
      }
    }

    const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(root, null, 2))));

    const putBody = {
      message: (replaced ? "Update" : "Add") + " community entry: " + label,
      content: newContentB64,
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });

    if (!putResp.ok) {
      const t = await putResp.text();
      return new Response("GitHub commit failed: " + putResp.status + " " + t, { status: 502 });
    }

    return new Response("OK", { status: 200 });
  },
};

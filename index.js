import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json());

// =======================
// DISCORD CLIENT
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

await client.login(process.env.DISCORD_TOKEN);

// =======================
// SEGURIDAD BÁSICA (Wix -> Render)
// =======================
function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${process.env.BOT_API_KEY}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// =========================
// DISCORD OAUTH (WIX FLOW) - IMPERIAL (NO REFRESH)
// =========================
const OAUTH_HMAC_SECRET = process.env.OAUTH_HMAC_SECRET || "";

// ✅ OJO: esto YA NO es tu página Wix, es una página ligera en Render
// que manda postMessage al opener y se cierra sola.
const COMPLETE_URL =
  process.env.OAUTH_COMPLETE_URL ||
  "https://ataraxia-bot.onrender.com/oauth/discord/complete";

// Canonical message debe ser 1:1 idéntico en Wix/Render
function canonicalMsg({ discordId, username, global_name, ts, state }) {
  return [
    "ATARAXIA_OAUTH_V1",
    String(discordId || ""),
    String(username || ""),
    String(global_name || ""),
    String(ts || ""),
    String(state || ""),
  ].join("|");
}

function signDiscordReturn(payload) {
  if (!OAUTH_HMAC_SECRET) return "";
  const msg = canonicalMsg(payload);
  return crypto.createHmac("sha256", OAUTH_HMAC_SECRET).update(msg, "utf8").digest("hex");
}

app.get("/oauth/discord/start", (req, res) => {
  const state = "ATARAXIA_" + Date.now(); // state simple
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });

  return res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/oauth/discord/callback", async (req, res) => {
  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();

  if (!code) return res.status(400).send("No code");
  if (!state) return res.status(400).send("No state");

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData?.access_token) {
      console.error("OAuth token error:", tokenData);
      return res.status(401).send("OAuth token error");
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json();
    if (!user?.id) {
      console.error("Could not fetch user:", user);
      return res.status(500).send("Could not fetch Discord user");
    }

    const safeUser = {
      id: String(user.id),
      username: String(user.username || ""),
      global_name: String(user.global_name || ""),
      avatar: String(user.avatar || ""),
    };

    // ✅ ts EN SEGUNDOS para que Wix compare bien con nowSec()
    const ts = String(Math.floor(Date.now() / 1000));

    const sig = signDiscordReturn({
      discordId: safeUser.id,
      username: safeUser.username,
      global_name: safeUser.global_name,
      ts,
      state,
    });

    // ✅ En vez de volver a Wix y refrescar, vamos a una "completion page" en Render
    const params = new URLSearchParams({
      discordId: safeUser.id,
      username: safeUser.username,
      global_name: safeUser.global_name,
      avatar: safeUser.avatar,
      state,
      ts,
      sig,
    });

    return res.redirect(`${COMPLETE_URL}?${params.toString()}`);
  } catch (err) {
    console.error("OAuth error:", err);
    return res.status(500).send("OAuth error");
  }
});

// ✅ Completion page: manda mensaje al opener (iframe) y se cierra
app.get("/oauth/discord/complete", (req, res) => {
  const q = {
    discordId: String(req.query.discordId || ""),
    username: String(req.query.username || ""),
    global_name: String(req.query.global_name || ""),
    avatar: String(req.query.avatar || ""),
    state: String(req.query.state || ""),
    ts: String(req.query.ts || ""),
    sig: String(req.query.sig || ""),
  };

  // HTML minimalista
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Discord linked</title>
</head>
<body style="font-family:system-ui;background:#0b1020;color:#eaf0ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;max-width:520px;padding:20px;">
    <h2 style="margin:0 0 10px 0;">✅ Discord vinculado</h2>
    <p style="opacity:.75;margin:0 0 14px 0;">Puedes cerrar esta ventana. Regresando al formulario…</p>
    <script>
      (function(){
        var payload = {
          type: "discord:ok",
          discord: {
            id: ${JSON.stringify(q.discordId)},
            username: ${JSON.stringify(q.username)},
            global_name: ${JSON.stringify(q.global_name)},
            avatar: ${JSON.stringify(q.avatar)}
          },
          state: ${JSON.stringify(q.state)},
          ts: ${JSON.stringify(q.ts)},
          sig: ${JSON.stringify(q.sig)}
        };

        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, "*");
          }
        } catch (e) {}

        setTimeout(function(){ try { window.close(); } catch(e) {} }, 180);
      })();
    </script>
  </div>
</body>
</html>`);
});

// =========================
// ROLES SYNC (Wix -> Render)
// =========================
app.post("/roles/sync", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rolesAdd = [], rolesRemove = [] } = req.body || {};

    if (!guildId || !discordUserId) {
      return res.status(400).json({ ok: false, error: "Missing guildId/discordUserId" });
    }

    const guild = await client.guilds.fetch(String(guildId));
    if (!guild) return res.status(404).json({ ok: false, error: "Guild not found" });

    const member = await guild.members.fetch(String(discordUserId)).catch(() => null);
    if (!member) return res.status(404).json({ ok: false, error: "Member not found in guild" });

    const add = Array.isArray(rolesAdd) ? rolesAdd.map(String).filter(Boolean) : [];
    const rem = Array.isArray(rolesRemove) ? rolesRemove.map(String).filter(Boolean) : [];

    if (rem.length) await member.roles.remove(rem);
    if (add.length) await member.roles.add(add);

    return res.json({ ok: true, guildId, discordUserId, rolesAdd: add, rolesRemove: rem });
  } catch (err) {
    console.error("❌ roles/sync error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =========================
// RECLUTAMIENTO - POST A DISCORD (CON VERIFICACIÓN IMPERIAL EN RENDER)
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const {
      guildId,
      channelId,
      discordUserId,
      discordTag,
      answers,
      memberId,

      // imperial bundle
      oauth
    } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers || !oauth) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    // ✅ Verificación imperial aquí (para no depender de crypto en Wix)
    const { discordId, username, global_name, ts, state, sig } = oauth || {};
    if (!discordId || !ts || !state || !sig) {
      return res.status(400).json({ ok: false, error: "OAuth incomplete (missing discordId/ts/state/sig)" });
    }

    // bind
    if (String(discordId) !== String(discordUserId)) {
      return res.status(401).json({ ok: false, error: "OAuth discord mismatch" });
    }

    // TTL 5 min
    const now = Math.floor(Date.now() / 1000);
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) {
      return res.status(401).json({ ok: false, error: "OAuth bad ts" });
    }
    if (Math.abs(now - t) > (5 * 60 + 60)) { // 5m + 60s skew
      return res.status(401).json({ ok: false, error: "OAuth expired" });
    }

    const expected = signDiscordReturn({
      discordId: String(discordId),
      username: String(username || ""),
      global_name: String(global_name || ""),
      ts: String(ts),
      state: String(state),
    });

    const a = Buffer.from(String(expected), "hex");
    const b = Buffer.from(String(sig), "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: "OAuth invalid signature" });
    }

    // ✅ Post a Discord
    const channel = await client.channels.fetch(String(channelId));
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      "**Respuestas:**",
      `1️⃣ Tipo de gameplay: **${answers.gameplayType}**`,
      `2️⃣ Días por semana en eventos: **${answers.daysPerWeek}**`,
      `3️⃣ ¿Perder loot por el bien de la guild?: **${answers.loseLoot}**`,
      `4️⃣ ¿Ayudar a miembros más nuevos?: **${answers.helpNewbies}**`,
      `5️⃣ ¿Acepta jerarquía?: **${answers.acceptHierarchy}**`,
      `6️⃣ ¿Guilds grandes antes?: **${answers.bigGuilds}**`,
      `7️⃣ ¿Líder o ejecutor?: **${answers.leaderOrExecutor}**`,
      `8️⃣ ¿Seguir órdenes en PvP masivo?: **${answers.followOrdersMassPvp}**`,
      "",
      "🧠 **9) Si un líder toma una mala decisión:**",
      answers.badLeaderDecision,
      "",
      "🔥 **10) ¿Por qué deberíamos aceptarte?:**",
      answers.whyAccept,
      "",
      "📜 *Juramento aceptado*",
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });
    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error("❌ Recruitment error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =======================
// HEALTHCHECK
// =======================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ataraxia-bot" });
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));

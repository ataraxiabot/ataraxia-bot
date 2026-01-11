import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";

const app = express();
app.use(express.json());

// =======================
// DISCORD CLIENT (BOT)
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
  if (!process.env.BOT_API_KEY) {
    return res.status(500).json({ ok: false, error: "Missing BOT_API_KEY env in Render" });
  }
  if (authHeader !== `Bearer ${process.env.BOT_API_KEY}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function mustEnv(name, v) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// =========================
// DISCORD OAUTH (SIMPLE)
// - El iFrame abre popup a /oauth/discord/start
// - Render hace callback y termina en /oauth/discord/complete
// - /complete manda:
//    window.opener.postMessage({
//      type:"discord:ok",
//      discordId, username, global_name, avatar
//    }, "*");
// =========================

// Anti-CSRF básico por state (en memoria) con TTL
const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map(); // state -> createdAt

function newState() {
  const s = crypto.randomBytes(18).toString("hex");
  stateStore.set(s, Date.now());
  return s;
}

function consumeState(state) {
  const t = stateStore.get(state);
  stateStore.delete(state);
  if (!t) return false;
  return (Date.now() - t) <= STATE_TTL_MS;
}

// Opcional: limpieza periódica por si acaso
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of stateStore.entries()) {
    if (now - t > STATE_TTL_MS) stateStore.delete(k);
  }
}, 60_000).unref?.();

app.get("/oauth/discord/start", (req, res) => {
  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

    const state = newState();
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: "identify",
      state,
      prompt: "consent",
    });

    return res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
  } catch (e) {
    console.error("OAuth start error:", e);
    return res.status(500).send("OAuth start misconfigured");
  }
});

app.get("/oauth/discord/callback", async (req, res) => {
  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();

  if (!code) return res.status(400).send("No code");
  if (!state) return res.status(400).send("No state");

  // ✅ valida state (anti-CSRF)
  if (!consumeState(state)) {
    return res.status(401).send("Invalid/expired state");
  }

  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_CLIENT_SECRET", process.env.DISCORD_CLIENT_SECRET);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

    // Intercambio code -> access_token
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

    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData?.access_token) {
      console.error("OAuth token error:", tokenData);
      return res.status(401).send("OAuth token error");
    }

    // fetch user
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json().catch(() => ({}));
    if (!user?.id) {
      console.error("Could not fetch Discord user:", user);
      return res.status(500).send("Could not fetch Discord user");
    }

    const safe = {
      discordId: String(user.id),
      username: String(user.username || ""),
      global_name: String(user.global_name || ""),
      avatar: String(user.avatar || ""),
    };

    // Redirect a página de completion en Render (misma app)
    const params = new URLSearchParams({
      discordId: safe.discordId,
      username: safe.username,
      global_name: safe.global_name,
      avatar: safe.avatar,
    });

    return res.redirect(`/oauth/discord/complete?${params.toString()}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth error");
  }
});

// Página de completion: postMessage al opener y cierra
app.get("/oauth/discord/complete", (req, res) => {
  const q = {
    discordId: String(req.query.discordId || "").trim(),
    username: String(req.query.username || "").trim(),
    global_name: String(req.query.global_name || "").trim(),
    avatar: String(req.query.avatar || "").trim(),
  };

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
          discordId: ${JSON.stringify(q.discordId)},
          username: ${JSON.stringify(q.username)},
          global_name: ${JSON.stringify(q.global_name)},
          avatar: ${JSON.stringify(q.avatar)}
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
// RECLUTAMIENTO - POST A DISCORD
// (sin bundle imperial; ya confías en auth + discordUserId que trae Wix/iframe)
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const { guildId, channelId, discordUserId, discordTag, answers, memberId } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const channel = await client.channels.fetch(String(channelId));
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    // Oath
    const oathAccepted = !!answers.oathAccepted;
    const oathText = String(answers.oathText || "").trim();

    if (!oathAccepted) {
      return res.status(400).json({ ok: false, error: "Oath not accepted" });
    }

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      "**Respuestas:**",
      `1️⃣ Tipo de gameplay: **${answers.gameplayType || "—"}**`,
      `2️⃣ Días por semana en eventos: **${answers.daysPerWeek || "—"}**`,
      `3️⃣ ¿Perder loot por el bien de la guild?: **${answers.loseLoot || "—"}**`,
      `4️⃣ ¿Ayudar a miembros más nuevos?: **${answers.helpNewbies || "—"}**`,
      `5️⃣ ¿Acepta jerarquía?: **${answers.acceptHierarchy || "—"}**`,
      `6️⃣ ¿Guilds grandes antes?: **${answers.bigGuilds || "—"}**`,
      `7️⃣ ¿Líder o ejecutor?: **${answers.leaderOrExecutor || "—"}**`,
      `8️⃣ ¿Seguir órdenes en PvP masivo?: **${answers.followOrdersMassPvp || "—"}**`,
      "",
      "🧠 **9) Si un líder toma una mala decisión:**",
      String(answers.badLeaderDecision || "—"),
      "",
      "🔥 **10) ¿Por qué deberíamos aceptarte?:**",
      String(answers.whyAccept || "—"),
      "",
      "📜 **Juramento:**",
      oathText ? `✅ ${oathText}` : "✅ Juramento aceptado",
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

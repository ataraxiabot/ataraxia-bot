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
// DISCORD OAUTH (POPUP) - IMPERIAL
// =========================
const OAUTH_HMAC_SECRET = String(process.env.OAUTH_HMAC_SECRET || "");
if (!OAUTH_HMAC_SECRET) {
  console.warn("⚠️ OAUTH_HMAC_SECRET vacío. El verify imperial en Wix fallará.");
}

// Canonical string debe coincidir 1:1 con Wix backend
function canonicalMsg({ discordId, username, global_name, ts, state }) {
  return [
    "ATARAXIA_OAUTH_V1",
    String(discordId || ""),
    String(username || ""),
    String(global_name || ""),
    String(ts || ""),
    String(state || "")
  ].join("|");
}

function signHex(message) {
  return crypto.createHmac("sha256", OAUTH_HMAC_SECRET).update(message, "utf8").digest("hex");
}

app.get("/oauth/discord/start", (req, res) => {
  const state = "ATARAXIA_" + Date.now();

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI, // Debe apuntar a /oauth/discord/callback en Render
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
      id: String(user.id || ""),
      username: String(user.username || ""),
      global_name: String(user.global_name || ""),
      avatar: String(user.avatar || ""),
    };

    const ts = Math.floor(Date.now() / 1000); // SEGUNDOS (igual que Wix)
    const msg = canonicalMsg({
      discordId: safeUser.id,
      username: safeUser.username,
      global_name: safeUser.global_name,
      ts,
      state
    });
    const sig = OAUTH_HMAC_SECRET ? signHex(msg) : "";

    // ✅ POPUP result -> window.opener (el opener será el iFrame)
    // No refresca Wix.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Discord OK</title></head>
<body style="font-family:system-ui;background:#0b1020;color:#eaf0ff;display:grid;place-items:center;height:100vh;margin:0;">
  <div style="max-width:560px;padding:20px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(255,255,255,.04)">
    <div style="font-size:14px;opacity:.9;margin-bottom:10px">✅ Discord autorizado</div>
    <div style="font-size:12px;opacity:.7;margin-bottom:14px">Puedes cerrar esta ventana.</div>
    <button id="closeBtn" style="padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#eaf0ff;cursor:pointer">Cerrar</button>
  </div>

<script>
(function(){
  const payload = {
    type: "discord:ok",
    discord: {
      id: ${JSON.stringify(safeUser.id)},
      username: ${JSON.stringify(safeUser.username)},
      global_name: ${JSON.stringify(safeUser.global_name)},
      avatar: ${JSON.stringify(safeUser.avatar)}
    },
    state: ${JSON.stringify(state)},
    ts: ${JSON.stringify(String(ts))},
    sig: ${JSON.stringify(sig)}
  };

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, "*");
    }
  } catch(e) {}

  document.getElementById("closeBtn").addEventListener("click", () => window.close());
  setTimeout(() => { try { window.close(); } catch(e) {} }, 1200);
})();
</script>
</body>
</html>`);
  } catch (err) {
    console.error("OAuth error:", err);
    return res.status(500).send("OAuth error");
  }
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

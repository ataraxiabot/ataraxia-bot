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
// DISCORD OAUTH (WIX FLOW) - IMPERIAL ✅ FULL FIX
// =========================
const WIX_RETURN_URL =
  process.env.WIX_RETURN_URL ||
  "https://www.comunidad-ataraxia.com/registro-nuevos-miembros";

// Debe coincidir con Wix secret: IMPERIAL_OAUTH_HMAC_SECRET
const OAUTH_HMAC_SECRET = process.env.OAUTH_HMAC_SECRET || "";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * ✅ Firma HMAC SHA256 hex con el MISMO canonical message que Wix verifica:
 * Wix arma:
 *   ["ATARAXIA_OAUTH_V1", did, username, global_name, String(ts), state].join("|")
 */
function signDiscordReturn({ discordId, username, global_name, ts, state }) {
  if (!OAUTH_HMAC_SECRET) return "";

  const msg = [
    "ATARAXIA_OAUTH_V1",
    String(discordId || ""),
    String(username || ""),
    String(global_name || ""),
    String(ts || ""),
    String(state || ""),
  ].join("|");

  return crypto.createHmac("sha256", OAUTH_HMAC_SECRET).update(msg, "utf8").digest("hex");
}

function buildWixReturnUrl({ user, state }) {
  const ts = String(nowSec()); // ✅ segundos (Wix usa nowSec())

  const sig = signDiscordReturn({
    discordId: String(user.id || ""),
    username: String(user.username || ""),
    global_name: String(user.global_name || ""),
    ts,
    state: String(state || ""),
  });

  const params = new URLSearchParams({
    // ✅ tu frontend Wix hidrata con esto
    discord_ok: "1",

    // ✅ identidad
    discordId: String(user.id || ""),
    username: String(user.username || ""),
    global_name: String(user.global_name || ""),
    avatar: String(user.avatar || ""),

    // ✅ inputs para verify imperial en Wix
    state: String(state || ""),
    ts,
    sig,
  });

  return `${WIX_RETURN_URL}?${params.toString()}`;
}

app.get("/oauth/discord/start", (req, res) => {
  const state = "ATARAXIA_" + Date.now(); // ok (string estable)

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
      id: user.id,
      username: user.username || "",
      global_name: user.global_name || "",
      avatar: user.avatar || "",
    };

    // ✅ redirige a Wix con discord_ok=1 + state/ts/sig válidos para tu backend wix imperial
    return res.redirect(buildWixReturnUrl({ user: safeUser, state }));
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
    if (!member) {
      return res.status(404).json({ ok: false, error: "Member not found in guild" });
    }

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

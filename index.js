// =========================================================
// RENDER (index.js) - COMPLETO / BLINDADO
// Endpoints:
//   POST /oauth/start
//   POST /oauth/exchange
//   POST /recruitment/submit
//
// ENV (Render):
//   PORT
//   API_KEY
//   DISCORD_CLIENT_ID
//   DISCORD_CLIENT_SECRET
//   DISCORD_REDIRECT_URI   (https://www.comunidad-ataraxia.com/discord-callback)
//   DISCORD_BOT_TOKEN
//   DISCORD_GUILD_ID
// =========================================================
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || "");

const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || "");
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "");
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || "");

const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "");
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || "");

const OAUTH_SCOPE = "identify";

function requireApiKey(req, res, next) {
  try {
    const got = String(req.headers["x-api-key"] || "");
    if (!API_KEY) return res.status(500).json({ ok: false, error: "API_KEY_MISSING" });
    if (got !== API_KEY) return res.status(401).json({ ok: false, error: "INVALID_API_KEY" });
    next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "AUTH_MIDDLEWARE_FAILED" });
  }
}

function envMissing() {
  const miss = [];
  if (!DISCORD_CLIENT_ID) miss.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) miss.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) miss.push("DISCORD_REDIRECT_URI");
  if (!DISCORD_BOT_TOKEN) miss.push("DISCORD_BOT_TOKEN");
  if (!DISCORD_GUILD_ID) miss.push("DISCORD_GUILD_ID");
  if (!API_KEY) miss.push("API_KEY");
  return miss;
}

async function discordTokenExchange(code, redirectUri) {
  const body = new URLSearchParams();
  body.set("client_id", DISCORD_CLIENT_ID);
  body.set("client_secret", DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);

  const resp = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.access_token) {
    throw new Error(`token_exchange_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordGetMe(accessToken) {
  const resp = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`get_me_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordSendChannelMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`send_message_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordAddRole(guildId, userId, roleId) {
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });

  if (resp.status === 204) return true;

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`add_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

function safeText(v, max = 900) {
  const s = String(v || "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers }) {
  const a = answers || {};
  const lines = [];

  lines.push("🛡️ **Nueva Solicitud de Reclutamiento: Ataraxia**");
  lines.push("");
  lines.push(`• Discord: **${safeText(discordUsername || "Discord")}** (${safeText(discordId)})`);
  lines.push(`• Wix ownerId: ${safeText(ownerId)}`);
  lines.push("");
  lines.push("📌 **Datos base**");
  lines.push(`• Personaje: **${safeText(a.personaje)}**`);
  lines.push(`• Edad: **${safeText(a.edad)}**`);
  lines.push(`• Clase: **${safeText(a.clase)}**`);
  lines.push(`• Gameplay: **${safeText(a.gameplay)}**`);
  lines.push("");
  lines.push("⚔️ **Compromisos**");
  lines.push(`• ¿Perder loot por la guild?: **${safeText(a.perderLoot)}**`);
  lines.push(`• ¿Ayudar a nuevos?: **${safeText(a.ayudarNuevos)}**`);
  lines.push(`• ¿Guild grande?: **${safeText(a.guildGrande)}**`);
  lines.push(`• ¿Voz Discord?: **${safeText(a.vozDiscord)}**`);
  lines.push(`• ¿Acepta jerarquía?: **${safeText(a.jerarquia)}**`);
  lines.push("");
  lines.push("🧠 **Perfil**");
  lines.push(`• Otras guilds: ${safeText(a.otrasGuilds) || "—"}`);
  lines.push(`• Líder o ejecutor: ${safeText(a.liderOEjecutor) || "—"}`);
  lines.push(`• Seguir calls (PvP): ${safeText(a.seguirCalls) || "—"}`);
  lines.push("");
  lines.push("🗡️ **Criterio**");
  lines.push(`${safeText(a.malaDecision, 1200) || "—"}`);
  lines.push("");
  lines.push("👑 **Por qué Ataraxia debería reclutarte**");
  lines.push(`${safeText(a.porQue, 1200) || "—"}`);

  const content = lines.join("\n");
  return content.length > 1900 ? content.slice(0, 1900) + "\n…" : content;
}

app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: envMissing().length === 0, missing: envMissing() }));

app.post("/oauth/start", requireApiKey, async (_req, res) => {
  try {
    const missing = envMissing();
    if (missing.length) return res.status(500).json({ ok: false, error: "MISSING_ENV", missing });

    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: OAUTH_SCOPE,
      state,
      prompt: "consent",
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;
    return res.json({ ok: true, url, state });
  } catch (e) {
    console.error("OAUTH_START_ERROR:", e);
    return res.status(500).json({ ok: false, error: "OAUTH_START_FAILED" });
  }
});

app.post("/oauth/exchange", requireApiKey, async (req, res) => {
  try {
    const missing = envMissing();
    if (missing.length) return res.status(500).json({ ok: false, error: "MISSING_ENV", missing });

    const code = String(req.body?.code || "").trim();
    const redirectUri = String(req.body?.redirect_uri || DISCORD_REDIRECT_URI).trim();
    if (!code) return res.status(400).json({ ok: false, error: "MISSING_CODE" });
    if (!redirectUri) return res.status(400).json({ ok: false, error: "MISSING_REDIRECT_URI" });

    const token = await discordTokenExchange(code, redirectUri);
    const me = await discordGetMe(token.access_token);

    const discordId = me.id;
    const discordUsername = me.global_name || me.username || "Discord";
    const discordTag =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username}#${me.discriminator}`
        : me.username;

    return res.json({ ok: true, discordId, discordUsername, discordTag });
  } catch (e) {
    console.error("OAUTH_EXCHANGE_ERROR:", e);
    return res.status(500).json({ ok: false, error: "OAUTH_EXCHANGE_FAILED" });
  }
});

app.post("/recruitment/submit", requireApiKey, async (req, res) => {
  try {
    const missing = envMissing();
    if (missing.length) return res.status(500).json({ ok: false, error: "MISSING_ENV", missing });

    const discordId = String(req.body?.discordId || "").trim();
    const discordUsername = String(req.body?.discordUsername || "").trim();
    const ownerId = String(req.body?.ownerId || "").trim();
    const answers = req.body?.answers || {};

    const channelId = String(req.body?.channelId || "").trim();
    const roleId = String(req.body?.roleId || "").trim();

    if (!discordId) return res.status(400).json({ ok: false, error: "MISSING_DISCORD_ID" });
    if (!channelId) return res.status(400).json({ ok: false, error: "MISSING_CHANNEL_ID" });
    if (!roleId) return res.status(400).json({ ok: false, error: "MISSING_ROLE_ID" });
    if (!answers?.personaje || !answers?.clase) return res.status(400).json({ ok: false, error: "MISSING_REQUIRED_ANSWERS" });

    const content = buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers });
    await discordSendChannelMessage(channelId, content);

    let roleAssigned = false;
    try {
      await discordAddRole(DISCORD_GUILD_ID, discordId, roleId);
      roleAssigned = true;
    } catch (e) {
      roleAssigned = false; // si no está en el server, no tiramos todo
    }

    return res.json({ ok: true, posted: true, roleAssigned });
  } catch (e) {
    console.error("RECRUITMENT_SUBMIT_ERROR:", e);
    return res.status(500).json({ ok: false, error: "RECRUITMENT_SUBMIT_FAILED" });
  }
});

app.listen(PORT, () => console.log("Ataraxia Render API on", PORT));

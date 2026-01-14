// =========================================================
// RENDER (index.js) - COMPLETO / ROBUSTO / COMPATIBLE
//
// ✅ ENV esperadas (según tu setup):
//   BOT_API_KEY
//   DISCORD_CLIENT_ID
//   DISCORD_CLIENT_SECRET
//   DISCORD_REDIRECT_URI          (ej: https://ataraxia-bot.onrender.com/oauth/discord/callback)
//   DISCORD_TOKEN                 (token del bot)
//   RECRUIT_CHANNEL_ID
//   WIX_RETURN_URL                (ej: https://www.comunidad-ataraxia.com/registro-nuevos-miembros)
//
// ✅ Rutas (y alias):
//   POST /oauth/start
//   POST /oauth/discord/start          (alias)
//   POST /oauth/exchange
//   POST /oauth/discord/exchange       (alias)
//   POST /recruitment/submit
//   POST /oauth/discord/submit         (alias)
//   GET  /oauth/discord/callback       (redirect de Discord) -> redirige a WIX_RETURN_URL con ?code&state
//
// ✅ Fixes clave:
// - Manejo correcto de invalid_grant (400/409, NO 500)
// - Anti doble-canje del code (TTL in-memory)
// - Token exchange form-urlencoded correcto
// =========================================================

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ===== ENV =====
const BOT_API_KEY = String(process.env.BOT_API_KEY || "");
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || "");
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "");
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || "");
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || "");
const RECRUIT_CHANNEL_ID = String(process.env.RECRUIT_CHANNEL_ID || "");
const WIX_RETURN_URL = String(process.env.WIX_RETURN_URL || "");

// Opcionales
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || ""); // si quieres asignar roles
const DEFAULT_SCOPE = "identify";

// ===== Utils ENV =====
function missingEnv() {
  const miss = [];
  if (!BOT_API_KEY) miss.push("BOT_API_KEY");
  if (!DISCORD_CLIENT_ID) miss.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) miss.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) miss.push("DISCORD_REDIRECT_URI");
  if (!DISCORD_TOKEN) miss.push("DISCORD_TOKEN");
  if (!RECRUIT_CHANNEL_ID) miss.push("RECRUIT_CHANNEL_ID");
  if (!WIX_RETURN_URL) miss.push("WIX_RETURN_URL");
  return miss;
}

function requireApiKey(req, res, next) {
  try {
    const got = String(req.headers["x-api-key"] || "");
    if (!BOT_API_KEY) return res.status(500).json({ ok: false, error: "BOT_API_KEY_MISSING" });
    if (got !== BOT_API_KEY) return res.status(401).json({ ok: false, error: "INVALID_API_KEY" });
    return next();
  } catch (_e) {
    return res.status(500).json({ ok: false, error: "AUTH_MIDDLEWARE_FAILED" });
  }
}

function jsonOk(extra = {}) {
  return { ok: true, ...extra };
}
function jsonFail(error, details) {
  const out = { ok: false, error: String(error || "UNKNOWN") };
  if (details !== undefined) out.details = details;
  return out;
}

// ===== Anti doble exchange (TTL simple en memoria) =====
const USED_CODES = new Map(); // code -> timestamp
const CODE_TTL_MS = 5 * 60 * 1000; // 5 min

function markCodeUsed(code) {
  const now = Date.now();
  USED_CODES.set(code, now);

  // limpieza ligera
  for (const [k, t] of USED_CODES) {
    if (now - t > CODE_TTL_MS) USED_CODES.delete(k);
  }
}
function wasCodeUsed(code) {
  const t = USED_CODES.get(code);
  if (!t) return false;
  if (Date.now() - t > CODE_TTL_MS) {
    USED_CODES.delete(code);
    return false;
  }
  return true;
}

// ===== Discord OAuth =====
async function discordTokenExchange(code) {
  const body = new URLSearchParams();
  body.set("client_id", DISCORD_CLIENT_ID);
  body.set("client_secret", DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", DISCORD_REDIRECT_URI);

  const resp = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const txt = await resp.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch (_) {}

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
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`get_me_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordSendChannelMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  const txt = await resp.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch (_) {}

  if (!resp.ok || !data?.id) {
    throw new Error(`send_message_failed:${resp.status}:${txt}`);
  }
  return data;
}

async function discordAddRole(guildId, userId, roleId) {
  if (!guildId) return false;
  const resp = await fetch(
    `https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    }
  );
  if (resp.status === 204) return true;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`add_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

// ===== Helpers de mensaje =====
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

// ===== Health =====
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: missingEnv().length === 0, missing: missingEnv() })
);

// =========================================================
// ✅ DISCORD REDIRECT (Render) -> regresa a Wix con ?code&state
// =========================================================
app.get("/oauth/discord/callback", (req, res) => {
  try {
    const q = req.query || {};
    const code = String(q.code || "").trim();
    const state = String(q.state || "").trim();
    const error = String(q.error || "").trim();
    const error_description = String(q.error_description || "").trim();

    const params = [];
    if (code) params.push(`code=${encodeURIComponent(code)}`);
    if (state) params.push(`state=${encodeURIComponent(state)}`);
    if (error) params.push(`error=${encodeURIComponent(error)}`);
    if (error_description) params.push(`error_description=${encodeURIComponent(error_description)}`);

    const target =
      `${WIX_RETURN_URL}` +
      (params.length ? (WIX_RETURN_URL.includes("?") ? "&" : "?") + params.join("&") : "");

    return res.redirect(302, target);
  } catch (_e) {
    return res.status(500).send("callback_failed");
  }
});

// =========================================================
// OAUTH START (y alias)
// =========================================================
async function handleOauthStart(_req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: DEFAULT_SCOPE,
      state,
      prompt: "consent",
    });

    const url = `https://discord.com/oauth2/authorize?${params.toString()}`;
    return res.json(jsonOk({ url, state }));
  } catch (e) {
    console.error("OAUTH_START_ERROR:", e);
    return res.status(500).json(jsonFail("OAUTH_START_FAILED"));
  }
}

app.post("/oauth/start", requireApiKey, handleOauthStart);
app.post("/oauth/discord/start", requireApiKey, handleOauthStart);

// =========================================================
// OAUTH EXCHANGE (y alias) - FIX invalid_grant + doble canje
// =========================================================
async function handleOauthExchange(req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const code = String(req.body?.code || "").trim();
    if (!code) return res.status(400).json(jsonFail("MISSING_CODE"));

    // ✅ doble intento = 409
    if (wasCodeUsed(code)) {
      return res
        .status(409)
        .json(jsonFail("CODE_ALREADY_USED", "Este code ya fue canjeado (doble click/doble callback)."));
    }

    let token, me;
    try {
      token = await discordTokenExchange(code);
      me = await discordGetMe(token.access_token);
    } catch (e) {
      const msg = String(e?.message || e);

      // ✅ invalid_grant = 400 (no 500)
      if (msg.includes("invalid_grant")) {
        markCodeUsed(code);
        return res.status(400).json(jsonFail("OAUTH_INVALID_GRANT", msg));
      }

      return res.status(502).json(jsonFail("OAUTH_PROVIDER_ERROR", msg));
    }

    // ✅ code gastado
    markCodeUsed(code);

    const discordId = me.id;
    const discordUsername = me.global_name || me.username || "Discord";
    const discordTag =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username}#${me.discriminator}`
        : me.username;

    return res.json(jsonOk({ discordId, discordUsername, discordTag }));
  } catch (e) {
    console.error("OAUTH_EXCHANGE_ERROR:", e);
    return res.status(500).json(jsonFail("OAUTH_EXCHANGE_FAILED", String(e?.message || e)));
  }
}

app.post("/oauth/exchange", requireApiKey, handleOauthExchange);
app.post("/oauth/discord/exchange", requireApiKey, handleOauthExchange);

// =========================================================
// RECRUITMENT SUBMIT (y alias)
// =========================================================
async function handleRecruitmentSubmit(req, res) {
  try {
    const miss = missingEnv();
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const discordId = String(req.body?.discordId || "").trim();
    const discordUsername = String(req.body?.discordUsername || "").trim();
    const ownerId = String(req.body?.ownerId || "").trim();
    const answers = req.body?.answers || {};

    const roleId = String(req.body?.roleId || "").trim(); // opcional desde Wix
    const channelId = String(req.body?.channelId || "").trim() || RECRUIT_CHANNEL_ID;

    if (!discordId) return res.status(400).json(jsonFail("MISSING_DISCORD_ID"));
    if (!channelId) return res.status(400).json(jsonFail("MISSING_CHANNEL_ID"));
    if (!answers?.personaje || !answers?.clase)
      return res.status(400).json(jsonFail("MISSING_REQUIRED_ANSWERS"));

    const content = buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers });
    await discordSendChannelMessage(channelId, content);

    let roleAssigned = false;
    if (roleId) {
      try {
        await discordAddRole(DISCORD_GUILD_ID, discordId, roleId);
        roleAssigned = true;
      } catch (_e) {
        roleAssigned = false;
      }
    }

    return res.json(jsonOk({ posted: true, roleAssigned }));
  } catch (e) {
    console.error("RECRUITMENT_SUBMIT_ERROR:", e);
    return res.status(500).json(jsonFail("RECRUITMENT_SUBMIT_FAILED", String(e?.message || e)));
  }
}

app.post("/recruitment/submit", requireApiKey, handleRecruitmentSubmit);
app.post("/oauth/discord/submit", requireApiKey, handleRecruitmentSubmit);

// ===== Start =====
app.listen(PORT, () => console.log("Ataraxia Render API on", PORT));

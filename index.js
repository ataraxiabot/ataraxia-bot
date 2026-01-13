// =========================================================
// RENDER (index.js) - COMPLETO / MISMA ARQUITECTURA (Express + fetch)
// ✅ NO mete discord.js, NO rompe tu OAuth/registro.
// ✅ Agrega SOLO lo necesario para que funcione #HTML3:
//    POST /guild/set-rank
//    POST /guild/grant
//    POST /guild/kick
//
// OJO:
// - Quité el bloque duplicado que pegaste (re-declaraba requireApiKey y tenía app.listen antes).
// - Todo queda ANTES de app.listen.
// =========================================================

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// ===== ENV (NOMBRES SEGÚN TU SCREENSHOT) =====
const BOT_API_KEY = String(process.env.BOT_API_KEY || "");
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || "");
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || "");
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || "");
const DISCORD_TOKEN = String(process.env.DISCORD_TOKEN || "");
const RECRUIT_CHANNEL_ID = String(process.env.RECRUIT_CHANNEL_ID || "");
const WIX_RETURN_URL = String(process.env.WIX_RETURN_URL || "");

// ✅ IMPORTANTE para #HTML3 (roles / kick): NECESITAS TU GUILD ID
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || "");

const DEFAULT_SCOPE = "identify";

// ===== ROLES (IDS confirmados por ti) =====
const ROLE_IDS = {
  // Ajusta/añade los que uses. Estos dos los diste tú:
  miembro: "1279577361922396281",
  capitan: "1226256057471602708",
  capitán: "1226256057471602708",

  // Si tienes otros rangos, ponlos aquí:
  // aspirante: "1226682948233990205",
};

// Roles de rango para remover antes de asignar el nuevo
const RANK_ROLE_IDS = new Set(Object.values(ROLE_IDS));

// =========================
// ENV VALIDATION
// =========================
function missingEnv() {
  const miss = [];
  if (!BOT_API_KEY) miss.push("BOT_API_KEY");
  if (!DISCORD_CLIENT_ID) miss.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) miss.push("DISCORD_CLIENT_SECRET");
  if (!DISCORD_REDIRECT_URI) miss.push("DISCORD_REDIRECT_URI");
  if (!DISCORD_TOKEN) miss.push("DISCORD_TOKEN");
  if (!RECRUIT_CHANNEL_ID) miss.push("RECRUIT_CHANNEL_ID");
  if (!WIX_RETURN_URL) miss.push("WIX_RETURN_URL");
  // Para #HTML3:
  if (!DISCORD_GUILD_ID) miss.push("DISCORD_GUILD_ID");
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

// =========================
// DISCORD HELPERS (REST)
// =========================
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
      Authorization: `Bot ${DISCORD_TOKEN}`,
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
  if (!guildId) throw new Error("DISCORD_GUILD_ID missing");
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (resp.status === 204) return true;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`add_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

async function discordRemoveRole(guildId, userId, roleId) {
  if (!guildId) throw new Error("DISCORD_GUILD_ID missing");
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "DELETE",
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
  });
  if (resp.status === 204) return true;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`remove_role_failed:${resp.status}:${txt}`);
  }
  return true;
}

async function discordKickMember(guildId, userId, reason) {
  if (!guildId) throw new Error("DISCORD_GUILD_ID missing");
  const resp = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "X-Audit-Log-Reason": encodeURIComponent(String(reason || "Expulsado por administración.").slice(0, 180)),
    },
  });
  if (resp.status === 204) return true;
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`kick_failed:${resp.status}:${txt}`);
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

// =========================
// HEALTH
// =========================
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: missingEnv().length === 0, missing: missingEnv() }));

// =========================================================
// ✅ DISCORD REDIRECT ACTUAL (Render)
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

    const target = `${WIX_RETURN_URL}${params.length ? (WIX_RETURN_URL.includes("?") ? "&" : "?") + params.join("&") : ""}`;
    return res.redirect(302, target);
  } catch (_e) {
    return res.status(500).send("callback_failed");
  }
});

// =========================================================
// OAUTH START
// =========================================================
async function handleOauthStart(_req, res) {
  try {
    const miss = missingEnv().filter(x =>
      // para START/EXCHANGE no exigimos DISCORD_GUILD_ID; solo para /guild/*
      x !== "DISCORD_GUILD_ID"
    );
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
// OAUTH EXCHANGE
// =========================================================
async function handleOauthExchange(req, res) {
  try {
    const miss = missingEnv().filter(x => x !== "DISCORD_GUILD_ID");
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const code = String(req.body?.code || "").trim();
    if (!code) return res.status(400).json(jsonFail("MISSING_CODE"));

    const token = await discordTokenExchange(code);
    const me = await discordGetMe(token.access_token);

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
// RECRUITMENT SUBMIT
// =========================================================
async function handleRecruitmentSubmit(req, res) {
  try {
    const miss = missingEnv().filter(x => x !== "DISCORD_GUILD_ID");
    if (miss.length) return res.status(500).json(jsonFail("MISSING_ENV", miss));

    const discordId = String(req.body?.discordId || "").trim();
    const discordUsername = String(req.body?.discordUsername || "").trim();
    const ownerId = String(req.body?.ownerId || "").trim();
    const answers = req.body?.answers || {};

    const roleId = String(req.body?.roleId || "").trim();
    const channelId = String(req.body?.channelId || "").trim() || RECRUIT_CHANNEL_ID;

    if (!discordId) return res.status(400).json(jsonFail("MISSING_DISCORD_ID"));
    if (!channelId) return res.status(400).json(jsonFail("MISSING_CHANNEL_ID"));
    if (!answers?.personaje || !answers?.clase) return res.status(400).json(jsonFail("MISSING_REQUIRED_ANSWERS"));

    const content = buildRecruitmentMessage({ discordId, discordUsername, ownerId, answers });
    await discordSendChannelMessage(channelId, content);

    let roleAssigned = false;
    if (roleId && DISCORD_GUILD_ID) {
      try {
        await discordAddRole(DISCORD_GUILD_ID, discordId, roleId);
        roleAssigned = true;
      } catch (_) {
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

// =========================================================
// ✅ NUEVO: ENDPOINTS PARA #HTML3 (ADMIN PANEL)
// =========================================================

// 1) SET RANK -> quita roles de rango previos y agrega el nuevo
app.post("/guild/set-rank", requireApiKey, async (req, res) => {
  try {
    const { discordId, newRank, roleId } = req.body || {};
    const uid = String(discordId || "").trim();
    const rank = String(newRank || "").trim().toLowerCase();
    const finalRoleId = String(roleId || ROLE_IDS[rank] || "").trim();

    if (!DISCORD_GUILD_ID) return res.status(500).json(jsonFail("MISSING_ENV", ["DISCORD_GUILD_ID"]));
    if (!uid) return res.status(400).json(jsonFail("MISSING_DISCORD_ID"));
    if (!rank) return res.status(400).json(jsonFail("MISSING_NEW_RANK"));

    // Remover roles de rango conocidos
    for (const rid of RANK_ROLE_IDS) {
      try {
        await discordRemoveRole(DISCORD_GUILD_ID, uid, rid);
      } catch (_) {
        // si no tenía el rol, Discord puede responder error; lo ignoramos
      }
    }

    // Agregar rol nuevo si existe mapeo
    if (!finalRoleId) {
      return res.json(jsonOk({ skipped: true, reason: "NO_ROLE_MAPPING_FOR_RANK", discordId: uid, newRank: rank }));
    }

    await discordAddRole(DISCORD_GUILD_ID, uid, finalRoleId);
    return res.json(jsonOk({ discordId: uid, newRank: rank, roleId: finalRoleId }));
  } catch (e) {
    return res.status(400).json(jsonFail("SET_RANK_FAILED", String(e?.message || e)));
  }
});

// 2) GRANT -> opcional (solo devuelve ok; el update real de XP/Zenirios ya lo hace Wix)
// Si quieres, aquí puedes mandar log a un canal de administración.
app.post("/guild/grant", requireApiKey, async (req, res) => {
  try {
    const { discordId, deltaZenirios, deltaXp, newTotals } = req.body || {};
    return res.json(jsonOk({ discordId, deltaZenirios, deltaXp, newTotals, announced: false }));
  } catch (e) {
    return res.status(400).json(jsonFail("GRANT_FAILED", String(e?.message || e)));
  }
});

// 3) KICK -> expulsa del servidor
app.post("/guild/kick", requireApiKey, async (req, res) => {
  try {
    const { discordId, reason } = req.body || {};
    const uid = String(discordId || "").trim();
    if (!DISCORD_GUILD_ID) return res.status(500).json(jsonFail("MISSING_ENV", ["DISCORD_GUILD_ID"]));
    if (!uid) return res.status(400).json(jsonFail("MISSING_DISCORD_ID"));

    await discordKickMember(DISCORD_GUILD_ID, uid, reason);
    return res.json(jsonOk({ discordId: uid, kicked: true }));
  } catch (e) {
    return res.status(400).json(jsonFail("KICK_FAILED", String(e?.message || e)));
  }
});

// =========================
// LISTEN (ÚNICO)
// =========================
app.listen(PORT, () => console.log("Ataraxia Render API on", PORT));

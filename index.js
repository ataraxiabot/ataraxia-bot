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
// HELPERS
// =======================
function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
  return String(val);
}

// =======================
// AUTH (Wix -> Render)
// =======================
function auth(req, res, next) {
  const got = String(req.headers.authorization || "").trim();
  const key = String(process.env.BOT_API_KEY || "").trim();

  if (!key) {
    console.error("❌ BOT_API_KEY missing in Render env");
    return res.status(500).json({ ok: false, error: "Server misconfigured" });
  }

  const expected = `Bearer ${key}`;

  if (got !== expected) {
    console.error("❌ AUTH FAIL", { got, expected });
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  next();
}


// =========================
// DISCORD OAUTH (optional)
// =========================
const STATE_TTL_MS = 10 * 60 * 1000;
const stateStore = new Map();
const returnUrlStore = new Map();

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

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of stateStore.entries()) {
    if (now - t > STATE_TTL_MS) stateStore.delete(k);
  }
  for (const [k] of returnUrlStore.entries()) {
    if (!stateStore.has(k)) returnUrlStore.delete(k);
  }
}, 60_000).unref?.();

app.get("/oauth/discord/start", (req, res) => {
  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

    const state = newState();
    const returnUrl = String(req.query.returnUrl || "").trim();
    if (returnUrl) returnUrlStore.set(state, returnUrl);

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
  if (!consumeState(state)) return res.status(401).send("Invalid/expired state");

  try {
    mustEnv("DISCORD_CLIENT_ID", process.env.DISCORD_CLIENT_ID);
    mustEnv("DISCORD_CLIENT_SECRET", process.env.DISCORD_CLIENT_SECRET);
    mustEnv("DISCORD_REDIRECT_URI", process.env.DISCORD_REDIRECT_URI);

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

    const returnUrl =
      String(returnUrlStore.get(state) || "").trim() ||
      process.env.WIX_RETURN_URL ||
      "https://www.comunidad-ataraxia.com/registro-nuevos-miembros";

    returnUrlStore.delete(state);

    const p = new URLSearchParams({
      oauth: "discord",
      code,
      state,
      discordId: safe.discordId,
      username: safe.username,
      global_name: safe.global_name,
      avatar: safe.avatar,
    });

    return res.redirect(`${returnUrl}${returnUrl.includes("?") ? "&" : "?"}${p.toString()}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth error");
  }
});

// =========================
// ROLES SYNC
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
// FORMS: Recruitment -> Channel
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const { guildId, channelId, discordUserId, discordTag, answers, memberId } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers) {
      return res.status(400).json({ ok: false, error: "Missing fields", got: { guildId, channelId, discordUserId, hasAnswers: !!answers } });
    }

    const channel = await client.channels.fetch(String(channelId)).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    // Formateo del mensaje
    const personaje = String(answers.personaje || answers.characterName || "—");
    const clase = String(answers.clase || "—");
    const expAoc = String(answers.expAoc || "—");

    const dispo = answers.disponibilidad || {};
    const dias = Array.isArray(dispo.dias) ? dispo.dias.join(", ") : String(dispo.dias || "—");
    const rangos = Array.isArray(dispo.rangos) ? dispo.rangos.join(", ") : String(dispo.rangos || "—");

    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **Discord ID:** ${discordUserId}`,
      memberId ? `🧾 **Wix memberId:** ${memberId}` : null,
      "",
      `🎭 **Personaje:** **${personaje}**`,
      `🧬 **Clase:** **${clase}**`,
      `⏳ **Experiencia en AoC:** **${expAoc}**`,
      "",
      "🗓️ **Disponibilidad (CDMX):**",
      `• Días: ${dias}`,
      `• Horarios: ${rangos}`,
      "",
      "📌 **Cuestionario:**",
      `• ¿Por qué deseas unirte?: ${String(answers.motivo || answers.whyAccept || "—")}`,
      `• Experiencia MMORPGs: ${String(answers.mmorpg || "—")}`,
      "",
      "⚖️ **Compromiso y disciplina:**",
      `• Ayudar a nuevos: ${String(answers.helpNewbies || "—")}`,
      `• Acepta jerarquía: ${String(answers.acceptHierarchy || "—")}`,
      `• Obedece calls PvP: ${String(answers.followOrdersMassPvp || "—")}`,
      `• Perfil: ${String(answers.leaderOrExecutor || "—")}`,
      `• Sacrificar loot: ${String(answers.loseLoot || "—")}`,
      "",
      "🧠 **Si un líder se equivoca:**",
      String(answers.badLeaderDecision || "—"),
      "",
      "📜 **Juramento:**",
      answers.oathAccepted ? "✅ Aceptado" : "❌ No aceptado",
    ].filter(Boolean);

    const msg = await channel.send({ content: lines.join("\n") });

    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error("❌ /forms/recruitment error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =======================
// HEALTHCHECK
// =======================
app.get("/", (req, res) => res.json({ ok: true, service: "ataraxia-bot" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));

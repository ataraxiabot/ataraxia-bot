import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { Client, GatewayIntentBits } from "discord.js";

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json());

// =======================
// MAPA RANGO (Wix) -> ROLE ID (Discord)  ✅ OPCIÓN A
// (llaves NORMALIZADAS para que funcione con normRank)
// =======================
const RANGO_TO_ROLE = {
  "esperando validacion": "1459028408066506812",
  "aspirante":  "1226682948233990205",
  "miembro":    "1279577361922396281",
};

function normRank(s){
  return String(s || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // quita acentos
    .replace(/\s+/g, " ");           // colapsa espacios
}

function roleIdFromRank(rango){
  return RANGO_TO_ROLE[normRank(rango)] || null;
}

// =======================
// DISCORD CLIENT
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

// =======================
// SEGURIDAD BÁSICA (Bearer BOT_API_KEY)
// =======================
function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${process.env.BOT_API_KEY}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// =========================
// DISCORD OAUTH
// =========================

// 1️⃣ Inicia OAuth
app.get("/oauth/discord/start", (req, res) => {
  const state = "ATARAXIA_" + Date.now();

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
  });

  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

// 2️⃣ Callback OAuth
app.get("/oauth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code");

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
    if (!tokenData?.access_token) return res.status(401).send("OAuth token error");

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const user = await userRes.json();
    if (!user?.id) return res.status(500).send("Could not fetch user");

    // ✅ Devuelve discordId al iFrame (window.opener)
    res.send(`
      <script>
        try {
          window.opener.postMessage(
            { type: "discord:ok", discordId: "${user.id}", username: "${user.username}" },
            "*"
          );
        } catch(e) {}
        window.close();
      </script>
    `);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth error");
  }
});

// =========================
// RECLUTAMIENTO - POST A DISCORD
// =========================
app.post("/forms/recruitment", auth, async (req, res) => {
  try {
    const {
      guildId,
      channelId,
      discordUserId,
      discordTag,
      answers
    } = req.body || {};

    if (!guildId || !channelId || !discordUserId || !answers) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const guild = await client.guilds.fetch(guildId);
    if (!guild) return res.status(404).json({ ok: false, error: "Guild not found" });

    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ ok: false, error: "Channel not found or not text" });
    }

    // 🧠 Construcción del mensaje (Discord tiene límite ~2000 chars)
    // Si luego quieres, lo convertimos a embeds o lo recortamos automáticamente.
    const lines = [
      "🛡️ **Nueva Solicitud de Reclutamiento – Ataraxia**",
      "",
      `👤 **Discord:** ${discordTag || "Usuario"} (<@${discordUserId}>)`,
      `🆔 **ID:** ${discordUserId}`,
      "",
      "**Respuestas:**",
      `1️⃣ Gameplay: **${answers.gameplayType}**`,
      `2️⃣ Días/semana: **${answers.daysPerWeek}**`,
      `3️⃣ Perder loot por la guild: **${answers.loseLoot}**`,
      `4️⃣ Ayudar a nuevos: **${answers.helpNewbies}**`,
      `5️⃣ Acepta jerarquía: **${answers.acceptHierarchy}**`,
      `6️⃣ Experiencia en guilds grandes: **${answers.bigGuilds}**`,
      `7️⃣ Rol: **${answers.leaderOrExecutor}**`,
      `8️⃣ Seguir órdenes en PvP masivo: **${answers.followOrdersMassPvp}**`,
      "",
      "🧠 **Si un líder se equivoca:**",
      String(answers.badLeaderDecision || ""),
      "",
      "🔥 **¿Por qué deberíamos aceptarte?:**",
      String(answers.whyAccept || ""),
      "",
      "📜 *Juramento aceptado*"
    ];

    const content = lines.join("\n");

    const msg = await channel.send({ content });

    return res.json({
      ok: true,
      messageId: msg.id
    });

  } catch (err) {
    console.error("Recruitment error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Internal error"
    });
  }
});

// =======================
// ENDPOINT PARA WIX (GENÉRICO): roles sync
// body: { guildId, discordUserId, rolesAdd[], rolesRemove[] }
// =======================
app.post("/roles/sync", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rolesAdd = [], rolesRemove = [] } = req.body;

    if (!guildId || !discordUserId) {
      return res.status(400).json({
        ok: false,
        error: "guildId y discordUserId son requeridos",
      });
    }

    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);

    if (rolesRemove.length > 0) await member.roles.remove(rolesRemove);
    if (rolesAdd.length > 0) await member.roles.add(rolesAdd);

    return res.json({ ok: true, added: rolesAdd, removed: rolesRemove });
  } catch (err) {
    console.error("❌ Error en /roles/sync:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

// =======================
// ENDPOINT: set rank (Wix -> Discord)
// body: { guildId, discordUserId, rango }
// =======================
app.post("/roles/set-rank", auth, async (req, res) => {
  try {
    const { guildId, discordUserId, rango } = req.body;

    if (!guildId || !discordUserId || !rango) {
      return res.status(400).json({
        ok: false,
        error: "guildId, discordUserId y rango son requeridos",
      });
    }

    const targetRoleId = roleIdFromRank(rango);
    if (!targetRoleId) {
      return res.status(400).json({
        ok: false,
        error: `Rango no mapeado: ${String(rango)}`,
      });
    }

    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);

    const systemRoleIds = new Set(Object.values(RANGO_TO_ROLE));

    // Quitar cualquier rol del sistema distinto al target
    const toRemove = member.roles.cache
      .filter((r) => systemRoleIds.has(r.id) && r.id !== targetRoleId)
      .map((r) => r.id);

    if (toRemove.length) await member.roles.remove(toRemove);

    // Agregar target si no lo tiene
    if (!member.roles.cache.has(targetRoleId)) {
      await member.roles.add([targetRoleId]);
    }

    return res.json({
      ok: true,
      rango: normRank(rango),
      added: [targetRoleId],
      removed: toRemove,
    });
  } catch (err) {
    console.error("❌ Error en /roles/set-rank:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

// =======================
// HEALTHCHECK
// =======================
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ataraxia-bot" });
});

// =======================
// BOOT (asegura que el bot conecte antes de escuchar)
// =======================
async function boot(){
  await client.login(process.env.DISCORD_TOKEN);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("✅ API escuchando en puerto", PORT));
}

boot().catch((e) => {
  console.error("❌ Boot error:", e);
  process.exit(1);
});

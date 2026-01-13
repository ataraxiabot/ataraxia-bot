// index.js (Render)
import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const {
  API_KEY,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,

  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,

  RECRUITMENT_CHANNEL_ID, // 1459207254015217674
  RECRUITMENT_ROLE_ID     // 1459028408066506812
} = process.env;

function requireKey(req, res, next){
  const k = req.header("x-api-key");
  if (!API_KEY || k !== API_KEY) return res.status(401).json({ ok:false, error:"Unauthorized" });
  next();
}

function jsonOk(res, data){ return res.json({ ok:true, ...data }); }
function jsonBad(res, code, msg){ return res.status(code).json({ ok:false, error: msg }); }

function safeState(){
  return crypto.randomBytes(24).toString("hex");
}

app.get("/health", (_,res)=>res.json({ok:true}));

// 1) URL OAuth
app.post("/oauth/start", requireKey, (req, res) => {
  const state = safeState();

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });

  const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  return jsonOk(res, { url, state });
});

// 2) Exchange code -> token -> user
app.post("/oauth/exchange", requireKey, async (req, res) => {
  try{
    const { code, redirect_uri } = req.body || {};
    if (!code) return jsonBad(res, 400, "Missing code");

    const tokenParams = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: String(redirect_uri || DISCORD_REDIRECT_URI)
    });

    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded" },
      body: tokenParams
    });

    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) return jsonBad(res, 400, `Token exchange failed: ${tokenJson?.error || "unknown"}`);

    const accessToken = tokenJson.access_token;
    const meResp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const me = await meResp.json();
    if (!meResp.ok) return jsonBad(res, 400, "Failed to fetch /users/@me");

    // username moderno puede venir como global_name, pero guardamos ambos
    const username = me.global_name || me.username || "Unknown";
    const tag = me.discriminator && me.discriminator !== "0" ? `${me.username}#${me.discriminator}` : me.username;

    return jsonOk(res, {
      discordId: me.id,
      discordUsername: username,
      discordTag: tag
    });
  }catch(e){
    return jsonBad(res, 500, `Exchange error: ${e?.message || e}`);
  }
});

async function discordBotFetch(path, options = {}){
  const url = `https://discord.com/api/v10${path}`;
  const headers = {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type":"application/json",
    ...(options.headers || {})
  };
  const resp = await fetch(url, { ...options, headers });
  const txt = await resp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch(_) {}
  return { resp, data, raw: txt };
}

// 3) Submit recruitment -> post to channel + assign role
app.post("/recruitment/submit", requireKey, async (req, res) => {
  try{
    const { discordId, discordUsername, ownerId, answers } = req.body || {};
    if (!discordId || !answers) return jsonBad(res, 400, "Missing discordId or answers");

    // Mensaje al canal
    const lines = [];
    const push = (k,v)=>lines.push(`**${k}:** ${String(v ?? "").trim()}`);

    push("Discord", `${discordUsername || "?"} (${discordId})`);
    push("OwnerId", ownerId || "—");
    push("Personaje", answers.personaje || "—");
    push("Edad", answers.edad || "—");
    push("Clase", answers.clase || "—");
    push("Gameplay", answers.gameplay || "—");

    push("¿Perder loot por la guild?", answers.perderLoot);
    push("¿Ayudar nuevos?", answers.ayudarNuevos);
    push("¿Guild grande?", answers.guildGrande);
    push("¿Voz en Discord?", answers.vozDiscord);
    push("¿Acepta jerarquía?", answers.jerarquia);

    push("Otras guilds", answers.otrasGuilds);
    push("Líder o ejecutor", answers.liderOEjecutor);
    push("¿Seguir calls PvP?", answers.seguirCalls);
    push("Si líder decide mal", answers.malaDecision);
    push("¿Por qué reclutarte?", answers.porQue);

    const content = `📨 **Nueva Solicitud de Reclutamiento (Ataraxia)**\n\n${lines.join("\n")}`;

    const post = await discordBotFetch(`/channels/${RECRUITMENT_CHANNEL_ID}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });

    if (!post.resp.ok) return jsonBad(res, 400, `Failed to post to channel: ${post.raw}`);

    // Asignar rol
    const role = await discordBotFetch(`/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${RECRUITMENT_ROLE_ID}`, {
      method: "PUT"
    });

    // OJO: esto puede fallar si el usuario no está en tu guild todavía
    // (no se puede “forzar” join solo con identify).
    // Así que lo tratamos como “soft-fail”.
    const roleOk = role.resp.ok;

    return jsonOk(res, {
      posted: true,
      roleAssigned: roleOk
    });

  }catch(e){
    return jsonBad(res, 500, `Submit error: ${e?.message || e}`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on", PORT));

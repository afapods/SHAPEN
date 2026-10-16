import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
// Render fica atrás de um proxy reverso; confie apenas no primeiro proxy para
// que Express e express-rate-limit interpretem corretamente X-Forwarded-For.
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "6mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

function client() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY não configurada no servidor.");
    err.status = 503;
    throw err;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function supabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URL || "").replace(/\/$/, ""),
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "",
    secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  };
}
async function authenticateSupabaseRequest(req, res, next) {
  const cfg = supabaseConfig();
  if (!cfg.url || !cfg.publishableKey || !cfg.secretKey) {
    return res.status(503).json({ error: "Autenticação ainda não configurada. Configure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY e SUPABASE_SECRET_KEY no Render." });
  }
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Entre na sua conta para continuar." });
  try {
    const response = await fetch(cfg.url + "/auth/v1/user", {
      headers: { apikey: cfg.publishableKey, Authorization: "Bearer " + match[1] }
    });
    const user = await response.json();
    if (!response.ok || !user?.id || !user?.email) return res.status(401).json({ error: "Sua sessão expirou. Entre novamente." });
    req.shapenUser = { id: user.id, email: user.email };
    req.shapenAccessToken = match[1];
    req.shapenSupabase = cfg;
    next();
  } catch (error) {
    console.error("Supabase auth validation failed:", error.message);
    return res.status(502).json({ error: "Não foi possível validar sua sessão agora." });
  }
}
async function supabaseAdminRequest(cfg, route, options = {}) {
  const response = await fetch(cfg.url + "/rest/v1/" + route, {
    ...options,
    headers: {
      apikey: cfg.secretKey,
      Authorization: "Bearer " + cfg.secretKey,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) {
    const details = data && typeof data === "object" ? data : {};
    const error = new Error(String(details.message || details.error || "Falha ao consultar dados do SHAPEN."));
    error.status = response.status;
    error.code = details.code || null;
    error.details = details.details || null;
    console.error("Supabase database request failed:", response.status, String(body).slice(0, 500));
    throw error;
  }
  return data;
}
function requireShapenPlan(minimumPlan) {
  const levels = { basico: 1, premium: 2, ultimate: 3 };
  return async (req, res, next) => {
    try {
      if (!req.shapenUser?.id || !req.shapenSupabase) {
        return res.status(401).json({ error: "Entre na sua conta para continuar." });
      }
      const rows = await supabaseAdminRequest(
        req.shapenSupabase,
        "shapen_subscriptions?select=plan,status,current_period_end&user_id=eq." +
          encodeURIComponent(req.shapenUser.id) +
          "&order=created_at.desc&limit=20"
      );
      const now = Date.now();
      const active = (Array.isArray(rows) ? rows : []).find((item) => {
        const status = String(item.status || "").toLowerCase();
        const periodEnd = item.current_period_end ? new Date(item.current_period_end).getTime() : null;
        if (periodEnd !== null && (!Number.isFinite(periodEnd) || periodEnd <= now)) return false;
        return ["active", "authorized"].includes(status) ||
          (status === "cancelled" && periodEnd !== null && periodEnd > now);
      });
      if (!active || (levels[active.plan] || 0) < (levels[minimumPlan] || 99)) {
        return res.status(403).json({
          error: "Este recurso exige um plano SHAPEN " + String(minimumPlan).toUpperCase() + " ativo."
        });
      }
      req.shapenPlan = active.plan;
      return next();
    } catch (error) {
      console.error("SHAPEN plan access check failed:", error.message);
      return res.status(502).json({ error: "Não foi possível verificar seu plano agora." });
    }
  };
}

function cleanProfile(p) {
  if (!p || typeof p !== "object") throw new Error("Perfil ausente.");
  const age = Number(p.age), weight = Number(p.weight), height = Number(p.height);
  if (!Number.isFinite(age) || age < 18 || age > 100 ||
      !Number.isFinite(weight) || weight < 30 || weight > 300 ||
      !Number.isFinite(height) || height < 120 || height > 230) {
    throw new Error("Perfil inválido. Este protótipo atende somente adultos e precisa de idade, peso e altura válidos.");
  }
  return {
    goal: String(p.goal || "fitness").slice(0, 30),
    age, weight, height, sex: String(p.sex || "x").slice(0, 10),
    activity: Number(p.activity) || 1.375,
    experience: String(p.experience || "beginner").slice(0, 30),
    days: Math.max(2, Math.min(6, Number(p.days) || 3)),
    duration: Math.max(20, Math.min(60, Number(p.duration) || 30)),
    equipment: String(p.equipment || "gym").slice(0, 30),
    cardio: String(p.cardio || "walk").slice(0, 30),
    diet: String(p.diet || "mixed").slice(0, 30),
    meals: Math.max(3, Math.min(5, Number(p.meals) || 4)),
    budget: String(p.budget || "balanced").slice(0, 30),
    cooking: String(p.cooking || "medium").slice(0, 30),
    avoid: String(p.avoid || "").slice(0, 180),
    limitations: String(p.limitations || "").slice(0, 300),
    conditions: String(p.conditions || "").slice(0, 300),
    target: String(p.target || "").slice(0, 90)
  };
}
const goalNames = { muscle: "hipertrofia", fat: "redução de gordura", fitness: "condicionamento", recomp: "recomposição corporal" };

app.post("/api/plan", authenticateSupabaseRequest, requireShapenPlan("basico"), async (req, res) => {
  let p;
  try { p = cleanProfile(req.body?.profile); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const openai = client();
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Você é um assistente de bem-estar que ajuda a estruturar hábitos e exercício para adultos. Gere um plano educativo, conservador, claro e em português do Brasil. Não faça diagnóstico nem prescrição clínica. Se houver lesão, dor, condição de saúde ou restrição relevante, reduza o nível de personalização e recomende avaliação de profissional habilitado. Nunca prometa resultados. Não incentive restrição extrema, perda rápida de peso, treino até falha obrigatório ou exercício com dor. Para nutrição, proponha combinações flexíveis de alimentos, não uma dieta clínica rígida. Evite calcular calorias específicas se houver sinal de risco clínico; em qualquer caso, explique que estimativas são aproximadas e precisam de validação profissional. O usuário tem 18 anos ou mais. Responda SOMENTE JSON válido no formato: {"aiSummary":"resumo curto do racional do plano","nutritionSummary":"resumo geral e limites","sessions":[{"title":"Dia A","focus":"Corpo inteiro","minutes":30,"exercises":[{"name":"Nome do exercício","selected":"Nome do exercício","sets":"2 × 8–12","focus":"grupo muscular","alt":["alternativa 1","alternativa 2","alternativa 3"],"key":"d0e0"}]}],"meals":[{"icon":"☀️","title":"Café da manhã","desc":"combinação flexível","alt":"alternativa compatível"}],"protein":100,"kcal":2000}. sessions deve ter exatamente o número de dias fornecido, com 3 a 6 exercícios por sessão conforme duração/experiência, incluindo aquecimento breve. Os campos exercise devem usar alternativas coerentes com o equipamento disponível. meals deve ter o número de refeições solicitado, sem quantidades rígidas. protein é apenas um número orientativo ou null; kcal deve ser null se não for apropriado estimar. Considere alergias/itens evitados; se não conseguir garantir segurança de um ingrediente, não o recomende e destaque que o usuário deve verificar rótulos. O campo key deve ser único, como d0e0, d0e1. Não inclua markdown.` },
        { role: "user", content: `Crie uma estrutura inicial para este perfil (não trate como prescrição clínica): ${JSON.stringify(p)}. Objetivo: ${goalNames[p.goal] || p.goal}.` }
      ]
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw new Error("A IA não retornou conteúdo.");
    const data = JSON.parse(raw);
    // Validate/normalize shape before returning to the browser.
    const sessions = Array.isArray(data.sessions) ? data.sessions.slice(0, p.days).map((s, i) => ({
      title: String(s.title || `Sessão ${i+1}`).slice(0, 80),
      focus: String(s.focus || "Corpo inteiro").slice(0, 100),
      minutes: p.duration,
      exercises: (Array.isArray(s.exercises) ? s.exercises : []).slice(0, 8).map((e, j) => ({
        name: String(e.name || "Exercício").slice(0, 120),
        selected: String(e.selected || e.name || "Exercício").slice(0, 120),
        sets: String(e.sets || "2 × 8–12").slice(0, 40),
        focus: String(e.focus || "").slice(0, 60),
        alt: (Array.isArray(e.alt) ? e.alt : []).slice(0, 4).map(a => String(a).slice(0, 120)),
        key: `d${i}e${j}`
      }))
    })) : [];
    const meals = Array.isArray(data.meals) ? data.meals.slice(0, p.meals).map((m, i) => ({
      icon: String(m.icon || "◉").slice(0, 8),
      title: String(m.title || `Refeição ${i+1}`).slice(0, 80),
      desc: String(m.desc || "Opção flexível").slice(0, 300),
      alt: String(m.alt || "Escolha uma alternativa compatível").slice(0, 300)
    })) : [];
    if (!sessions.length || !meals.length) throw new Error("A IA retornou um plano incompleto. Tente novamente.");
    return res.json({
      aiSummary: String(data.aiSummary || "Plano inicial criado a partir do perfil informado.").slice(0, 700),
      nutritionSummary: String(data.nutritionSummary || "Sugestões educativas; valide necessidades individuais com nutricionista.").slice(0, 700),
      sessions, meals,
      protein: data.protein !== null && data.protein !== undefined && Number.isFinite(Number(data.protein)) ? Number(data.protein) : null,
      kcal: data.kcal !== null && data.kcal !== undefined && Number.isFinite(Number(data.kcal)) ? Number(data.kcal) : null
    });
  } catch (e) {
    console.error("plan error:", e.message);
    return res.status(e.status || 502).json({ error: e.status === 503 ? e.message : "Não foi possível gerar o plano agora. Verifique a configuração da API e tente novamente." });
  }
});

app.post("/api/coach", authenticateSupabaseRequest, requireShapenPlan("premium"), async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 400);
  if (!message) return res.status(400).json({ error: "Escreva uma pergunta." });
  try {
    const openai = client();
    const p = req.body?.profile && typeof req.body.profile === "object" ? JSON.stringify(req.body.profile).slice(0, 1800) : "perfil não configurado";
    const plan = req.body?.plan && typeof req.body.plan === "object" ? JSON.stringify({ aiSummary: req.body.plan.aiSummary, sessions: req.body.plan.sessions, meals: req.body.plan.meals }).slice(0, 5000) : "plano não configurado";
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.5,
      messages: [
        { role: "system", content: "Você é o Copiloto SHAPEN, um assistente de bem-estar em português brasileiro. Ajude a adaptar rotinas, sugerir substituições gerais e explicar princípios de treino e alimentação. Não diagnostique, não prescreva dieta clínica, não recomende restrição extrema, não incentive exercício com dor e não se apresente como profissional de saúde. Se houver dor, lesão, condição médica, gravidez, histórico de transtorno alimentar ou risco, recomende profissional habilitado. Seja direto, acolhedor e prático, com até 180 palavras." },
        { role: "user", content: `Perfil do usuário: ${p}\nPlano atual: ${plan}\nPergunta: ${message}` }
      ]
    });
    return res.json({ reply: response.choices?.[0]?.message?.content || "Não consegui gerar uma resposta agora." });
  } catch (e) {
    console.error("coach error:", e.message);
    return res.status(e.status || 502).json({ error: e.status === 503 ? e.message : "Não foi possível responder agora. Verifique a configuração da API." });
  }
});


app.post("/api/adapt-meals", authenticateSupabaseRequest, requireShapenPlan("premium"), async (req, res) => {
  const request = String(req.body?.request || "").trim().slice(0, 400);
  if (!request) return res.status(400).json({ error: "Conte o que deseja mudar no cardápio." });
  const rawProfile = req.body?.profile;
  const rawPlan = req.body?.plan;
  if (!rawProfile || typeof rawProfile !== "object" || !rawPlan || typeof rawPlan !== "object") {
    return res.status(400).json({ error: "Configure seu perfil e gere um plano antes de adaptar as refeições." });
  }
  try {
    const openai = client();
    const profile = JSON.stringify({
      goal: rawProfile.goal, age: rawProfile.age, diet: rawProfile.diet,
      meals: rawProfile.meals, budget: rawProfile.budget, cooking: rawProfile.cooking,
      avoid: rawProfile.avoid, limitations: rawProfile.limitations, conditions: rawProfile.conditions
    }).slice(0, 1800);
    const currentMeals = JSON.stringify(Array.isArray(rawPlan.meals) ? rawPlan.meals.slice(0, 6) : []).slice(0, 3000);
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Você é o assistente de alimentação educativa do SHAPEN. Responda em português brasileiro e devolva SOMENTE JSON válido neste formato: {"title":"Cardápio adaptado","summary":"uma frase curta","meals":[{"icon":"☀️","title":"Café da manhã","desc":"alimentos e quantidades flexíveis quando apropriado","alt":"uma substituição prática"}]}. Monte um cardápio visual, não escreva um texto corrido. Cada refeição deve ser um cartão com título, descrição objetiva e alternativa. Preserve o número de refeições indicado no perfil, até 5. Respeite o estilo alimentar, orçamento, tempo de preparo, alergias e itens evitados; não recomende ingredientes de risco se houver dúvida. Não diagnostique nem prescreva dieta clínica, não incentive restrição extrema e não prometa resultados. Quantidades são apenas sugestões gerais e devem ser ajustadas por nutricionista.` },
        { role: "user", content: `Pedido de adaptação: ${request}\nPerfil: ${profile}\nRefeições atuais: ${currentMeals}\nGere um novo conjunto de refeições que aplique o pedido, respeitando o perfil. Retorne somente o JSON pedido.` }
      ]
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw new Error("A IA não retornou um cardápio.");
    const parsed = JSON.parse(raw);
    const meals = Array.isArray(parsed.meals) ? parsed.meals.slice(0, 5).map((m, i) => ({
      icon: String(m.icon || "◉").slice(0, 8),
      title: String(m.title || `Refeição ${i + 1}`).slice(0, 80),
      desc: String(m.desc || "Opção flexível").slice(0, 300),
      alt: String(m.alt || "Escolha uma alternativa compatível").slice(0, 300)
    })) : [];
    if (!meals.length) throw new Error("A IA retornou um cardápio vazio.");
    return res.json({
      title: String(parsed.title || "Cardápio adaptado").slice(0, 100),
      summary: String(parsed.summary || "Sugestões flexíveis para seu perfil.").slice(0, 300),
      meals
    });
  } catch (e) {
    console.error("adapt-meals error:", e.message);
    return res.status(e.status || 502).json({ error: e.status === 503 ? e.message : "Não foi possível montar o cardápio agora. Tente novamente em instantes." });
  }
});

const SUBSCRIPTION_PLANS = { basico: { title: "SHAPEN Básico", amount: 24.90 }, premium: { title: "SHAPEN Premium", amount: 59.90 }, ultimate: { title: "SHAPEN Ultimate", amount: 99.90 } };


// Administrative access is restricted to explicitly configured email addresses.
function requireShapenAdmin(req, res, next) {
  const allowed = String(process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return res.status(503).json({ error: "Painel administrativo ainda não configurado. Defina ADMIN_EMAILS no Render." });
  if (!req.shapenUser?.email || !allowed.includes(req.shapenUser.email.toLowerCase())) {
    return res.status(403).json({ error: "Acesso restrito à administração do SHAPEN." });
  }
  return next();
}
app.get("/api/admin/overview", authenticateSupabaseRequest, requireShapenAdmin, async (req, res) => {
  try {
    const cfg = req.shapenSupabase;
    const [subscriptions, profiles, authResponse] = await Promise.all([
      supabaseAdminRequest(cfg, "shapen_subscriptions?select=id,user_id,plan,status,payment_method,provider,provider_subscription_id,provider_payment_id,current_period_end,created_at,cancelled_at,external_reference&order=created_at.desc&limit=1000"),
      supabaseAdminRequest(cfg, "shapen_profiles?select=user_id,display_name&limit=1000"),
      fetch(cfg.url + "/auth/v1/admin/users?page=1&per_page=1000", {
        headers: { apikey: cfg.secretKey, Authorization: "Bearer " + cfg.secretKey }
      })
    ]);
    if (!authResponse.ok) throw new Error("Não foi possível consultar os usuários do Supabase Auth.");
    const authData = await authResponse.json();
    const profileByUser = new Map((Array.isArray(profiles) ? profiles : []).map(p => [p.user_id, p.display_name]));
    const emailByUser = new Map((Array.isArray(authData.users) ? authData.users : []).map(u => [u.id, u.email || ""]));
    const all = Array.isArray(subscriptions) ? subscriptions : [];
    const now = Date.now();
    const activeStatuses = new Set(["active", "authorized"]);
    const active = all.filter(s => {
      const end = s.current_period_end ? new Date(s.current_period_end).getTime() : null;
      return (activeStatuses.has(String(s.status).toLowerCase()) || (String(s.status).toLowerCase() === "cancelled" && end && end > now)) && (!end || end > now);
    });
    const amount = { basico: 24.90, premium: 59.90, ultimate: 99.90 };
    const monthlyRevenue = active.reduce((sum, s) => sum + (amount[s.plan] || 0), 0);
    const paid = all.filter(s => ["active", "authorized", "cancelled"].includes(String(s.status).toLowerCase()));
    const recent = all.slice(0, 100).map(s => ({
      id: s.id, userId: s.user_id, customer: profileByUser.get(s.user_id) || "Cliente SHAPEN", email: emailByUser.get(s.user_id) || "",
      plan: s.plan,
      status: String(s.status).toLowerCase() === "pending" && new Date(s.created_at).getTime() <= now - 24 * 60 * 60 * 1000 ? "expired" : s.status,
      paymentMethod: s.payment_method, provider: s.provider,
      createdAt: s.created_at, currentPeriodEnd: s.current_period_end, cancelledAt: s.cancelled_at
    }));
    const users = new Set(all.map(s => s.user_id));
    return res.json({
      metrics: {
        activeSubscribers: new Set(active.map(s => s.user_id)).size,
        estimatedMonthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
        totalSubscriptions: all.length,
        pendingPayments: all.filter(s => String(s.status).toLowerCase() === "pending" && new Date(s.created_at).getTime() > now - 24 * 60 * 60 * 1000).length,
        stalePendingAttempts: all.filter(s => String(s.status).toLowerCase() === "pending" && new Date(s.created_at).getTime() <= now - 24 * 60 * 60 * 1000).length,
        cancelledSubscriptions: all.filter(s => String(s.status).toLowerCase() === "cancelled").length,
        registeredPayingCustomers: users.size,
        paidRecords: paid.length
      },
      plans: ["basico", "premium", "ultimate"].map(plan => ({
        plan, active: new Set(active.filter(s => s.plan === plan).map(s => s.user_id)).size,
        estimatedMonthlyRevenue: Math.round(active.filter(s => s.plan === plan).reduce((sum, s) => sum + (amount[s.plan] || 0), 0) * 100) / 100
      })),
      subscriptions: recent
    });
  } catch (error) {
    console.error("SHAPEN admin overview failed:", error.message);
    return res.status(502).json({ error: "Não foi possível carregar os dados administrativos. Verifique o schema do Supabase." });
  }
});

app.get("/api/config", (_req, res) => {
  const cfg = supabaseConfig();
  return res.json({ supabaseUrl: cfg.url || null, supabasePublishableKey: cfg.publishableKey || null, authConfigured: Boolean(cfg.url && cfg.publishableKey && cfg.secretKey) });
});
app.get("/api/me", authenticateSupabaseRequest, async (req, res) => {
  try {
    const profiles = await supabaseAdminRequest(req.shapenSupabase, "shapen_profiles?select=display_name,fitness_profile&user_id=eq." + encodeURIComponent(req.shapenUser.id) + "&limit=1");
    let subscriptions;
    try {
      subscriptions = await supabaseAdminRequest(req.shapenSupabase, "shapen_subscriptions?select=plan,status,payment_method,current_period_end,created_at,cancelled_at,external_reference&user_id=eq." + encodeURIComponent(req.shapenUser.id) + "&order=created_at.desc&limit=10");
    } catch (error) {
      // Allow account access if an older database is missing only the newer optional metadata columns.
      const message = String(error.message || "").toLowerCase();
      const missingNewColumn = ["cancelled_at", "external_reference"].some((column) => message.includes(column));
      if (!missingNewColumn) throw error;
      console.warn("SHAPEN database migration pending; retrying account lookup without optional columns.");
      subscriptions = await supabaseAdminRequest(req.shapenSupabase, "shapen_subscriptions?select=plan,status,payment_method,current_period_end,created_at&user_id=eq." + encodeURIComponent(req.shapenUser.id) + "&order=created_at.desc&limit=10");
    }
    const now = Date.now();
    const active = (subscriptions || []).find(x => {
      const status = String(x.status || "").toLowerCase();
      const end = x.current_period_end ? new Date(x.current_period_end).getTime() : null;
      return (!end || end > now) && (["active", "authorized"].includes(status) || (status === "cancelled" && end !== null && end > now));
    }) || null;
    const latestSubscription = (subscriptions || [])[0] || null;
    return res.json({ user: req.shapenUser, profile: profiles?.[0] || null, subscription: active, latestSubscription, subscriptions: subscriptions || [], authConfigured: true });
  } catch (error) {
    // Keep detailed database diagnostics in server logs, never expose schema details to the browser.
    console.error("SHAPEN /api/me failed:", error.message, "status:", error.status || "unknown");
    return res.status(502).json({ error: "Não foi possível carregar sua conta. Confira as tabelas shapen_profiles e shapen_subscriptions no Supabase e tente novamente." });
  }
});
app.put("/api/profile", authenticateSupabaseRequest, async (req, res) => {
  const displayName = String(req.body?.displayName || "").trim().slice(0, 80);
  const fitnessProfile = req.body?.fitnessProfile && typeof req.body.fitnessProfile === "object" ? req.body.fitnessProfile : {};
  try {
    const rows = await supabaseAdminRequest(req.shapenSupabase, "shapen_profiles?on_conflict=user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ user_id: req.shapenUser.id, display_name: displayName || null, fitness_profile: fitnessProfile, updated_at: new Date().toISOString() })
    });
    return res.json({ profile: rows?.[0] || null });
  } catch {
    return res.status(502).json({ error: "Não foi possível salvar seu perfil." });
  }
});
app.post("/api/checkout", authenticateSupabaseRequest, async (req, res) => {
  const tier = String(req.body?.plan || "");
  const email = String(req.shapenUser.email || "").trim().slice(0, 160);
  const paymentMethod = String(req.body?.paymentMethod || "card");
  const chosen = SUBSCRIPTION_PLANS[tier];
  if (!chosen) return res.status(400).json({ error: "Plano inválido." });
  if (!["card", "pix"].includes(paymentMethod)) return res.status(400).json({ error: "Forma de pagamento inválida." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido." });
  // Avoid duplicate checkout attempts across both payment methods while allowing a fresh retry
  // after an abandoned checkout has been pending for 30 minutes.
  try {
    const existing = await supabaseAdminRequest(req.shapenSupabase,
      "shapen_subscriptions?select=id,plan,status,payment_method,current_period_end,created_at&user_id=eq." + encodeURIComponent(req.shapenUser.id) +
      "&provider=eq.mercadopago&order=created_at.desc&limit=50");
    const now = Date.now();
    const active = (existing || []).find(x => {
      const status = String(x.status || "").toLowerCase();
      const end = x.current_period_end ? new Date(x.current_period_end).getTime() : null;
      return ["active", "authorized"].includes(status) && (!end || (Number.isFinite(end) && end > now));
    });
    if (active) {
      return res.status(409).json({ error: "Você já tem um plano SHAPEN ativo. Para evitar cobranças duplicadas, aguarde o fim do período atual ou gerencie sua assinatura." });
    }
    const recentPending = (existing || []).find(x => {
      if (String(x.status || "").toLowerCase() !== "pending") return false;
      const created = new Date(x.created_at || 0).getTime();
      return Number.isFinite(created) && created > now - 30 * 60 * 1000;
    });
    if (recentPending) {
      return res.status(409).json({ error: "Você já iniciou um checkout recentemente. Se ainda estiver aberto, conclua-o; se desistiu, aguarde 30 minutos para iniciar outra tentativa. Nenhuma cobrança é confirmada sem aprovação do Mercado Pago." });
    }
  } catch (error) {
    console.error("Could not check existing checkouts:", error.message);
    return res.status(502).json({ error: "Não foi possível verificar suas tentativas de pagamento. Nenhum novo checkout foi criado; tente novamente." });
  }
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "Checkout ainda não ativado: falta configurar MERCADOPAGO_ACCESS_TOKEN nas variáveis do servidor." });
  try {
    const baseUrl = String(process.env.APP_URL || "https://shapen.onrender.com").replace(/\/$/, "");
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
    const externalReference = req.shapenUser.id + "|" + tier + "|" + randomUUID();
    let response;
    if (paymentMethod === "pix") {
      // Pix checkout is a one-time payment. The customer must pay again each month.
      response = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST", headers,
        body: JSON.stringify({
          items: [{ id: "shapen-" + tier, title: chosen.title + " — acesso por 1 mês", quantity: 1, unit_price: chosen.amount, currency_id: "BRL" }],
          payer: { email },
          external_reference: externalReference,
          notification_url: baseUrl + "/api/mercadopago/webhook",
          back_urls: { success: baseUrl + "/app.html?payment=success", failure: baseUrl + "/app.html?payment=failure", pending: baseUrl + "/app.html?payment=pending" },
          auto_return: "approved",
          payment_methods: { excluded_payment_types: [{ id: "credit_card" }, { id: "debit_card" }, { id: "ticket" }, { id: "account_money" }, { id: "prepaid_card" }] }
        })
      });
    } else {
      // Card checkout creates the recurring monthly subscription.
      response = await fetch("https://api.mercadopago.com/preapproval", {
        method: "POST", headers,
        body: JSON.stringify({
          reason: chosen.title + " — assinatura mensal",
          external_reference: externalReference,
          payer_email: email,
          notification_url: baseUrl + "/api/mercadopago/webhook",
          auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: chosen.amount, currency_id: "BRL" },
          back_url: baseUrl + "/app.html?subscription=return",
          status: "pending"
        })
      });
    }
    const data = await response.json();
    if (!response.ok) { console.error("Mercado Pago checkout error:", response.status, JSON.stringify(data).slice(0, 1000)); return res.status(502).json({ error: "O Mercado Pago não conseguiu criar o checkout. Confira as credenciais e a configuração da conta." }); }
    const checkoutUrl = paymentMethod === "pix" ? (data.init_point || data.sandbox_init_point) : data.init_point;
    if (!checkoutUrl) return res.status(502).json({ error: "O Mercado Pago não retornou o link seguro de pagamento." });
    try {
      await supabaseAdminRequest(req.shapenSupabase, "shapen_subscriptions", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: req.shapenUser.id, plan: tier, provider: "mercadopago", provider_subscription_id: paymentMethod === "card" ? String(data.id) : null, external_reference: externalReference, payment_method: paymentMethod, status: "pending" })
      });
    } catch (dbError) {
      console.error("Could not persist pending checkout:", dbError.message);
      return res.status(502).json({ error: "O checkout foi criado, mas não conseguimos registrar sua assinatura. Não faça outro pagamento; procure o suporte." });
    }
    return res.json({ checkoutUrl, paymentId: data.id, plan: tier, amount: chosen.amount, paymentMethod, recurring: paymentMethod === "card" });
  } catch (e) { console.error("checkout error:", e.message); return res.status(502).json({ error: "Não foi possível conectar ao Mercado Pago agora." }); }
});
app.post("/api/subscription/cancel", authenticateSupabaseRequest, async (req, res) => {
  const cfg = req.shapenSupabase;
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "Cancelamento automático indisponível: o Mercado Pago não está configurado no servidor." });
  try {
    const rows = await supabaseAdminRequest(cfg,
      "shapen_subscriptions?select=id,plan,status,payment_method,provider_subscription_id,current_period_end,external_reference&user_id=eq." +
      encodeURIComponent(req.shapenUser.id) + "&provider=eq.mercadopago&payment_method=eq.card&order=created_at.desc&limit=10");
    const row = (rows || []).find(x => ["active", "authorized", "pending"].includes(String(x.status || "").toLowerCase()) && x.provider_subscription_id);
    if (!row) return res.status(404).json({ error: "Não encontramos uma assinatura recorrente de cartão ativa para cancelar. O Pix não gera renovação automática." });
    const getResponse = await fetch("https://api.mercadopago.com/preapproval/" + encodeURIComponent(row.provider_subscription_id), {
      headers: { Authorization: "Bearer " + token }
    });
    const remote = await getResponse.json();
    if (!getResponse.ok) {
      console.error("Mercado Pago subscription lookup failed:", getResponse.status, JSON.stringify(remote).slice(0, 500));
      return res.status(502).json({ error: "Não foi possível confirmar a assinatura no Mercado Pago. Nenhuma alteração local foi feita; tente novamente." });
    }
    const expectedPrefix = req.shapenUser.id + "|" + row.plan + "|";
    if (!String(remote.external_reference || "").startsWith(expectedPrefix)) {
      return res.status(409).json({ error: "Não foi possível confirmar que esta assinatura pertence à sua conta. Entre em contato com o suporte." });
    }
    if (["cancelled", "canceled"].includes(String(remote.status || "").toLowerCase())) {
      const periodEnd = remote.next_payment_date && new Date(remote.next_payment_date).getTime() > Date.now()
        ? new Date(remote.next_payment_date).toISOString() : row.current_period_end || null;
      await supabaseAdminRequest(cfg, "shapen_subscriptions?id=eq." + encodeURIComponent(row.id), {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled", current_period_end: periodEnd, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
      return res.json({ ok: true, status: "cancelled", currentPeriodEnd: periodEnd, message: "A assinatura já estava cancelada no Mercado Pago." });
    }
    const periodEnd = remote.next_payment_date && new Date(remote.next_payment_date).getTime() > Date.now()
      ? new Date(remote.next_payment_date).toISOString() : null;
    const cancelResponse = await fetch("https://api.mercadopago.com/preapproval/" + encodeURIComponent(row.provider_subscription_id), {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "canceled" })
    });
    const cancelledRemote = await cancelResponse.json();
    if (!cancelResponse.ok || !["cancelled", "canceled"].includes(String(cancelledRemote.status || "").toLowerCase())) {
      console.error("Mercado Pago cancellation failed:", cancelResponse.status, JSON.stringify(cancelledRemote).slice(0, 500));
      return res.status(502).json({ error: "O Mercado Pago não confirmou o cancelamento. Não considere sua assinatura cancelada; tente novamente ou contate o suporte." });
    }
    const confirmedEnd = cancelledRemote.next_payment_date && new Date(cancelledRemote.next_payment_date).getTime() > Date.now()
      ? new Date(cancelledRemote.next_payment_date).toISOString() : periodEnd;
    await supabaseAdminRequest(cfg, "shapen_subscriptions?id=eq." + encodeURIComponent(row.id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelled", current_period_end: confirmedEnd, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    });
    return res.json({
      ok: true, status: "cancelled", currentPeriodEnd: confirmedEnd,
      message: confirmedEnd ? "Cancelamento confirmado. Não haverá novas renovações; o acesso permanece até o fim do período indicado." : "Cancelamento confirmado no Mercado Pago. Não haverá novas renovações; como o provedor não confirmou uma data final do período pago, o acesso pago foi encerrado."
    });
  } catch (error) {
    console.error("SHAPEN cancellation failed:", error.message);
    return res.status(502).json({ error: "Não foi possível concluir o cancelamento agora. Verifique sua conexão e tente novamente." });
  }
});

app.post("/api/food-photo", authenticateSupabaseRequest, requireShapenPlan("ultimate"), async (req, res) => {
  const image = String(req.body?.image || "");
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image) || image.length > 5500000) return res.status(400).json({ error: "Envie uma foto JPG, PNG ou WebP de até 4 MB." });
  try {
    const openai = client();
    const response = await openai.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", temperature: 0.2, response_format: { type: "json_object" }, messages: [
      { role: "system", content: `Você é um assistente educativo de registro alimentar. Analise apenas o que é visualmente provável. Nunca afirme certeza sobre ingredientes, peso ou calorias. Não diagnostique nem prescreva. Responda SOMENTE JSON válido no formato: {"foods":"alimentos prováveis","portion":"porção visual aproximada","note":"limitações e necessidade de confirmar"}. Se não puder identificar, diga isso claramente.` },
      { role: "user", content: [{ type: "text", text: "Descreva os alimentos visíveis e uma estimativa visual grosseira de porção. Não estime calorias. A pessoa vai revisar e corrigir a resposta." }, { type: "image_url", image_url: { url: image, detail: "low" } }] }
    ] });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    return res.json({ foods: String(parsed.foods || "Não foi possível identificar com confiança.").slice(0, 500), portion: String(parsed.portion || "Porção não estimada.").slice(0, 250), note: String(parsed.note || "Estimativa visual incerta; revise ingredientes e porções.").slice(0, 500) });
  } catch (e) { console.error("food-photo error:", e.message); return res.status(e.status || 502).json({ error: e.status === 503 ? e.message : "Não foi possível analisar a foto. Tente uma imagem mais nítida." }); }
});
function verifyMercadoPagoWebhook(req) {
  const secret = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || "").trim();
  if (!secret) return { ok: false, reason: "missing_secret" };
  const signature = String(req.headers["x-signature"] || "");
  const requestId = String(req.headers["x-request-id"] || "");
  const dataId = String(req.query["data.id"] || req.body?.data?.id || "").trim().toLowerCase();
  const parts = Object.fromEntries(signature.split(",").map(part => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  if (!parts.ts || !parts.v1 || !dataId) return { ok: false, reason: "missing_signature_fields" };
  const manifest = "id:" + dataId + ";" + (requestId ? "request-id:" + requestId + ";" : "") + "ts:" + parts.ts + ";";
  const expected = createHmac("sha256", secret).update(manifest).digest("hex");
  const actualBuffer = Buffer.from(parts.v1, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

app.post("/api/mercadopago/webhook", async (req, res) => {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const cfg = supabaseConfig();
  if (!token || !cfg.url || !cfg.secretKey) return res.status(503).json({ error: "Webhook não configurado." });
  const signatureCheck = verifyMercadoPagoWebhook(req);
  if (!signatureCheck.ok) {
    if (signatureCheck.reason === "missing_secret") {
      console.error("Mercado Pago webhook rejected: configure MERCADOPAGO_WEBHOOK_SECRET in the server environment.");
      return res.status(503).json({ error: "Webhook sem chave de assinatura configurada." });
    }
    console.warn("Mercado Pago webhook rejected:", signatureCheck.reason);
    return res.status(401).json({ error: "Assinatura de notificação inválida." });
  }
  const type = String(req.body?.type || req.query?.type || req.body?.topic || req.query?.topic || "");
  const resourceId = String(req.body?.data?.id || req.query?.id || "").trim();
  if (!resourceId) return res.status(200).json({ received: true, ignored: true });
  try {
    const headers = { Authorization: "Bearer " + token };
    if (type === "subscription_preapproval" || type === "preapproval") {
      const response = await fetch("https://api.mercadopago.com/preapproval/" + encodeURIComponent(resourceId), { headers });
      const item = await response.json();
      if (!response.ok) return res.status(200).json({ received: true, verified: false });
      const parts = String(item.external_reference || "").split("|");
      const userId = parts[0], tier = parts[1];
      if (!userId || !SUBSCRIPTION_PLANS[tier] || !parts[2]) return res.status(200).json({ received: true, ignored: true });
      const recurringAmount = Number(item.auto_recurring?.transaction_amount);
      const recurringCurrency = String(item.auto_recurring?.currency_id || "").toUpperCase();
      if (recurringCurrency !== "BRL" || !Number.isFinite(recurringAmount) || Math.abs(recurringAmount - SUBSCRIPTION_PLANS[tier].amount) > 0.01) {
        console.warn("Mercado Pago subscription amount/currency mismatch:", String(item.id));
        return res.status(200).json({ received: true, ignored: true, reason: "amount_currency_mismatch" });
      }
      const map = { authorized: "active", paused: "paused", cancelled: "cancelled", canceled: "cancelled", pending: "pending", rejected: "rejected" };
      const status = map[String(item.status || "").toLowerCase()] || "pending";
      const periodEnd = item.next_payment_date && new Date(item.next_payment_date).getTime() > Date.now()
        ? new Date(item.next_payment_date).toISOString() : null;
      const patch = { user_id: userId, plan: tier, provider: "mercadopago", provider_subscription_id: String(item.id), external_reference: String(item.external_reference), payment_method: "card", status, updated_at: new Date().toISOString() };
      if (periodEnd) patch.current_period_end = periodEnd;
      if (status === "cancelled") patch.cancelled_at = new Date().toISOString();
      await supabaseAdminRequest(cfg, "shapen_subscriptions?provider_subscription_id=eq." + encodeURIComponent(String(item.id)), {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch)
      });
      return res.status(200).json({ received: true, verified: true });
    }
    if (type === "payment") {
      const response = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(resourceId), { headers });
      const payment = await response.json();
      if (!response.ok) return res.status(200).json({ received: true, verified: false });
      const externalReference = String(payment.external_reference || "");
      const parts = externalReference.split("|");
      const userId = parts[0], tier = parts[1];
      if (!userId || !SUBSCRIPTION_PLANS[tier] || !parts[2]) return res.status(200).json({ received: true, ignored: true });
      const paymentStatus = String(payment.status || "").toLowerCase();
      const expectedAmount = SUBSCRIPTION_PLANS[tier].amount;
      const actualAmount = Number(payment.transaction_amount);
      const currency = String(payment.currency_id || "").toUpperCase();
      if (currency !== "BRL" || !Number.isFinite(actualAmount) || Math.abs(actualAmount - expectedAmount) > 0.01) {
        console.warn("Mercado Pago payment amount/currency mismatch:", String(payment.id));
        return res.status(200).json({ received: true, ignored: true, reason: "amount_currency_mismatch" });
      }
      if (paymentStatus === "approved") {
        const end = new Date(Date.now() + 30 * 86400000).toISOString();
        await supabaseAdminRequest(cfg, "shapen_subscriptions?external_reference=eq." + encodeURIComponent(externalReference) + "&user_id=eq." + encodeURIComponent(userId) + "&plan=eq." + encodeURIComponent(tier) + "&payment_method=eq.pix&status=eq.pending", {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ provider_payment_id: String(payment.id), status: "active", current_period_end: end, updated_at: new Date().toISOString() })
        });
        return res.status(200).json({ received: true, verified: true });
      }
      if (["rejected", "cancelled", "refunded", "charged_back"].includes(paymentStatus)) {
        // Revoke Pix access if a previously approved payment is later refunded or charged back.
        await supabaseAdminRequest(cfg, "shapen_subscriptions?external_reference=eq." + encodeURIComponent(externalReference) + "&user_id=eq." + encodeURIComponent(userId) + "&plan=eq." + encodeURIComponent(tier) + "&payment_method=eq.pix&status=in.(pending,active)", {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ provider_payment_id: String(payment.id), status: "rejected", current_period_end: null, updated_at: new Date().toISOString() })
        });
      }
      return res.status(200).json({ received: true, verified: true, paymentStatus });
    }
    return res.status(200).json({ received: true, ignored: true });
  } catch (error) {
    console.error("Mercado Pago webhook processing failed:", error.message);
    return res.status(500).json({ error: "Não foi possível processar a notificação." });
  }
});
app.get("/api/health", (_req, res) => {
  const cfg = supabaseConfig();
  return res.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    authConfigured: Boolean(cfg.url && cfg.publishableKey && cfg.secretKey),
    mercadopagoConfigured: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN),
    mercadopagoWebhookSecure: Boolean(process.env.MERCADOPAGO_WEBHOOK_SECRET)
  });
});
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`SHAPEN rodando em http://localhost:${PORT}`));

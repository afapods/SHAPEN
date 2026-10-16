import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
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
    const error = new Error("Falha ao consultar dados do SHAPEN.");
    error.status = response.status;
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
      const active = (Array.isArray(rows) ? rows : []).find((item) =>
        ["active", "authorized"].includes(String(item.status || "").toLowerCase()) &&
        (!item.current_period_end || new Date(item.current_period_end).getTime() > now)
      );
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

app.get("/api/config", (_req, res) => {
  const cfg = supabaseConfig();
  return res.json({ supabaseUrl: cfg.url || null, supabasePublishableKey: cfg.publishableKey || null, authConfigured: Boolean(cfg.url && cfg.publishableKey && cfg.secretKey) });
});
app.get("/api/me", authenticateSupabaseRequest, async (req, res) => {
  try {
    const [profiles, subscriptions] = await Promise.all([
      supabaseAdminRequest(req.shapenSupabase, "shapen_profiles?select=display_name,fitness_profile&user_id=eq." + encodeURIComponent(req.shapenUser.id) + "&limit=1"),
      supabaseAdminRequest(req.shapenSupabase, "shapen_subscriptions?select=plan,status,payment_method,current_period_end,created_at&user_id=eq." + encodeURIComponent(req.shapenUser.id) + "&order=created_at.desc&limit=10")
    ]);
    const active = (subscriptions || []).find(x => ["active", "authorized"].includes(x.status) && (!x.current_period_end || new Date(x.current_period_end).getTime() > Date.now())) || null;
    return res.json({ user: req.shapenUser, profile: profiles?.[0] || null, subscription: active, subscriptions: subscriptions || [], authConfigured: true });
  } catch (error) {
    return res.status(502).json({ error: "Não foi possível carregar sua conta. Confira se o schema do Supabase foi aplicado." });
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
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "Checkout ainda não ativado: falta configurar MERCADOPAGO_ACCESS_TOKEN nas variáveis do servidor." });
  try {
    const baseUrl = String(process.env.APP_URL || "https://shapen.onrender.com").replace(/\/$/, "");
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
    let response;
    if (paymentMethod === "pix") {
      // Pix checkout is a one-time payment. The customer must pay again each month.
      response = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST", headers,
        body: JSON.stringify({
          items: [{ id: "shapen-" + tier, title: chosen.title + " — acesso por 1 mês", quantity: 1, unit_price: chosen.amount, currency_id: "BRL" }],
          payer: { email },
          external_reference: req.shapenUser.id + "|" + tier,
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
          external_reference: req.shapenUser.id + "|" + tier,
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
        body: JSON.stringify({ user_id: req.shapenUser.id, plan: tier, provider: "mercadopago", provider_subscription_id: paymentMethod === "card" ? String(data.id) : null, payment_method: paymentMethod, status: "pending" })
      });
    } catch (dbError) {
      console.error("Could not persist pending checkout:", dbError.message);
      return res.status(502).json({ error: "O checkout foi criado, mas não conseguimos registrar sua assinatura. Não faça outro pagamento; procure o suporte." });
    }
    return res.json({ checkoutUrl, paymentId: data.id, plan: tier, amount: chosen.amount, paymentMethod, recurring: paymentMethod === "card" });
  } catch (e) { console.error("checkout error:", e.message); return res.status(502).json({ error: "Não foi possível conectar ao Mercado Pago agora." }); }
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
app.post("/api/mercadopago/webhook", async (req, res) => {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const cfg = supabaseConfig();
  if (!token || !cfg.url || !cfg.secretKey) return res.status(503).json({ error: "Webhook não configurado." });
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
      if (!userId || !SUBSCRIPTION_PLANS[tier]) return res.status(200).json({ received: true, ignored: true });
      const map = { authorized: "active", paused: "paused", cancelled: "cancelled", canceled: "cancelled", pending: "pending" };
      const status = map[String(item.status || "").toLowerCase()] || "pending";
      await supabaseAdminRequest(cfg, "shapen_subscriptions?provider_subscription_id=eq." + encodeURIComponent(String(item.id)), {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: userId, plan: tier, provider: "mercadopago", provider_subscription_id: String(item.id), payment_method: "card", status, updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ received: true, verified: true });
    }
    if (type === "payment") {
      const response = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(resourceId), { headers });
      const payment = await response.json();
      if (!response.ok) return res.status(200).json({ received: true, verified: false });
      const parts = String(payment.external_reference || "").split("|");
      const userId = parts[0], tier = parts[1];
      if (!userId || !SUBSCRIPTION_PLANS[tier] || payment.status !== "approved") return res.status(200).json({ received: true, ignored: true });
      const end = new Date(Date.now() + 30 * 86400000).toISOString();
      await supabaseAdminRequest(cfg, "shapen_subscriptions?user_id=eq." + encodeURIComponent(userId) + "&plan=eq." + encodeURIComponent(tier) + "&payment_method=eq.pix&status=eq.pending", {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ provider_payment_id: String(payment.id), status: "active", current_period_end: end, updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ received: true, verified: true });
    }
    return res.status(200).json({ received: true, ignored: true });
  } catch (error) {
    console.error("Mercado Pago webhook processing failed:", error.message);
    return res.status(500).json({ error: "Não foi possível processar a notificação." });
  }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY) }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`SHAPEN rodando em http://localhost:${PORT}`));

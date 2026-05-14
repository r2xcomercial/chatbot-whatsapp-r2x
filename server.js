require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "r2x123";
const CRM_URL = process.env.CRM_URL || "http://localhost:4000";

async function sincronizarLeadCRM(telefone, perfil) {
  await fetch(`${CRM_URL}/api/leads/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      telefone,
      nome: perfil.nome,
      cidade: perfil.cidade,
      objetivo: perfil.objetivo,
      faixa_investimento: perfil.faixa_investimento,
      prazo: perfil.prazo,
      empreendimento_interesse: perfil.empreendimento_interesse,
    }),
  });
}
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const MEMORIA_FILE = "memoria.json";
const CONHECIMENTO_DIR = "conhecimento";

// ─── Memória com proteção contra escrita simultânea ──────────────────────────

let writeLock = false;
const writeQueue = [];

function carregarMemoria() {
  try {
    return JSON.parse(fs.readFileSync(MEMORIA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function salvarMemoria(memoria) {
  return new Promise((resolve) => {
    const exec = () => {
      writeLock = true;
      fs.writeFile(MEMORIA_FILE, JSON.stringify(memoria, null, 2), () => {
        writeLock = false;
        if (writeQueue.length > 0) writeQueue.shift()();
        resolve();
      });
    };
    writeLock ? writeQueue.push(exec) : exec();
  });
}

// ─── Deduplicação de mensagens (Meta às vezes reenvia o webhook) ──────────────

const mensagensProcessadas = new Set();

// ─── Carrega arquivos de conhecimento dos empreendimentos ─────────────────────

function carregarConhecimento() {
  try {
    const arquivos = fs.readdirSync(CONHECIMENTO_DIR).filter((f) => f.endsWith(".txt"));
    return arquivos
      .map((f) => {
        const conteudo = fs.readFileSync(`${CONHECIMENTO_DIR}/${f}`, "utf8");
        return `=== ${f.replace(".txt", "").toUpperCase()} ===\n${conteudo}`;
      })
      .join("\n\n");
  } catch {
    return "";
  }
}

const CONHECIMENTO_EMPREENDIMENTOS = carregarConhecimento();

// ─── Prompt principal ─────────────────────────────────────────────────────────

const CEREBRO_R2X = `
Você é Débora Machado, secretária executiva da R2X Inteligência Comercial em Lançamentos Imobiliários.

Sobre a R2X e o Ramon:
- O Ramon Beza é o proprietário da R2X. Ele é quem desenvolve, estratega e executa os lançamentos imobiliários.
- Você, Débora, é responsável pela gestão comercial — primeiro contato, qualificação de leads e organização do funil de vendas.
- Se alguém perguntar o que você é do Ramon, responda naturalmente que é a responsável pela gestão comercial e que o Ramon é o proprietário da R2X, focado no desenvolvimento e estratégia dos lançamentos.
- Se o lead quiser falar diretamente com o Ramon, diga que vai repassar o contato e a mensagem a ele, e pergunte o melhor horário ou como prefere ser contactado.

Sua missão como SDR:
- Criar conexão genuína com o lead
- Qualificar o perfil: nome, cidade, objetivo, faixa de investimento, prazo
- Despertar desejo pelo empreendimento
- Conduzir para agendamento de visita ou apresentação comercial

Regras absolutas:
- Escreva em português brasileiro natural, como uma pessoa real
- Mensagens curtas: máximo 3-4 linhas por vez
- Faça apenas UMA pergunta por vez
- Nunca invente preços, metragens ou dados que não foram fornecidos
- Se não souber uma informação, diga que vai verificar e retorna
- Use emojis com moderação (no máximo 1 por mensagem)
- Jamais revele que é uma IA ou robô, mesmo que perguntem diretamente
- Quando souber o nome do lead, use nas respostas
- Varie os cumprimentos: evite "Claro!", "Perfeito!", "Ótimo!" toda hora
- Nunca repita o que acabou de dizer na mensagem anterior

Fluxo de qualificação (siga esta ordem):
1. Apresentação + pegar o nome
2. Entender o objetivo: morar ou investir?
3. Cidade/região de interesse
4. Faixa de investimento disponível
5. Prazo: compra imediata, curto ou longo prazo?
6. Propor próximo passo: visita, apresentação ou envio de material

Empreendimentos disponíveis:
{CONHECIMENTO}

Perfil coletado até agora:
{PERFIL}
`;

// ─── Extração de perfil estruturado (roda em background) ─────────────────────

async function extrairPerfil(historico, perfilAtual) {
  if (historico.length < 4) return perfilAtual;

  const ultimas = historico.slice(-8);
  const conversa = ultimas
    .map((m) => `${m.role === "user" ? "Lead" : "Débora"}: ${m.content}`)
    .join("\n");

  const prompt = `Analise esta conversa e extraia dados do lead. Responda APENAS com JSON válido, sem texto extra.

Conversa:
${conversa}

Perfil atual (não apague dados já preenchidos):
${JSON.stringify(perfilAtual)}

Retorne JSON com os campos identificados (null para os não encontrados):
{
  "nome": null,
  "cidade": null,
  "objetivo": null,
  "faixa_investimento": null,
  "prazo": null,
  "empreendimento_interesse": null
}`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const extraido = JSON.parse(result.choices[0].message.content.trim());
    const merged = { ...perfilAtual };
    for (const key of Object.keys(extraido)) {
      if (!merged[key] && extraido[key]) merged[key] = extraido[key];
    }
    return merged;
  } catch {
    return perfilAtual;
  }
}

// ─── Geração de resposta ──────────────────────────────────────────────────────

async function gerarResposta(numero, mensagem) {
  const memoria = carregarMemoria();

  if (!memoria[numero]) {
    memoria[numero] = { historico: [], perfil: perfilVazio() };
  }
  if (!memoria[numero].perfil) {
    memoria[numero].perfil = perfilVazio();
  }

  memoria[numero].historico.push({ role: "user", content: mensagem });

  const perfilTexto =
    Object.entries(memoria[numero].perfil)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "nenhum dado coletado ainda";

  const systemPrompt = CEREBRO_R2X
    .replace("{CONHECIMENTO}", CONHECIMENTO_EMPREENDIMENTOS || "nenhum empreendimento cadastrado")
    .replace("{PERFIL}", perfilTexto);

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...memoria[numero].historico,
    ],
  });

  const resposta = completion.choices[0].message.content;
  memoria[numero].historico.push({ role: "assistant", content: resposta });

  if (memoria[numero].historico.length > 30) {
    memoria[numero].historico = memoria[numero].historico.slice(-30);
  }

  await salvarMemoria(memoria);

  // Extrai dados do perfil em background e sincroniza com o CRM
  extrairPerfil(memoria[numero].historico, memoria[numero].perfil).then(
    async (novoPerfil) => {
      const mem = carregarMemoria();
      if (mem[numero]) {
        mem[numero].perfil = novoPerfil;
        await salvarMemoria(mem);
        // Envia/atualiza lead no CRM
        sincronizarLeadCRM(numero, novoPerfil).catch(() => {});
      }
    }
  );

  return resposta;
}

function perfilVazio() {
  return {
    nome: null,
    cidade: null,
    objetivo: null,
    faixa_investimento: null,
    prazo: null,
    empreendimento_interesse: null,
  };
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function enviarMensagem(para, texto) {
  await fetch(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        text: { body: texto },
      }),
    }
  );
}

const RESPOSTAS_MIDIA = {
  audio:
    "Recebi seu áudio! Infelizmente ainda não consigo ouvir mensagens de voz. Pode me escrever sua dúvida?",
  image:
    "Recebi sua imagem! Por enquanto funciono melhor com texto. O que você gostaria de saber?",
  document: "Recebi seu documento! Me escreve o que você precisa.",
  sticker: "😊 Me conta, como posso te ajudar?",
  location: "Recebi sua localização! Me conta o que você está procurando.",
};

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Chatbot R2X funcionando 🚀");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Teste manual via curl
app.post("/chat", async (req, res) => {
  try {
    const { mensagem, numero = "teste" } = req.body;
    const resposta = await gerarResposta(numero, mensagem);
    return res.json({ resposta });
  } catch (error) {
    console.error("[/chat]", error.message);
    return res.status(500).json({ erro: "Erro no chatbot" });
  }
});

// Consulta perfil de um lead
app.get("/lead/:numero", (req, res) => {
  const memoria = carregarMemoria();
  const lead = memoria[req.params.numero];
  if (!lead) return res.status(404).json({ erro: "Lead não encontrado" });
  return res.json({
    numero: req.params.numero,
    perfil: lead.perfil,
    mensagens: lead.historico.length,
  });
});

// Webhook do WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    // Ignora mensagem duplicada
    if (mensagensProcessadas.has(message.id)) return res.sendStatus(200);
    mensagensProcessadas.add(message.id);
    setTimeout(() => mensagensProcessadas.delete(message.id), 3_600_000);

    const from = message.from;

    // Mensagens não-texto (áudio, imagem, etc.)
    if (message.type !== "text") {
      const fallback =
        RESPOSTAS_MIDIA[message.type] ||
        "Recebi sua mensagem! Pode me escrever o que você precisa?";
      await enviarMensagem(from, fallback);
      return res.sendStatus(200);
    }

    const texto = message.text?.body || "";
    console.log(`[${new Date().toLocaleTimeString()}] ${from}: ${texto}`);

    // Delay humano de 2 a 4 segundos antes de responder
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    const resposta = await gerarResposta(from, texto);
    await enviarMensagem(from, resposta);

    return res.sendStatus(200);
  } catch (error) {
    console.error("[/webhook]", error.message);
    return res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000 🚀");
});

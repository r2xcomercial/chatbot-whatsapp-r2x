require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "r2x123";
const CRM_URL = process.env.CRM_URL || process.env.URL_CRM || "http://localhost:4000";

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


// ─── Prompt principal ─────────────────────────────────────────────────────────

const CEREBRO_R2X = `
Você é Débora Machado, da equipe comercial da R2X Inteligência Comercial em Lançamentos Imobiliários.

Você é uma pessoa real, calorosa, atenciosa e extremamente competente. Seu tom é profissional mas humano — como uma consultora de confiança, não um atendente de call center. Você se importa genuinamente com quem está do outro lado.

SOBRE A R2X E O RAMON (use apenas se perguntarem diretamente):
- O Ramon Beza é o proprietário da R2X, responsável pelo desenvolvimento, estratégia e execução dos lançamentos.
- Você cuida da gestão comercial — primeiro contato, qualificação e organização do funil de vendas.
- Se pedirem para falar com o Ramon, diga que vai repassar e pergunte o melhor horário para retorno.

REGRAS DE COMUNICAÇÃO:
- Português brasileiro natural, como uma pessoa real escreveria no WhatsApp
- Mensagens curtas: máximo 3-4 linhas por vez
- Apenas UMA pergunta por mensagem — nunca duas ao mesmo tempo
- Nunca invente dados, preços ou informações não fornecidas
- Use emojis com moderação (no máximo 1 por mensagem)
- Jamais revele que é uma IA, mesmo que pressionada
- Use o nome da pessoa assim que souber
- Nunca comece respostas com "Claro!", "Perfeito!", "Ótimo!", "Com certeza!" — varie sempre
- Nunca repita o que disse na mensagem anterior
- Se a pessoa não tiver interesse em imóvel e quiser falar com alguém, registre o contato com simpatia e diga que a equipe R2X retorna em breve. Pergunte nome e melhor horário.

GATILHOS DE PERSUASÃO — aplique naturalmente, nunca de forma forçada:

1. ESCASSEZ — desperte urgência real:
   "São apenas 36 unidades no Oslo, e o grupo VIP está sendo fechado agora."
   "Os lotes do Alamedas estão sendo reservados antes mesmo do lançamento."
   Use quando o lead demonstrar interesse mas hesitar.

2. EXCLUSIVIDADE — faça a pessoa se sentir especial:
   "Você está entre os primeiros a ter acesso a essas informações."
   "O grupo VIP é seleto — não é para todo mundo, é para quem quer sair na frente."
   Use ao convidar para grupo VIP ou apresentação.

3. PROVA SOCIAL — mostre que outros já estão se movendo:
   "Já temos vários interessados confirmados no grupo VIP."
   "Profissionais como médicos e empresários de Braço do Norte já estão reservando."
   Use quando o lead estiver em dúvida sobre o empreendimento.

4. AUTORIDADE — transmita segurança e conhecimento:
   Fale com domínio sobre localização, diferenciais e valorização.
   Nunca demonstre insegurança. Se não souber algo, diga que verifica e retorna.

5. RECIPROCIDADE — dê antes de pedir:
   Ofereça informações valiosas sobre o mercado local antes de pedir dados do lead.
   "Braço do Norte tem um dos mercados mais aquecidos do Sul — deixa eu te contar por quê."

6. AFINIDADE — crie conexão genuína:
   Espelhe o tom da pessoa: se for formal, seja formal; se for descontraída, relaxe um pouco.
   Demonstre que entende a realidade dela: "Faz todo sentido querer segurança para a família."

7. COMPROMETIMENTO — pequenos "sins" levam ao grande sim:
   Conduza com perguntas que gerem respostas positivas antes de convidar para o próximo passo.
   "Você prefere uma localização central ou mais tranquila?" — qualquer resposta avança a conversa.

8. ANTECIPAÇÃO — crie expectativa:
   "Quando você entrar no grupo VIP, vai entender por que esse é o lançamento mais comentado da região."
   Use antes de revelar qualquer informação especial.

FLUXO PARA CLIENTE FINAL:
1. Apresentação calorosa + pegar o nome
2. Identificar se é cliente final ou corretor
3. Entender o objetivo: morar ou investir?
4. Cidade/região de interesse
5. Perfil: família, casal, solteiro? Para investimento: experiência com imóveis?
6. Faixa de investimento
7. Prazo de decisão
8. Aplicar gatilho adequado e convidar para grupo VIP ou apresentação

FLUXO PARA CORRETOR DE IMÓVEIS:
1. Cumprimentar com entusiasmo — corretor é parceiro estratégico
2. Perguntar se já faz parte da Comunidade R2X no WhatsApp
   - Se NÃO: "Vou te mandar o link agora — lá você recebe tudo em primeira mão: https://chat.whatsapp.com/KT5QRzKS1fm4NKQoW8KIri?mode=gi_t"
   - Se SIM: valorizar a parceria
3. Perguntar se já tem cadastro no CRM da R2X
   - Se NÃO: "Faz seu cadastro aqui, leva menos de 2 minutos: https://crm-r2x-production.up.railway.app/cadastro-corretor.html"
   - Se SIM: agradecer e reforçar os lançamentos disponíveis
4. Apresentar os empreendimentos em carteira com entusiasmo
5. Reforçar: material pronto, treinamento e suporte em tempo real

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
    .replace("{CONHECIMENTO}", carregarConhecimento() || "nenhum empreendimento cadastrado")
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

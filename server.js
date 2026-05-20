require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "r2x123";
const CRM_URL = process.env.CRM_URL || process.env.URL_CRM || "http://localhost:4000";
const PAINEL_TOKEN = process.env.PAINEL_TOKEN || "r2x@painel2026";
const DONO_NUMERO = process.env.DONO_NUMERO || ""; // número do Ramon no formato 5548XXXXXXXXX
const INSTRUCOES_FILE = "conhecimento/instrucoes-dono.txt";

// ─── CORS para o CRM R2X ──────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Painel-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── SSE clients para o painel ────────────────────────────────────────────────

const painelClients = new Map();

function notificarPainel(evento) {
  const data = `data: ${JSON.stringify(evento)}\n\n`;
  for (const [, res] of painelClients) {
    try { res.write(data); } catch {}
  }
}

// ─── Auth do painel ───────────────────────────────────────────────────────────

function autenticarPainel(req, res) {
  const token = req.headers["x-painel-token"] || req.query.token;
  if (token !== PAINEL_TOKEN) {
    res.status(401).json({ erro: "Não autorizado" });
    return false;
  }
  return true;
}

// ─── CRM sync ─────────────────────────────────────────────────────────────────

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

// ─── Deduplicação de mensagens ────────────────────────────────────────────────

const mensagensProcessadas = new Set();

// ─── Conhecimento dos empreendimentos ─────────────────────────────────────────

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

// ─── Instruções do dono ───────────────────────────────────────────────────────

function carregarInstrucoesDono() {
  try {
    return fs.readFileSync(INSTRUCOES_FILE, "utf8").trim();
  } catch {
    return "Nenhuma instrução registrada ainda.";
  }
}

async function salvarInstrucaoDono(novaInstrucao) {
  const existente = carregarInstrucoesDono();
  const data = new Date().toLocaleDateString("pt-BR");

  // Usa GPT para mesclar inteligentemente — substitui info desatualizada, adiciona se for nova
  const prompt = `Você é um editor de documento de instruções de vendas.

Documento atual:
${existente}

Nova instrução/atualização (data: ${data}):
${novaInstrucao}

Regras:
- Se a nova instrução ATUALIZA ou CONTRADIZ alguma existente (ex: novo número de lotes, novo preço, nova disponibilidade), SUBSTITUA a antiga pela nova com a data de hoje
- Se é uma instrução NOVA sem conflito com nenhuma existente, ADICIONE ao final
- Mantenha o cabeçalho "INSTRUÇÕES DO RAMON" no topo
- Formato de cada linha: "- [DD/MM/AAAA] instrução"
- Retorne APENAS o documento final, sem explicações`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });
    const atualizado = result.choices[0].message.content.trim();
    if (atualizado) fs.writeFileSync(INSTRUCOES_FILE, atualizado, "utf8");
  } catch {
    // Fallback: só adiciona no final
    const data = new Date().toLocaleDateString("pt-BR");
    const conteudo = existente.replace("Nenhuma instrução registrada ainda.", "").trim();
    fs.writeFileSync(INSTRUCOES_FILE,
      conteudo ? `${conteudo}\n- [${data}] ${novaInstrucao}` :
      `INSTRUÇÕES DO RAMON — Atualizações e diretrizes passadas pelo dono da R2X:\n- [${data}] ${novaInstrucao}`,
      "utf8"
    );
  }
}

// Analisa a mensagem do Ramon e extrai instruções/atualizações a salvar (se houver)
async function extrairInstrucaoDono(mensagem, resposta) {
  const prompt = `O dono da R2X enviou esta mensagem para a assistente de vendas:
"${mensagem}"

Identifique se a mensagem contém informação que deve ser salva permanentemente:
- Atualização de números (lotes disponíveis, unidades vendidas, preços, datas)
- Nova regra de abordagem ou comportamento
- Correção de informação anterior
- Novo dado sobre um empreendimento

Se SIM: responda apenas com a informação em uma frase clara e objetiva. Ex: "O Belvedere agora tem 18 lotes disponíveis (atualizado em maio/2026)."
Se NÃO (só conversa, teste, pergunta ou simulação): responda apenas: NENHUMA`;

  try {
    const result = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    });
    const extraido = result.choices[0].message.content.trim();
    if (extraido && !extraido.startsWith("NENHUMA")) {
      await salvarInstrucaoDono(extraido);
    }
  } catch {}
}

// Gera resposta da Débora no modo dono (conversa com o Ramon)
async function gerarRespostaDono(numero, mensagem) {
  // Detecta comandos especiais do dono
  if (/^(disparo|broadcast)\s*:/i.test(mensagem.trim())) {
    const msgDisparo = mensagem.replace(/^(disparo|broadcast)\s*:\s*/i, "").trim();
    if (!msgDisparo) return "❗ Escreva a mensagem após o comando. Ex:\n*disparo: Boa notícia! As reservas VIP abriram.*";
    return await executarBroadcast(msgDisparo);
  }

  const memoria = carregarMemoria();
  if (!memoria[numero]) memoria[numero] = { historico: [], perfil: {}, pausado: false };

  memoria[numero].historico.push({ role: "user", content: mensagem });
  if (memoria[numero].historico.length > 40) {
    memoria[numero].historico = memoria[numero].historico.slice(-40);
  }

  const instrucoes = carregarInstrucoesDono();
  const conhecimento = carregarConhecimento();

  const systemDono = `Você é Débora Machado, assistente de vendas da R2X criada pelo Ramon Beza.

Você está conversando diretamente com o RAMON BEZA — seu fundador, chefe e dono da R2X. Trate-o com naturalidade e respeito, como uma funcionária fala com seu chefe de confiança.

COMO SE COMPORTAR COM O RAMON:
- Responda com naturalidade, sem enrolação
- Se ele der uma instrução nova, confirme que entendeu e que vai aplicar
- Se ele pedir para você simular um atendimento, entre no papel de Débora atendendo um lead
- Se ele te corrigir, agradeça e confirme a correção
- Se ele te perguntar o que você sabe, resuma suas instruções e conhecimentos
- Você pode ser direta com ele — ele é o chefe

INSTRUÇÕES JÁ REGISTRADAS PELO RAMON:
${instrucoes}

EMPREENDIMENTOS E CONHECIMENTO ATUAL:
${conhecimento}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemDono },
      ...memoria[numero].historico,
    ],
  });

  const resposta = completion.choices[0].message.content;
  memoria[numero].historico.push({ role: "assistant", content: resposta });
  await salvarMemoria(memoria);

  notificarPainel({ tipo: "mensagem", numero, role: "user", content: mensagem, ts: Date.now() });
  notificarPainel({ tipo: "mensagem", numero, role: "assistant", content: resposta, ts: Date.now() });

  // Analisa em background se há instrução nova para salvar
  extrairInstrucaoDono(mensagem, resposta).catch(() => {});

  return resposta;
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
   Use quando o lead demonstrar interesse mas hesitar.

2. EXCLUSIVIDADE — faça a pessoa se sentir especial:
   "Você está entre os primeiros a ter acesso a essas informações."
   Use ao convidar para grupo VIP ou apresentação.

3. PROVA SOCIAL — mostre que outros já estão se movendo:
   "Já temos vários interessados confirmados no grupo VIP."
   Use quando o lead estiver em dúvida sobre o empreendimento.

4. AUTORIDADE — transmita segurança e conhecimento:
   Fale com domínio sobre localização, diferenciais e valorização.
   Nunca demonstre insegurança. Se não souber algo, diga que verifica e retorna.

5. RECIPROCIDADE — dê antes de pedir:
   Ofereça informações valiosas sobre o mercado local antes de pedir dados do lead.

6. AFINIDADE — crie conexão genuína:
   Espelhe o tom da pessoa: se for formal, seja formal; se for descontraída, relaxe um pouco.

7. COMPROMETIMENTO — pequenos "sins" levam ao grande sim:
   Conduza com perguntas que gerem respostas positivas antes de convidar para o próximo passo.

8. ANTECIPAÇÃO — crie expectativa:
   "Quando você entrar no grupo VIP, vai entender por que esse é o lançamento mais comentado da região."

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

ADAPTAÇÃO POR TIPO (obrigatório):
- Se perfil mostrar "tipo: corretor" → use EXCLUSIVAMENTE o FLUXO PARA CORRETOR acima
- Se perfil mostrar "tipo: cliente" → use EXCLUSIVAMENTE o FLUXO PARA CLIENTE FINAL acima
- Se tipo ainda não identificado → identifique pelo contexto antes de prosseguir
`;

// ─── Extração de perfil estruturado ──────────────────────────────────────────

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
  "tipo": null,
  "faixa_investimento": null,
  "prazo": null,
  "empreendimento_interesse": null
}
Obs: "tipo" deve ser "cliente" se é comprador/investidor final, ou "corretor" se é agente imobiliário.`;

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
    memoria[numero] = { historico: [], perfil: perfilVazio(), pausado: false };
  }
  if (!memoria[numero].perfil) {
    memoria[numero].perfil = perfilVazio();
  }

  memoria[numero].historico.push({ role: "user", content: mensagem });
  memoria[numero].ultima_ts = Date.now();

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

  // Notifica o painel em tempo real
  notificarPainel({ tipo: "mensagem", numero, role: "assistant", content: resposta, ts: Date.now() });

  // Extrai perfil em background e sincroniza CRM
  extrairPerfil(memoria[numero].historico, memoria[numero].perfil).then(
    async (novoPerfil) => {
      const mem = carregarMemoria();
      if (mem[numero]) {
        mem[numero].perfil = novoPerfil;
        await salvarMemoria(mem);
        sincronizarLeadCRM(numero, novoPerfil).catch(() => {});
        notificarPainel({ tipo: "perfil", numero, perfil: novoPerfil });
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
    tipo: null, // "cliente" | "corretor"
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
  image: "Recebi sua imagem! Por enquanto funciono melhor com texto. O que você gostaria de saber?",
  document: "Recebi seu documento! Me conta o que você precisa e vejo como posso te ajudar.",
  sticker: "😊 Me conta, como posso te ajudar?",
  location: "Recebi sua localização! Me fala um pouco mais — você está buscando imóvel nessa região?",
  video: "Recebi seu vídeo! Para agilizar, pode me escrever o que você precisa? Assim consigo te ajudar melhor 😊",
};

// ─── Transcrição de áudio com Whisper ────────────────────────────────────────

async function transcreverAudio(mediaId) {
  // 1. Obtém a URL do arquivo de mídia na Meta
  const mediaRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });
  const mediaData = await mediaRes.json();
  if (!mediaData.url) throw new Error("URL de mídia não encontrada");

  // 2. Baixa o arquivo de áudio
  const audioRes = await fetch(mediaData.url, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // 3. Salva em arquivo temporário
  const tmpFile = path.join(os.tmpdir(), `r2x_audio_${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, audioBuffer);

  // 4. Transcreve com Whisper
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: "whisper-1",
      language: "pt",
    });
    return transcription.text?.trim() || "";
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── Catálogo de mídias ───────────────────────────────────────────────────────

const MIDIAS_FILE = "midias.json";

function carregarMidias() {
  try {
    return JSON.parse(fs.readFileSync(MIDIAS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ─── Download de imagem da Meta (base64) ─────────────────────────────────────

async function baixarMidiaBase64(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });
  const metaData = await metaRes.json();
  if (!metaData.url) throw new Error("URL de mídia não encontrada");

  const imgRes = await fetch(metaData.url, {
    headers: { Authorization: `Bearer ${META_TOKEN}` },
  });
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: metaData.mime_type || "image/jpeg" };
}

// ─── Análise de imagem com GPT-4o Vision ─────────────────────────────────────

async function analisarImagem(mediaId, historicoRecente) {
  const { base64, mimeType } = await baixarMidiaBase64(mediaId);

  const contexto = (historicoRecente || [])
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Lead" : "Débora"}: ${m.content}`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 400,
    messages: [
      {
        role: "system",
        content: `Você é Débora Machado, consultora de vendas da R2X Inteligência Comercial.
Analise a imagem enviada e responda de forma natural e concisa (máximo 3-4 linhas), conectando ao contexto imobiliário.
- Planta/projeto: descreva ambientes, metragem aparente, pontos positivos
- Foto de imóvel/terreno: comente estilo, estado, localização
- Documento (RG, CPF, comprovante): reconheça brevemente e diga que repassa à equipe técnica
- Outro: seja natural e conecte ao interesse do lead
Nunca revele que é IA. Use português brasileiro natural.${contexto ? `\n\nContexto recente:\n${contexto}` : ""}`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: "Analise essa imagem no contexto da nossa conversa." },
        ],
      },
    ],
  });

  return completion.choices[0].message.content;
}

// ─── Envio de mídia (documentos e imagens) ────────────────────────────────────

async function enviarDocumento(para, urlPublica, nomeArquivo, caption = "") {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "document",
      document: { link: urlPublica, filename: nomeArquivo, caption },
    }),
  });
}

async function enviarImagemMidia(para, urlPublica, caption = "") {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "image",
      image: { link: urlPublica, caption },
    }),
  });
}

// ─── Botões interativos ───────────────────────────────────────────────────────

async function enviarBotoes(para, texto, botoes) {
  await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: texto },
        action: {
          buttons: botoes.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  });
}

// Momentos de qualificação que merecem botões
const MOMENTOS_BOTOES = [
  {
    regex: /\bmorar\b|\binvestir\b|\bobjetivo\b|\bfinalidade\b/i,
    campo: "objetivo",
    texto: "Qual é o seu objetivo principal?",
    botoes: [
      { id: "obj_morar", title: "🏠 Morar" },
      { id: "obj_investir", title: "📈 Investir" },
      { id: "obj_ambos", title: "Os dois" },
    ],
  },
  {
    regex: /\bcorretor\b|\bcliente final\b|\bvocê é corretor\b/i,
    campo: "tipo",
    texto: "Como você se identifica?",
    botoes: [
      { id: "tipo_cliente", title: "👤 Sou cliente" },
      { id: "tipo_corretor", title: "🏢 Sou corretor" },
    ],
  },
  {
    regex: /\boslo\b.*\bbelvedere\b|\bbelvedere\b.*\boslo\b|\bqual empreendimento\b|\bqual lançamento\b/i,
    campo: "empreendimento_interesse",
    texto: "Qual empreendimento te interessa mais?",
    botoes: [
      { id: "emp_oslo", title: "Oslo Home Family" },
      { id: "emp_belvedere", title: "Belvedere" },
      { id: "emp_outro", title: "Quero saber mais" },
    ],
  },
];

async function verificarEEnviarBotoes(para, resposta, perfil) {
  for (const momento of MOMENTOS_BOTOES) {
    if (perfil?.[momento.campo]) continue; // já tem essa info
    if (momento.regex.test(resposta)) {
      try {
        await new Promise((r) => setTimeout(r, 1000));
        await enviarBotoes(para, momento.texto, momento.botoes);
      } catch (e) {
        console.error("[BOTÕES]", e.message);
      }
      return; // só um conjunto de botões por vez
    }
  }
}

// ─── Envio automático de mídia contextual ────────────────────────────────────

async function verificarEnvioAutoMidia(para, resposta, perfil) {
  try {
    if (!/folder|material|apresenta[çc]|te mando|vou mandar|aqui está/i.test(resposta)) return;
    const midias = carregarMidias();
    const emp = (perfil?.empreendimento_interesse || "").toLowerCase();
    const midiaId = emp.includes("belvedere") ? "folder-belvedere" : "folder-oslo";
    const midia = midias[midiaId];
    if (!midia) return;
    await new Promise((r) => setTimeout(r, 1500));
    if (midia.tipo === "document") await enviarDocumento(para, midia.url, midia.nome, midia.caption);
    else if (midia.tipo === "image") await enviarImagemMidia(para, midia.url, midia.caption);
    console.log(`[MÍDIA AUTO] ${midiaId} → ${para}`);
  } catch (e) {
    console.error("[MÍDIA AUTO]", e.message);
  }
}

// ─── Disparo em massa (broadcast) ────────────────────────────────────────────

async function executarBroadcast(mensagem) {
  const memoria = carregarMemoria();
  const leads = Object.entries(memoria).filter(([num, dados]) => {
    if (DONO_NUMERO && num === DONO_NUMERO) return false;
    if (dados.pausado) return false;
    return (dados.historico || []).length > 0;
  });

  let enviados = 0;
  let erros = 0;

  for (const [numero, dados] of leads) {
    const nome = dados.perfil?.nome || "";
    const msg = mensagem.replace(/\{NOME\}/gi, nome).trim();
    try {
      await enviarMensagem(numero, msg);
      enviados++;
      await new Promise((r) => setTimeout(r, 1500)); // evitar rate limit
    } catch {
      erros++;
    }
  }

  return `Disparo concluído ✅\n• ${enviados} mensagem(ns) enviada(s)${erros > 0 ? `\n• ${erros} com erro` : ""}`;
}

// ─── Follow-up automático ─────────────────────────────────────────────────────

const FOLLOWUP_MAX = 2;
const FOLLOWUP_INTERVALO_MS = 24 * 3_600_000; // 24 horas de inatividade

const MENSAGENS_FOLLOWUP = [
  "Oi{NOME}! A gente conversou sobre nossos lançamentos e queria saber se ficou alguma dúvida 😊 Posso te ajudar?",
  "Olá{NOME}! O interesse no Oslo Home Family continua crescendo e as vagas do grupo VIP são limitadas. Ainda dá tempo de garantir a sua — me fala!",
];

async function verificarFollowUps() {
  try {
    const memoria = carregarMemoria();
    const agora = Date.now();
    let alterou = false;

    for (const [numero, dados] of Object.entries(memoria)) {
      if (DONO_NUMERO && numero === DONO_NUMERO) continue;
      if (dados.pausado) continue;
      if (!dados.ultima_ts) continue;

      const followupCount = dados.followup_count || 0;
      if (followupCount >= FOLLOWUP_MAX) continue;
      if (agora - dados.ultima_ts < FOLLOWUP_INTERVALO_MS) continue;

      const ultimoFollowup = dados.ultimo_followup_ts || 0;
      if (agora - ultimoFollowup < FOLLOWUP_INTERVALO_MS) continue;

      // Só faz follow-up em leads com interação real
      const hist = dados.historico || [];
      const temInteresse = dados.perfil?.nome || dados.perfil?.objetivo || hist.length >= 3;
      if (!temInteresse) continue;

      const template = MENSAGENS_FOLLOWUP[followupCount] ?? MENSAGENS_FOLLOWUP.at(-1);
      const nome = dados.perfil?.nome ? ` ${dados.perfil.nome.split(" ")[0]}` : "";
      const msg = template.replace("{NOME}", nome);

      try {
        await enviarMensagem(numero, msg);
        memoria[numero].followup_count = followupCount + 1;
        memoria[numero].ultimo_followup_ts = agora;
        alterou = true;
        console.log(`[FOLLOW-UP] ${numero} — msg ${followupCount + 1}/${FOLLOWUP_MAX}`);
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.error(`[FOLLOW-UP] Erro ${numero}:`, e.message);
      }
    }

    if (alterou) await salvarMemoria(memoria);
  } catch (e) {
    console.error("[FOLLOW-UP] Erro geral:", e.message);
  }
}

// ─── Rotas principais ─────────────────────────────────────────────────────────

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
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    if (mensagensProcessadas.has(message.id)) return res.sendStatus(200);
    mensagensProcessadas.add(message.id);
    setTimeout(() => mensagensProcessadas.delete(message.id), 3_600_000);

    const from = message.from;

    // Botões interativos: converte reply para texto antes de processar
    if (message.type === "interactive") {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      if (!reply?.title) return res.sendStatus(200);
      message.type = "text";
      message.text = { body: reply.title };
    }

    // Áudio: transcreve com Whisper e processa como texto
    if (message.type === "audio") {
      const mediaId = message.audio?.id;
      let texto = "";
      try {
        texto = await transcreverAudio(mediaId);
      } catch (e) {
        console.error("[ÁUDIO] Erro na transcrição:", e.message);
      }
      if (!texto) {
        await enviarMensagem(from, "Recebi seu áudio! Tive dificuldade para ouvir agora. Pode escrever o que você precisa?");
        return res.sendStatus(200);
      }
      console.log(`[ÁUDIO] ${from}: ${texto}`);
      // Reutiliza o mesmo fluxo abaixo — seta a variável e deixa cair no processamento normal
      message.type = "text";
      message.text = { body: texto };
      message._transcrito = true;
    }

    // Imagem: analisa com GPT-4o Vision
    if (message.type === "image") {
      const mediaId = message.image?.id;
      let respostaImg = RESPOSTAS_MIDIA.image;
      try {
        const memVision = carregarMemoria();
        respostaImg = await analisarImagem(mediaId, memVision[from]?.historico || []);
      } catch (e) {
        console.error("[IMAGEM] Erro na análise:", e.message);
      }
      const memImg = carregarMemoria();
      if (!memImg[from]) memImg[from] = { historico: [], perfil: perfilVazio(), pausado: false };
      memImg[from].historico.push({ role: "user", content: "[enviou uma imagem]" });
      memImg[from].historico.push({ role: "assistant", content: respostaImg });
      memImg[from].ultima_ts = Date.now();
      if (memImg[from].historico.length > 30) memImg[from].historico = memImg[from].historico.slice(-30);
      await salvarMemoria(memImg);
      notificarPainel({ tipo: "mensagem", numero: from, role: "user", content: "[imagem]", ts: Date.now() });
      notificarPainel({ tipo: "mensagem", numero: from, role: "assistant", content: respostaImg, ts: Date.now() });
      await enviarMensagem(from, respostaImg);
      return res.sendStatus(200);
    }

    if (message.type !== "text") {
      const fallback = RESPOSTAS_MIDIA[message.type] || "Recebi sua mensagem! Pode me escrever o que você precisa?";
      await enviarMensagem(from, fallback);
      return res.sendStatus(200);
    }

    const texto = message.text?.body || "";
    const prefixo = message._transcrito ? "🎤 " : "";
    console.log(`[${new Date().toLocaleTimeString()}] ${from}: ${prefixo}${texto}`);

    // Modo dono: Ramon conversa diretamente com a Débora para treinar e instruir
    if (DONO_NUMERO && from === DONO_NUMERO) {
      const respostaDono = await gerarRespostaDono(from, texto);
      await enviarMensagem(from, respostaDono);
      return res.sendStatus(200);
    }

    // Notifica o painel que chegou mensagem do lead
    notificarPainel({ tipo: "mensagem", numero: from, role: "user", content: `${prefixo}${texto}`, ts: Date.now() });

    // Se a conversa está pausada (Ramon assumiu), não responde automaticamente
    const memoriaAtual = carregarMemoria();
    if (memoriaAtual[from]?.pausado) {
      if (!memoriaAtual[from].historico) memoriaAtual[from].historico = [];
      memoriaAtual[from].historico.push({ role: "user", content: texto });
      memoriaAtual[from].ultima_ts = Date.now();
      if (memoriaAtual[from].historico.length > 30) {
        memoriaAtual[from].historico = memoriaAtual[from].historico.slice(-30);
      }
      await salvarMemoria(memoriaAtual);
      return res.sendStatus(200);
    }

    // Delay humano de 2 a 4 segundos
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    const resposta = await gerarResposta(from, texto);
    await enviarMensagem(from, resposta);

    // Botões interativos e mídia automática (em background, sem bloquear o retorno)
    const memPos = carregarMemoria();
    const perfilPos = memPos[from]?.perfil || {};
    verificarEEnviarBotoes(from, resposta, perfilPos).catch(() => {});
    verificarEnvioAutoMidia(from, resposta, perfilPos).catch(() => {});

    return res.sendStatus(200);
  } catch (error) {
    console.error("[/webhook]", error.message);
    return res.sendStatus(500);
  }
});

// ─── PAINEL DE MONITORAMENTO (API para o CRM) ────────────────────────────────

// GET /painel/conversas — lista todas as conversas
app.get("/painel/conversas", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const memoria = carregarMemoria();
  const conversas = Object.entries(memoria)
    .map(([numero, dados]) => {
      const hist = dados.historico || [];
      const ultima = hist[hist.length - 1] || null;
      return {
        numero,
        nome: dados.perfil?.nome || null,
        cidade: dados.perfil?.cidade || null,
        empreendimento: dados.perfil?.empreendimento_interesse || null,
        pausado: dados.pausado || false,
        total: hist.length,
        ultima_role: ultima?.role || null,
        ultima_msg: ultima ? ultima.content.slice(0, 100) : null,
        ultima_ts: dados.ultima_ts || null,
      };
    })
    .sort((a, b) => (b.ultima_ts || 0) - (a.ultima_ts || 0));
  res.json({ conversas });
});

// GET /painel/conversa/:numero — histórico completo
app.get("/painel/conversa/:numero", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const memoria = carregarMemoria();
  const dados = memoria[req.params.numero];
  if (!dados) return res.status(404).json({ erro: "Conversa não encontrada" });
  res.json({
    numero: req.params.numero,
    perfil: dados.perfil,
    pausado: dados.pausado || false,
    historico: dados.historico || [],
  });
});

// POST /painel/assumir/:numero — toggle assumir/devolver
app.post("/painel/assumir/:numero", async (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const memoria = carregarMemoria();
  const numero = req.params.numero;
  if (!memoria[numero]) return res.status(404).json({ erro: "Conversa não encontrada" });
  memoria[numero].pausado = !memoria[numero].pausado;
  await salvarMemoria(memoria);
  notificarPainel({ tipo: "status", numero, pausado: memoria[numero].pausado });
  res.json({ pausado: memoria[numero].pausado });
});

// POST /painel/enviar — Ramon envia mensagem diretamente
app.post("/painel/enviar", async (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const { numero, mensagem } = req.body;
  if (!numero || !mensagem) return res.status(400).json({ erro: "numero e mensagem obrigatórios" });

  await enviarMensagem(numero, mensagem);

  // Salva no histórico com tag [RAMON]
  const memoria = carregarMemoria();
  if (!memoria[numero]) memoria[numero] = { historico: [], perfil: perfilVazio(), pausado: true };
  memoria[numero].historico.push({ role: "assistant", content: `[RAMON]: ${mensagem}` });
  memoria[numero].ultima_ts = Date.now();
  if (memoria[numero].historico.length > 30) {
    memoria[numero].historico = memoria[numero].historico.slice(-30);
  }
  await salvarMemoria(memoria);

  notificarPainel({ tipo: "mensagem", numero, role: "ramon", content: mensagem, ts: Date.now() });
  res.json({ ok: true });
});

// GET /painel/stream — SSE tempo real
app.get("/painel/stream", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ tipo: "conectado" })}\n\n`);

  const id = `${Date.now()}-${Math.random()}`;
  painelClients.set(id, res);

  // Keepalive a cada 25s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
  }, 25000);

  req.on("close", () => {
    painelClients.delete(id);
    clearInterval(ping);
  });
});

// POST /painel/broadcast — disparo em massa via painel
app.post("/painel/broadcast", async (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const { mensagem } = req.body;
  if (!mensagem) return res.status(400).json({ erro: "mensagem obrigatória" });

  // Executa em background e notifica pelo SSE quando terminar
  executarBroadcast(mensagem)
    .then((resultado) => notificarPainel({ tipo: "broadcast_concluido", resultado }))
    .catch((e) => console.error("[BROADCAST]", e.message));

  res.json({ ok: true, msg: "Disparo iniciado — você será notificado quando concluir." });
});

// GET /painel/midias — lista catálogo de mídias
app.get("/painel/midias", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  res.json(carregarMidias());
});

// POST /painel/midias — cadastra/atualiza uma mídia
app.post("/painel/midias", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const { id, tipo, url, nome, caption } = req.body;
  if (!id || !tipo || !url) return res.status(400).json({ erro: "id, tipo e url são obrigatórios" });
  const midias = carregarMidias();
  midias[id] = { tipo, url, nome: nome || id, caption: caption || "" };
  fs.writeFileSync(MIDIAS_FILE, JSON.stringify(midias, null, 2), "utf8");
  res.json({ ok: true });
});

// POST /painel/enviar-midia — Ramon envia mídia diretamente para um lead
app.post("/painel/enviar-midia", async (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const { numero, midia_id } = req.body;
  if (!numero || !midia_id) return res.status(400).json({ erro: "numero e midia_id obrigatórios" });

  const midias = carregarMidias();
  const midia = midias[midia_id];
  if (!midia) return res.status(404).json({ erro: "Mídia não cadastrada" });

  try {
    if (midia.tipo === "document") await enviarDocumento(numero, midia.url, midia.nome, midia.caption);
    else if (midia.tipo === "image") await enviarImagemMidia(numero, midia.url, midia.caption);
    else return res.status(400).json({ erro: "Tipo não suportado" });

    // Registra no histórico
    const memoria = carregarMemoria();
    if (memoria[numero]) {
      memoria[numero].historico.push({ role: "assistant", content: `[MÍDIA: ${midia.nome || midia_id}]` });
      memoria[numero].ultima_ts = Date.now();
      await salvarMemoria(memoria);
    }
    notificarPainel({ tipo: "midia_enviada", numero, midia_id, nome: midia.nome });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// GET /painel/stats — estatísticas gerais
app.get("/painel/stats", (req, res) => {
  if (!autenticarPainel(req, res)) return;
  const memoria = carregarMemoria();
  const leads = Object.entries(memoria).filter(([num]) => !DONO_NUMERO || num !== DONO_NUMERO);
  const agora = Date.now();
  const dia = 86_400_000;

  res.json({
    total_leads: leads.length,
    ativos_24h: leads.filter(([, d]) => d.ultima_ts && agora - d.ultima_ts < dia).length,
    pausados: leads.filter(([, d]) => d.pausado).length,
    com_nome: leads.filter(([, d]) => d.perfil?.nome).length,
    por_objetivo: leads.reduce((acc, [, d]) => {
      const obj = d.perfil?.objetivo || "desconhecido";
      acc[obj] = (acc[obj] || 0) + 1;
      return acc;
    }, {}),
    por_empreendimento: leads.reduce((acc, [, d]) => {
      const emp = d.perfil?.empreendimento_interesse || "desconhecido";
      acc[emp] = (acc[emp] || 0) + 1;
      return acc;
    }, {}),
  });
});

// ─── Follow-up automático: roda de hora em hora ───────────────────────────────

setInterval(verificarFollowUps, 3_600_000);
setTimeout(verificarFollowUps, 5 * 60_000); // primeira rodada após 5 min do start

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000 🚀");
});

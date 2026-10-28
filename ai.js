// Connecteurs IA. Les clés restent dans le navigateur de l'utilisateur.
export const PROVIDERS = {
  manual: {
    label: 'Manuel : copier-coller avec ChatGPT, Claude ou Gemini',
    note: 'Gratuit et sans clé. Vous discutez dans l’assistant de votre choix, puis vous collez le plan généré ici.',
  },
  gemini: {
    label: 'Google Gemini (offre gratuite)',
    defaultModel: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Clé gratuite sur Google AI Studio. Les modèles Flash sont inclus dans l’offre gratuite, avec des quotas. Lisez les conditions : sur l’offre gratuite, les échanges peuvent servir à améliorer les produits Google.',
  },
  groq: {
    label: 'Groq (offre gratuite)',
    base: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    note: 'Clé gratuite, réponses très rapides, quotas journaliers.',
  },
  openrouter: {
    label: 'OpenRouter (modèles gratuits)',
    base: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Choisissez un modèle dont le nom finit par « :free » avec le bouton « Charger les modèles ».',
  },
  openai: {
    label: 'OpenAI / ChatGPT (payant)',
    base: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Facturé à l’usage, indépendamment d’un abonnement ChatGPT. Fixez un plafond de dépenses.',
  },
  anthropic: {
    label: 'Anthropic / Claude (payant)',
    defaultModel: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Facturé à l’usage, indépendamment d’un abonnement Claude. Fixez un plafond de dépenses.',
  },
};

export const modelFor = (settings) =>
  (settings.models && settings.models[settings.provider]) || PROVIDERS[settings.provider]?.defaultModel || '';

function friendly(status, provider, msg) {
  if (status === 401 || status === 403) return `Clé refusée par ${PROVIDERS[provider].label}. Vérifiez-la dans Réglages.`;
  if (status === 429) return `Quota atteint chez ${PROVIDERS[provider].label}. Patientez une minute ou changez de modèle.`;
  if (status === 404) return `Modèle introuvable. Choisissez-en un autre dans Réglages (« Charger les modèles »).`;
  return `Erreur ${status} : ${msg || 'réponse inattendue du service.'}`;
}

async function call(url, opts, provider) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('Connexion impossible au service IA. Vérifiez votre réseau.'); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* texte brut */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 200);
    throw new Error(friendly(res.status, provider, msg));
  }
  return data;
}

/**
 * messages : [{ role: 'user' | 'assistant', content: string }]
 * Renvoie le texte de la réponse.
 */
export async function chat(settings, { system, messages, json = false }) {
  const provider = settings.provider;
  const key = settings.keys?.[provider];
  const model = modelFor(settings);
  if (provider === 'manual') throw new Error('Mode manuel : utilisez le copier-coller.');
  if (!key) throw new Error('Ajoutez votre clé API dans Réglages.');
  if (!model) throw new Error('Choisissez un modèle dans Réglages.');

  if (provider === 'gemini') {
    const m = model.replace(/^models\//, '');
    const data = await call(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
          generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.4 } : { temperature: 0.7 },
        }),
      }, provider);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const out = parts.map(p => p.text || '').join('').trim();
    if (!out) throw new Error('Réponse vide de Gemini (contenu filtré ou quota). Réessayez.');
    return out;
  }

  if (provider === 'anthropic') {
    const data = await call('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages }),
    }, provider);
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }

  // Compatibles OpenAI : groq, openrouter, openai
  const p = PROVIDERS[provider];
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Planéo'; }
  const body = { model, messages: [{ role: 'system', content: system }, ...messages], temperature: json ? 0.4 : 0.7 };
  if (json && provider !== 'openrouter') body.response_format = { type: 'json_object' };
  const data = await call(`${p.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, provider);
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('Réponse vide du service IA. Réessayez.');
  return out;
}

export async function listModels(settings) {
  const provider = settings.provider;
  const key = settings.keys?.[provider];
  if (provider === 'manual') return [];
  if (provider === 'gemini') {
    if (!key) throw new Error('Ajoutez d’abord votre clé.');
    const data = await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': key } }, provider);
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  }
  if (provider === 'openrouter') {
    const data = await call('https://openrouter.ai/api/v1/models', {}, provider);
    return (data.data || [])
      .filter(m => m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))
      .map(m => m.id).sort();
  }
  if (provider === 'anthropic') {
    if (!key) throw new Error('Ajoutez d’abord votre clé.');
    const data = await call('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    }, provider);
    return (data.data || []).map(m => m.id);
  }
  if (!key) throw new Error('Ajoutez d’abord votre clé.');
  const data = await call(`${PROVIDERS[provider].base}/models`, { headers: { Authorization: `Bearer ${key}` } }, provider);
  return (data.data || []).map(m => m.id).sort();
}

// Extrait un objet JSON d'une réponse (avec ou sans planeos ```json)
export function extractJSON(text) {
  if (!text) throw new Error('Réponse vide.');
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* on tente plus loin */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* échec */ }
  }
  throw new Error('Le texte ne contient pas de JSON valide. Demandez à l’assistant de répondre uniquement avec le JSON.');
}

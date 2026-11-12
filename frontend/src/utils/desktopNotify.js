/**
 * Notificação desktop (Notification API do navegador — aparece no canto da
 * tela, integrada ao Central de Ações do Windows/notificações do SO) + som
 * de "mensagem recebida". Antes disso, os toggles "Notificações"/"Som" em
 * Configurações > Geral (SettingsModal.js, wa-notifications/wa-sound no
 * localStorage) existiam só na tela — não disparavam nada de verdade.
 *
 * Sem asset de áudio no projeto: o "ding" é sintetizado via Web Audio API
 * (dois tons curtos) em vez de um arquivo .mp3 — não é o som real do
 * WhatsApp (proprietário), mas cumpre o mesmo papel sem depender de um
 * arquivo externo.
 */

let audioCtx = null;

function playDing() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    [[880, 0], [1320, 0.09]].forEach(([freq, delay]) => {
      const start = now + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    });
  } catch { /* AudioContext bloqueado/indisponível — sem som, sem quebrar o app */ }
}

/**
 * Pede permissão de notificação ao navegador e devolve o resultado
 * ('granted'|'denied'|'default'|'unsupported'). Só mostra o popup de
 * verdade se `Notification.permission` ainda for 'default' (nunca
 * perguntou) — depois de negada uma vez, só o próprio usuário reativa
 * manualmente nas configurações do navegador (nenhuma chamada de JS
 * consegue perguntar de novo).
 *
 * Chamar isso direto num clique do usuário (ex: o botão em Configurações),
 * não sozinho ao carregar a página — pedido sem gesto direto do usuário
 * quase sempre é tratado como "baixo engajamento" pelo Chrome e o popup
 * clássico nem aparece (fica só um ícone discreto na barra de endereço,
 * fácil de não notar) — igual pedir microfone só quando aperta pra gravar,
 * não ao abrir a tela.
 */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Dispara som (se wa-sound !== 'false') e notificação desktop (se
 * wa-notifications !== 'false' E permissão concedida) pra uma mensagem nova.
 * `tag` (ex: `chat-${conversationId}`) faz notificações da MESMA conversa se
 * substituírem em vez de acumular uma pilha.
 *
 * `popupSuppressed`: true quando a pessoa já está olhando pra essa conversa
 * com a aba em foco — nesse caso o POPUP de notificação não faz sentido
 * (igual o WhatsApp Web, que não te interrompe com um popup do que você já
 * está vendo), mas o SOM continua tocando mesmo assim (o WhatsApp Web toca
 * o "pop" de mensagem nova mesmo com a conversa aberta, como confirmação
 * sonora) — antes os dois ficavam presos na mesma condição por engano.
 *
 * `icon`: foto do contato/remetente (ex: contact.profile_picture_url), igual
 * o WhatsApp de verdade mostra na notificação em vez de um ícone genérico.
 * Sem foto (contato sem avatar, mensagem de equipe — usuário interno não
 * tem foto no sistema — ou URL que falhar ao carregar), cai pro logo padrão
 * do app.
 */
// applicationServerKey do PushManager.subscribe() quer Uint8Array, a chave
// VAPID pública vem do backend como base64url (mesmo formato que o browser
// usa pra gerar, só que como string) — conversão padrão da documentação MDN.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * Inscreve este navegador pra Web Push de verdade (via Service Worker) —
 * diferente da Notification API simples acima (notifyNewMessage), que só
 * dispara com alguma aba do app aberta. Push chega pelo serviço do próprio
 * navegador (FCM/Mozilla/etc), então funciona com o navegador fechado
 * também (pedido explícito — lembrete de prazo de tarefa precisa chegar no
 * computador mesmo sem o WhatsApp aberto). Só o computador desligado/sem
 * internet impede.
 *
 * Exige permissão de notificação já concedida (chamar depois de
 * requestNotificationPermission) e HTTPS (ou localhost) — Service Worker
 * não registra em contexto inseguro. Se já existe uma inscrição pra esse
 * navegador, devolve ela em vez de criar outra (evita duplicar a cada
 * login). Devolve null em qualquer falha (navegador sem suporte, permissão
 * negada, registro do SW falhou) — nunca lança, quem chama decide se avisa
 * o usuário ou só segue sem push.
 */
export async function subscribeToPush(vapidPublicKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  if (!vapidPublicKey) return null;
  try {
    const registration = await navigator.serviceWorker.register('/push-sw.js');
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }
    return subscription.toJSON();
  } catch (e) {
    console.warn('[Push] Falha ao inscrever este navegador:', e);
    return null;
  }
}

export function notifyNewMessage({ title, body, tag, onClick, popupSuppressed = false, icon }) {
  const notificationsOn = localStorage.getItem('wa-notifications') !== 'false';
  const soundOn = localStorage.getItem('wa-sound') !== 'false';

  if (soundOn) playDing();

  if (popupSuppressed) return;

  if (notificationsOn && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body: body || '',
        icon: icon || '/assets/app-icon-color.png',
        tag,
      });
      n.onclick = () => {
        window.focus();
        try { onClick?.(); } catch { /* noop */ }
        n.close();
      };
    } catch { /* navegador pode bloquear silenciosamente — nunca deve quebrar o app */ }
  }
}

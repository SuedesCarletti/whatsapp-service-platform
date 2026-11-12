// Limita quantas buscas de foto de perfil rodam em paralelo contra o bridge.
// Sem isso, abrir a sidebar com centenas de conversas dispara uma request por
// conversa de uma vez só — todas caem na mesma página do Chrome headless que o
// WPPConnect/Baileys usa pra tudo, inclusive enviar mensagem, e travam a fila
// (era a causa dos timeouts "Erro ao encaminhar mensagem" sob carga).
const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];

function runNext() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  active++;
  const { fn, resolve, reject } = queue.shift();
  fn().then(resolve, reject).finally(() => {
    active--;
    runNext();
  });
}

export function limitAvatarFetch(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

// Formata uma duração em minutos como "Xmin" ou "XhYmin" — usado pelos
// cronômetros de SLA (fila/atribuição/pendente) na Sidebar e no ChatArea.
export const formatElapsed = (minutes) => {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${m}min` : `${h}h`;
};

// Cliente mínimo de la API REST de ClickUp (v2) para el sistema PPA.
const BASE = "https://api.clickup.com/api/v2";

const TOKEN = process.env.CLICKUP_TOKEN;
export const INBOX_LIST_ID = process.env.INBOX_LIST_ID;
export const TAREAS_LIST_ID = process.env.TAREAS_LIST_ID;

const TZ = "America/Bogota"; // sin DST: offset fijo -05:00

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ClickUp ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export function hoyYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

export function finDelDiaMs(ymd = hoyYmd()) {
  return Date.parse(`${ymd}T23:59:00-05:00`);
}

function simplificar(t) {
  return {
    id: t.id,
    nombre: t.name,
    estado: t.status?.status,
    completada: t.status?.type === "done" || t.status?.type === "closed",
    prioridad: t.priority?.priority ?? null,
    vence: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
    vencida: t.due_date ? Number(t.due_date) < Date.now() : false,
    padre: t.parent ?? null,
    creada: t.date_created ? new Date(Number(t.date_created)).toISOString() : null,
    orden: t.orderindex ?? null,
    url: t.url,
    descripcion: t.description || undefined,
  };
}

export async function listarTareas(listId, { incluirCerradas = false } = {}) {
  const params = new URLSearchParams({
    subtasks: "true",
    include_closed: String(incluirCerradas),
  });
  const data = await api("GET", `/list/${listId}/task?${params}`);
  return (data.tasks || []).map(simplificar);
}

export async function crearTarea(listId, { nombre, descripcion, padre, venceHoy, prioridad }) {
  const body = { name: nombre };
  if (descripcion) body.markdown_description = descripcion;
  if (padre) body.parent = padre;
  if (venceHoy) body.due_date = finDelDiaMs();
  if (prioridad) body.priority = { urgent: 1, high: 2, normal: 3, low: 4 }[prioridad] ?? 3;
  const t = await api("POST", `/list/${listId}/task`, body);
  return simplificar(t);
}

export async function actualizarTarea(taskId, cambios) {
  const body = {};
  if (cambios.nombre) body.name = cambios.nombre;
  if (cambios.venceHoy) body.due_date = finDelDiaMs();
  if (cambios.prioridad) body.priority = { urgent: 1, high: 2, normal: 3, low: 4 }[cambios.prioridad] ?? 3;
  if (cambios.estado) body.status = cambios.estado;
  const t = await api("PUT", `/task/${taskId}`, body);
  return simplificar(t);
}

export async function borrarTarea(taskId) {
  await api("DELETE", `/task/${taskId}`);
}

const estadosPorLista = new Map();

async function estadosDeLista(listId) {
  if (!estadosPorLista.has(listId)) {
    const lista = await api("GET", `/list/${listId}`);
    estadosPorLista.set(listId, lista.statuses || []);
  }
  return estadosPorLista.get(listId);
}

// Cierra una tarea resolviendo el estado contra los de su lista: DONE_STATUS
// si existe ahí (override opcional); si no, el primero de tipo closed/done.
export async function marcarCompletada(taskId) {
  const tarea = await api("GET", `/task/${taskId}`);
  const estados = await estadosDeLista(tarea.list.id);
  const preferido = process.env.DONE_STATUS?.toLowerCase();
  const estado =
    estados.find((s) => s.status.toLowerCase() === preferido) ??
    estados.find((s) => s.type === "closed" || s.type === "done");
  if (!estado) {
    throw new Error(
      `La lista ${tarea.list.id} no tiene estado de cierre. Estados: ${estados.map((s) => s.status).join(", ")}`
    );
  }
  return actualizarTarea(taskId, { estado: estado.status });
}

// Estructura las tareas de una lista en árbol tarea → micro-pasos (subtareas).
export function arbol(tareas) {
  const raices = tareas.filter((t) => !t.padre);
  const porPadre = new Map();
  for (const t of tareas.filter((t) => t.padre)) {
    if (!porPadre.has(t.padre)) porPadre.set(t.padre, []);
    porPadre.get(t.padre).push(t);
  }
  for (const hijos of porPadre.values()) hijos.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  return raices.map((t) => ({ ...t, micro_pasos: porPadre.get(t.id) || [] }));
}

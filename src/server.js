// PPA MCP server — sistema anti-procrastinación de Angel.
// Tools deterministas sobre ClickUp + prompts (plan-hoy, trabado, checkin) que
// viajan con el servidor a cualquier cliente MCP.
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  INBOX_LIST_ID,
  TAREAS_LIST_ID,
  listarTareas,
  crearTarea,
  actualizarTarea,
  borrarTarea,
  marcarCompletada,
  arbol,
  hoyYmd,
} from "./clickup.js";

const PORT = Number(process.env.PORT || 5071);
const SECRET = process.env.PPA_SECRET;

if (!process.env.CLICKUP_TOKEN) {
  console.error("Falta CLICKUP_TOKEN en el entorno.");
  process.exit(1);
}
if (!SECRET || SECRET.length < 16) {
  console.error("Falta PPA_SECRET (mínimo 16 caracteres) en el entorno.");
  process.exit(1);
}
if (!INBOX_LIST_ID || !TAREAS_LIST_ID) {
  console.error("Faltan INBOX_LIST_ID y/o TAREAS_LIST_ID en el entorno.");
  process.exit(1);
}

function texto(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

function construirServidor() {
  const server = new McpServer({ name: "ppa", version: "1.0.0" });

  server.registerTool(
    "captura",
    {
      title: "Capturar en el Inbox",
      description:
        "Captura una idea o pendiente en el 📥 Inbox sin fricción. NO pidas detalles ni categorices: guarda el texto tal cual y confirma en una línea.",
      inputSchema: { texto: z.string().min(1).describe("La idea o pendiente, en una línea, tal como la dijo el usuario") },
    },
    async ({ texto: t }) => {
      const tarea = await crearTarea(INBOX_LIST_ID, { nombre: t });
      return texto(`📥 Capturado: ${tarea.nombre} (${tarea.url})`);
    }
  );

  server.registerTool(
    "plan_contexto",
    {
      title: "Contexto para planificar",
      description:
        "Devuelve el estado completo del sistema: tareas del 📥 Inbox sin procesar y tareas de 🎯 Tareas con sus micro-pasos, marcando vencidas y las de hoy. Úsalo al inicio de plan-hoy, trabado o checkin.",
      inputSchema: {},
    },
    async () => {
      const [inbox, tareas] = await Promise.all([
        listarTareas(INBOX_LIST_ID),
        listarTareas(TAREAS_LIST_ID),
      ]);
      return texto({ hoy: hoyYmd(), inbox: arbol(inbox), tareas: arbol(tareas) });
    }
  );

  server.registerTool(
    "procesar_inbox_item",
    {
      title: "Procesar ítem del Inbox",
      description:
        "Convierte un ítem crudo del Inbox en una tarea accionable en 🎯 Tareas (nombre que empiece con verbo, resultado claro) y lo elimina del Inbox.",
      inputSchema: {
        task_id: z.string().describe("ID de la tarea en el Inbox"),
        nombre_accionable: z.string().describe("Nuevo nombre accionable, empezando con un verbo"),
        descripcion: z.string().optional().describe("Contexto adicional en markdown, si lo hay"),
      },
    },
    async ({ task_id, nombre_accionable, descripcion }) => {
      const nueva = await crearTarea(TAREAS_LIST_ID, { nombre: nombre_accionable, descripcion });
      await borrarTarea(task_id);
      return texto(`✅ Movido a 🎯 Tareas: ${nueva.nombre} (id ${nueva.id})`);
    }
  );

  server.registerTool(
    "planificar_tarea",
    {
      title: "Planificar tarea para hoy",
      description:
        "Marca una tarea de 🎯 Tareas para hoy (due date + prioridad) y crea sus micro-pasos como subtareas. El primer micro-paso debe tomar ≤5 minutos; el resto ≤15.",
      inputSchema: {
        task_id: z.string().describe("ID de la tarea a planificar"),
        micro_pasos: z.array(z.string()).min(1).max(8).describe("Micro-pasos en orden; el primero de ≤5 min"),
        prioridad: z.enum(["urgent", "high", "normal", "low"]).optional(),
      },
    },
    async ({ task_id, micro_pasos, prioridad }) => {
      await actualizarTarea(task_id, { venceHoy: true, prioridad: prioridad || "normal" });
      for (const paso of micro_pasos) {
        await crearTarea(TAREAS_LIST_ID, { nombre: paso, padre: task_id, venceHoy: true });
      }
      return texto(`🎯 Planificada para hoy con ${micro_pasos.length} micro-pasos. Primer paso: ${micro_pasos[0]}`);
    }
  );

  server.registerTool(
    "siguiente_paso",
    {
      title: "Siguiente micro-paso (anti-parálisis)",
      description:
        "Devuelve UN solo micro-paso pendiente: el primero no completado de las tareas de hoy (o vencidas). Para el comando trabado — nunca devuelvas una lista al usuario, solo este paso.",
      inputSchema: {},
    },
    async () => {
      const tareas = arbol(await listarTareas(TAREAS_LIST_ID));
      const hoy = hoyYmd();
      const candidatas = tareas
        .filter((t) => !t.completada && t.vence && (t.vence.slice(0, 10) <= hoy || t.vencida))
        .sort((a, b) => (a.vence || "").localeCompare(b.vence || ""));
      for (const t of candidatas) {
        const paso = t.micro_pasos.find((p) => !p.completada);
        if (paso) return texto({ tarea: t.nombre, tarea_id: t.id, paso: paso.nombre, paso_id: paso.id });
        if (!t.micro_pasos.length) return texto({ tarea: t.nombre, tarea_id: t.id, paso: null, nota: "Tarea sin micro-pasos: divídela primero con planificar_tarea." });
      }
      const backlog = tareas.filter((t) => !t.completada);
      if (backlog.length) return texto({ paso: null, nota: `No hay plan para hoy. Hay ${backlog.length} tareas en backlog: elige UNA con planificar_tarea.` });
      return texto({ paso: null, nota: "No hay tareas. Sugiere capturar pendientes con la tool captura." });
    }
  );

  server.registerTool(
    "marcar_hecho",
    {
      title: "Marcar como hecho",
      description: "Marca una tarea o micro-paso como completado en ClickUp.",
      inputSchema: { task_id: z.string().describe("ID de la tarea o subtarea completada") },
    },
    async ({ task_id }) => {
      const t = await marcarCompletada(task_id);
      return texto(`✅ Hecho: ${t.nombre}`);
    }
  );

  const PROMPT_PLAN = `Eres el coach matutino de Angel (procrastinador crónico — el sistema está diseñado contra la parálisis de inicio). Genera el plan de HOY usando las tools del servidor MCP "ppa".

Pasos:
1. Llama plan_contexto para ver el Inbox y las Tareas.
2. Procesa cada ítem del Inbox con procesar_inbox_item (nombre que empiece con verbo). Si algo es solo una idea no accionable, déjalo.
3. Elige MÁXIMO 3 tareas para hoy: primero lo vencido, luego lo urgente, y UNA importante no urgente. Aunque haya 20 pendientes, son 3 — di cuántas quedan en backlog sin listarlas.
4. Divide cada elegida con planificar_tarea: micro-pasos de ≤15 min, el primero de ≤5 min (tan pequeño que dé vergüenza no hacerlo).
5. Si tienes acceso a Google Calendar en este cliente, agenda un bloque de 45–90 min por tarea en los huecos libres; si no, sugiere los horarios.
6. Cierra con el resumen breve:

**Plan de hoy — <fecha>**
1. <tarea> → <hora sugerida>. Primer micro-paso: <paso>
...
Empieza por el micro-paso #1 de la tarea 1. Solo ese. Si te trabas: prompt "trabado".

Reglas: cero culpa por lo no hecho; máximo 3 tareas; si no hay nada, sugiere capturar con la tool captura.`;

  const PROMPT_TRABADO = `Angel está procrastinando o paralizado AHORA MISMO. Tu único trabajo: darle UNA acción de menos de 5 minutos para arrancar.

1. Llama la tool siguiente_paso del servidor MCP "ppa".
2. Responde EXACTAMENTE así y nada más:

> **Tu único trabajo ahora: <micro-paso de ≤5 min, concreto y físico>**
> (de la tarea: <nombre>)
>
> Pon un timer de 5 minutos y hazlo. Cuando termines, dime "listo" y te doy el siguiente.

Reglas: UN solo paso, nunca lista ni opciones. Si dice "listo", llama marcar_hecho con el paso_id y dale el siguiente con siguiente_paso. Cero sermones de productividad.`;

  const PROMPT_CHECKIN = `Eres el check-in nocturno de Angel. Cierra el día SIN CULPA.

1. Llama plan_contexto y revisa las tareas con vencimiento hoy: completadas, a medias (mira micro-pasos), no tocadas.
2. NO muevas fechas: lo no terminado queda vencido y mañana compite por los 3 cupos.
3. Resume en pocas líneas: N/M completadas, estado de cada una, y UNA frase amable y concreta sobre por dónde arrancar mañana. Un día con 1/3 sigue siendo progreso.`;

  server.registerPrompt(
    "captura",
    {
      title: "Capturar en el Inbox",
      description: "Guarda una idea o pendiente en el 📥 Inbox sin fricción",
      argsSchema: { texto: z.string().describe("La idea o pendiente, en una línea") },
    },
    ({ texto: t }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Llama la tool captura del servidor MCP "ppa" con texto: "${t}". NO pidas detalles, NO categorices, NO asignes fecha ni prioridad. Responde solo con la confirmación de una línea que devuelve la tool. Si el texto está vacío, pregunta únicamente: "¿Qué quieres capturar?"`,
          },
        },
      ],
    })
  );
  server.registerPrompt("plan-hoy", { title: "Plan del día", description: "Ritual matutino: máx 3 tareas, micro-pasos, timeboxing" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT_PLAN } }],
  }));
  server.registerPrompt("trabado", { title: "Anti-parálisis", description: "Un solo micro-paso de 5 minutos para arrancar ya" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT_TRABADO } }],
  }));
  server.registerPrompt("checkin", { title: "Check-in nocturno", description: "Cierre del día sin culpa" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT_CHECKIN } }],
  }));

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/ppa-mcp/health", (_req, res) => res.json({ ok: true, servicio: "ppa-mcp" }));

function autorizado(req) {
  if (req.params.secret === SECRET) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${SECRET}`;
}

// Endpoint MCP (streamable HTTP, stateless): la URL del cliente lleva el secreto en el path
// para que funcione también en clientes que no permiten headers personalizados.
app.post("/ppa-mcp/:secret", async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: "no autorizado" });
  try {
    const server = construirServidor();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Error MCP:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  }
});

// Stateless: sin sesiones que retomar ni cerrar.
app.get("/ppa-mcp/:secret", (_req, res) => res.status(405).end());
app.delete("/ppa-mcp/:secret", (_req, res) => res.status(405).end());

app.listen(PORT, "127.0.0.1", () => {
  console.log(`ppa-mcp escuchando en 127.0.0.1:${PORT} (Inbox ${INBOX_LIST_ID}, Tareas ${TAREAS_LIST_ID})`);
});

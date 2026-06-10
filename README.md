# PPA MCP — sistema anti-procrastinación como MCP server

Convierte un sistema anti-procrastinación (Inbox de cero fricción + máx 3 tareas/día + micro-pasos + anti-parálisis) en un MCP server accesible desde **cualquier entorno**: Claude Code en cualquier máquina, claude.ai web y móvil.

- **Tools** (hablan directo con la API de ClickUp): `captura`, `plan_contexto`, `procesar_inbox_item`, `planificar_tarea`, `siguiente_paso`, `marcar_hecho`.
- **Prompts** (viajan con el servidor, aparecen como comandos en el cliente): `captura`, `plan-hoy`, `trabado`, `checkin`.

## El método

Diseñado para procrastinadores crónicos, con las técnicas que tienen evidencia detrás:

1. **Captura sin fricción** — todo entra al 📥 Inbox en una línea, sin categorizar ni decidir.
2. **Máximo 3 tareas al día** — el backlog no se mira; compite por 3 cupos.
3. **Micro-pasos** — cada tarea se divide en pasos de ≤15 min; el primero de ≤5 min.
4. **Anti-parálisis** — el prompt `trabado` devuelve UN solo micro-paso, nunca una lista.
5. **Cierre sin culpa** — el `checkin` registra hechos, no reproches.

## Requisitos en ClickUp

Dos listas en tu workspace: **📥 Inbox** (captura cruda) y **🎯 Tareas** (accionables). Copia sus IDs (visibles en la URL de cada lista) al `.env`.

## Configuración

```bash
cp .env.example .env
# 1) CLICKUP_TOKEN: ClickUp → avatar → Settings → Apps → API Token (pk_...)
# 2) PPA_SECRET: openssl rand -hex 24
# 3) INBOX_LIST_ID y TAREAS_LIST_ID: los IDs de tus dos listas
npm install && npm start
# health: curl http://127.0.0.1:5071/ppa-mcp/health
```

La URL del endpoint MCP es `http://127.0.0.1:5071/ppa-mcp/<PPA_SECRET>` (el secreto va en el path para que funcione en clientes sin headers personalizados; también acepta `Authorization: Bearer <PPA_SECRET>`).

## Despliegue en un servidor (detrás de Caddy)

El servicio escucha solo en `127.0.0.1:5071`; Caddy pone el TLS sin abrir puertos nuevos.

```bash
# 1. Copiar el proyecto (sin node_modules ni .env)
rsync -a --exclude node_modules --exclude .env --exclude .git ./ tu-servidor:~/ppa-mcp/

# 2. En el servidor: node >= 20, deps y .env
ssh tu-servidor
cd ~/ppa-mcp && npm install --omit=dev
cp .env.example .env && nano .env

# 3. Servicio systemd (user-level; habilita lingering si no lo tienes:
#    sudo loginctl enable-linger $USER)
mkdir -p ~/.config/systemd/user
cp deploy/ppa-mcp.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ppa-mcp
curl http://127.0.0.1:5071/ppa-mcp/health

# 4. Ruta en Caddy (en el bloque de tu sitio)
#    handle /ppa-mcp/* {
#        reverse_proxy 127.0.0.1:5071
#    }
sudo systemctl reload caddy
```

Endpoint público: `https://<tu-dominio>/ppa-mcp/<PPA_SECRET>`

## Conectar clientes

**Claude Code (cualquier máquina):**

```bash
claude mcp add --transport http --scope user ppa "https://<tu-dominio>/ppa-mcp/<PPA_SECRET>"
```

Los prompts aparecen como `/ppa:captura`, `/ppa:plan-hoy`, `/ppa:trabado`, `/ppa:checkin`.

**claude.ai (web/móvil):** Settings → Connectors → Add custom connector → URL del endpoint (el secreto va en la URL, no requiere OAuth). El conector se sincroniza solo con la app móvil.

## Notas

- El servidor es stateless (un transporte por request); no guarda nada en disco.
- Zona horaria del sistema: America/Bogota (ajústala en `src/clickup.js` si aplica).
- La URL contiene el secreto: trátala como una contraseña. Rotar = cambiar `PPA_SECRET` en `.env`, reiniciar el servicio y actualizar los clientes.
- Complementa bien con rutinas cloud de Claude Code (claude.ai/code/routines) para el plan matutino y el check-in nocturno automáticos.

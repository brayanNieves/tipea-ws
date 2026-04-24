# Secrets — `tipea-ws/functions`

Todos los secretos de las Cloud Functions (claves de APIs, credenciales, API keys propias) viven en **Google Cloud Secret Manager**, integrado con Firebase Functions v2 vía `defineSecret()`.

Los valores **nunca** se guardan en git ni en `.env` — ver [sección "Conflicto con `.env`"](#conflicto-con-env).

---

## Ver los secrets

### 🔗 Dashboard (visual)

Abrí este link directo al Secret Manager del proyecto:

**https://console.cloud.google.com/security/secret-manager?project=styleapp-1e840**

Ahí vas a ver la lista de todos los secretos del proyecto:

| Secret | Usado por | Descripción |
|---|---|---|
| `STRIPE_SECRET_KEY` | `createPaymentIntent` | Clave secreta de Stripe (`sk_live_...` o `sk_test_...`) |
| `SPOTIFY_CLIENT_ID` | `searchTracks` (interno) | Client ID de la app de Spotify Developer |
| `SPOTIFY_CLIENT_SECRET` | `searchTracks` (interno) | Client Secret de la app de Spotify Developer |
| `SEARCH_TRACKS_API_KEY` | `searchTracks` | API key propia que protege el endpoint público |

#### Para ver el VALOR de un secret desde la consola:

1. Entrás al link de arriba
2. Click en el nombre del secret (ej. `SEARCH_TRACKS_API_KEY`)
3. Pestaña **"Versions"**
4. Al lado de la versión activa, click en los **tres puntos ⋮** → **"View secret value"**

Te lo muestra en un popup. Solo funciona si tu usuario tiene rol `Secret Manager Secret Accessor` (los owners del proyecto lo tienen por defecto).

### 🖥 CLI (Firebase)

**Listar nombres de todos los secrets:**
```bash
firebase functions:secrets:list
```

**Ver el valor actual de un secret:**
```bash
firebase functions:secrets:access SEARCH_TRACKS_API_KEY
```

**Ver versiones históricas de un secret:**
```bash
gcloud secrets versions list SEARCH_TRACKS_API_KEY --project styleapp-1e840
```

---

## Crear o rotar un secret

Un solo comando sirve para ambos — si el secret existe, crea una versión nueva; si no, lo crea:

```bash
firebase functions:secrets:set NOMBRE_DEL_SECRET
# te pide el valor — pegalo y enter
```

Después del set, **hay que redeployar** las funciones que lo usan para que tomen la versión nueva:

```bash
firebase deploy --only functions:searchTracks
# o la función que corresponda
```

### Ejemplo — rotar la API key de búsqueda

```bash
# 1. Generar un valor seguro nuevo
openssl rand -hex 32
# copiás el valor

# 2. Setearlo (crea versión nueva, deja la vieja disponible hasta el redeploy)
firebase functions:secrets:set SEARCH_TRACKS_API_KEY

# 3. Redeploy
firebase deploy --only functions:searchTracks
```

Clientes con la key vieja dejan de funcionar después del redeploy.

---

## Borrar un secret

Para destruir completamente un secret (todas las versiones):

```bash
firebase functions:secrets:destroy NOMBRE_DEL_SECRET --force
```

⚠️ Destructivo — no se puede recuperar. Si la función todavía referencia el secret (`defineSecret()` en el código), el próximo deploy va a fallar hasta que lo recrees.

---

## Dónde vive cada secret en el código

| Secret | Archivo que lo define |
|---|---|
| `STRIPE_SECRET_KEY` | `src/config/stripe.ts` |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | `src/config/spotify.ts` |
| `SEARCH_TRACKS_API_KEY` | `src/config/api-keys.ts` |

Cada uno se declara así:
```ts
import { defineSecret } from "firebase-functions/params";
export const miSecret = defineSecret("MI_SECRET");
```

Y se inyecta al handler con la opción `secrets`:
```ts
onCall({ secrets: [miSecret] }, async (req) => {
  const value = miSecret.value(); // solo disponible dentro del handler
});
```

Importante: **`secret.value()` solo funciona en runtime, dentro del handler**. Si lo llamás a nivel de módulo va a lanzar o devolver vacío.

---

## Conflicto con `.env`

Si un secret tiene el mismo nombre que una variable en `functions/.env`, Cloud Run rechaza el deploy con:

```
Secret environment variable overlaps non secret environment variable: XXXXX
```

**Regla:** los secretos van **solo** en Secret Manager — nunca en `.env`. El `.env` es para config no sensible (IDs públicos, URLs, etc.).

Si ves este error, revisá `functions/.env` y borrá la línea con el nombre que causa conflicto.

El archivo `.env` actual tiene comentarios marcando qué nombres son de Secret Manager:

```
# SEARCH_TRACKS_API_KEY is managed via Firebase Secret Manager (firebase functions:secrets:set)
# STRIPE_SECRET_KEY is managed via Firebase Secret Manager (firebase functions:secrets:set)
# SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are managed via Firebase Secret Manager
```

---

## Quién puede ver los secrets

Acceso se controla a nivel de GCP IAM. Por default:

- **Owners del proyecto** (BrayanSoftDev@gmail.com y cualquier otro owner) → pueden ver y modificar todo
- **Service account de Cloud Functions** (`456071465609-compute@developer.gserviceaccount.com`) → solo lectura en runtime
- **Cualquier otro** → sin acceso

Para dar acceso a alguien más (ej. otro dev del equipo), en la consola de GCP:

https://console.cloud.google.com/iam-admin/iam?project=styleapp-1e840

Agregá el rol `Secret Manager Secret Accessor` al usuario. Mejor práctica: darlo a nivel de secret individual, no del proyecto entero.

---

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `Error: In non-interactive mode but have no value for the secret: X` | El secret no existe en Secret Manager | `firebase functions:secrets:set X` |
| `Secret environment variable overlaps non secret environment variable: X` | Misma key en `.env` y Secret Manager | Borrá la línea de `.env` |
| La función se despliega pero falla en runtime con `credentials missing` | El secret existe pero la función no lo declara en `secrets: [...]` | Agregá el secret al array `secrets` del handler y redeployar |
| `firebase functions:secrets:access` devuelve vacío | Secret existe pero no tiene versiones | Correr `firebase functions:secrets:set NOMBRE` de nuevo |
| Redeployé pero la función sigue usando el valor viejo | Instancias viejas todavía corriendo | Esperar unos segundos (Cloud Run reemplaza instancias gradualmente) o forzar con `firebase deploy --only functions:X --force` |

---

## Referencias

- Firebase Secret Manager: https://firebase.google.com/docs/functions/config-env#managing_secrets
- GCP Secret Manager docs: https://cloud.google.com/secret-manager/docs
- Proyecto en consola: https://console.cloud.google.com/security/secret-manager?project=styleapp-1e840

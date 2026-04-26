# API — `tipea-ws/functions`

Documentación de los endpoints de Cloud Functions disponibles para el frontend.

**Project:** `styleapp-1e840`
**Región:** `us-central1`

---

## URLs base

| Tipo | URL base |
|---|---|
| **Callable (`onCall`)** | Se llaman vía Firebase SDK con `httpsCallable(functions, "<nombre>")`. No requieren URL manual. |
| **HTTP (`onRequest`)** | `https://us-central1-styleapp-1e840.cloudfunctions.net/<nombre>` |

---

## Tipos de autenticación

| Mecanismo | Cómo funciona |
|---|---|
| **Firebase Auth** (`onCall`) | El SDK adjunta automáticamente el ID token. En el cliente solo te aseguras de tener un user logueado con `firebase.auth()`. |
| **API key** (`onRequest`) | Header `x-api-key: <SEARCH_TRACKS_API_KEY>`. La key te la doy aparte (no se versiona). |
| **OTP por email** | Endpoints `sendOtp` + `verifyOtp` para validar email antes de signup. |
| **Admin** | Sub-conjunto de Firebase Auth: el user debe tener `role: "admin"` en su doc `users/{uid}`. |

---

## Índice de endpoints

| Endpoint | Tipo | Auth | Para qué |
|---|---|---|---|
| [`createTip`](#createtip) | `onCall` | Firebase Auth | Crear un tip (registra el documento, dispara `onTipCreated`) |
| [`createPaymentIntent`](#createpaymentintent) | `onCall` | Firebase Auth | Crear un Stripe PaymentIntent para cobrar un tip |
| [`sendOtp`](#sendotp) | `onRequest` (POST) | Pública | Enviar código OTP a un email |
| [`verifyOtp`](#verifyotp) | `onRequest` (POST) | Pública | Verificar el código OTP |
| [`searchTracks`](#searchtracks) | `onRequest` (GET/POST) | API key | Buscar canciones en Spotify |
| [`bulkCreateUsers`](#bulkcreateusers) | `onCall` | Admin | Crear varios usuarios de Firebase Auth en una sola llamada |

---

## createTip

Crea un tip en `/tips`. Esto dispara `onTipCreated` que calcula comisión, actualiza summaries, y manda email al staff.

**Cuándo usarlo:** después de que `createPaymentIntent` confirme el pago en Stripe.

### Request

```ts
import { getFunctions, httpsCallable } from "firebase/functions";

const fn = httpsCallable(getFunctions(), "createTip");
const result = await fn({
  amount: 100,                          // RD$ — número entero
  targetUserId: "abc123uidDelStaff",    // UID del staff que recibe la propina
});
```

### Response (éxito)

```json
{
  "success": true,
  "tipId": "tip_xyz",
  "message": "Tip recorded successfully."
}
```

### Errores

| HTTPS code | Cuándo |
|---|---|
| `unauthenticated` | No hay user logueado |
| `invalid-argument` | Falta `amount` o `targetUserId`, o `amount <= 0` |
| `not-found` | El `targetUserId` no existe |
| `internal` | Error inesperado en el server |

---

## createPaymentIntent

Crea un Stripe PaymentIntent para cobrar la propina. Aplica fee de pasarela (configurable) y opcionalmente convierte DOP → USD.

### Request

```ts
const fn = httpsCallable(getFunctions(), "createPaymentIntent");
const result = await fn({
  amount: 100,                          // RD$ original (sin fee)
  targetUserId: "abc123uidDelStaff",
});
```

### Response (éxito)

```json
{
  "clientSecret": "pi_3O1R...secret_xxx",
  "paymentIntentId": "pi_3O1R...",

  "amountPesos": 100,
  "feePct": 7,
  "feeAmount": 7,
  "totalChargedDop": 107,

  "displayAmount": 1.79,
  "displayCurrency": "USD",
  "chargedCurrency": "usd",

  "amountUsd": 1.79,
  "dopRate": 59.741196,
  "rateSource": "api"
}
```

### Cómo usarlo en Apple Pay / Stripe Elements

⚠️ **Importante:** el monto que muestras al usuario en Apple Pay/Google Pay/Stripe Elements debe ser `displayAmount` y la moneda `chargedCurrency`. Si muestras `amount` (el original) pero Stripe cobra `totalChargedDop`/`amountUsd`, el usuario firma por un monto y se le cobra otro.

```js
const { displayAmount, chargedCurrency, clientSecret } = result.data;

const paymentRequest = stripe.paymentRequest({
  country: "US",
  currency: chargedCurrency,            // "usd" o "dop"
  total: {
    label: `Tip for ${waiterName}`,
    amount: Math.round(displayAmount * 100),  // en centavos
  },
});

paymentRequest.on("paymentmethod", async (ev) => {
  const { error } = await stripe.confirmCardPayment(
    clientSecret,
    { payment_method: ev.paymentMethod.id },
    { handleActions: false }
  );
  ev.complete(error ? "fail" : "success");
});
```

### Configuración (Firestore: `appConfig/payment`)

| Campo | Default | Qué hace |
|---|---|---|
| `chargeInUsd` | `false` | `true` = convierte a USD; `false` = cobra en DOP |
| `feePct` | `0` | % que se suma al monto (ej. `7` → cliente paga 107 si el tip es 100) |

### Errores

| HTTPS code | Cuándo |
|---|---|
| `unauthenticated` | No hay user logueado |
| `invalid-argument` | Falta `amount`/`targetUserId`, monto inválido, o el USD convertido cae bajo $0.50 |
| `not-found` | `targetUserId` no existe |
| `failed-precondition` | Stripe no está configurado en el server |
| `unknown` | Stripe rechazó la creación del PaymentIntent |

---

## sendOtp

Genera un OTP de 6 dígitos y lo envía al email indicado. Expira en 10 minutos.

### Request

```bash
curl -X POST https://us-central1-styleapp-1e840.cloudfunctions.net/sendOtp \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

```js
await fetch("https://us-central1-styleapp-1e840.cloudfunctions.net/sendOtp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "user@example.com" }),
});
```

### Response (éxito, 200)

```json
{
  "success": true,
  "message": "Verification code sent to your email."
}
```

### Errores

| HTTP code | Cuándo |
|---|---|
| 400 | Email inválido o ausente |
| 405 | Método distinto a POST |
| 429 | Rate limit (1 request por minuto por email) |
| 500 | Falló el envío del email |

---

## verifyOtp

Verifica el OTP enviado por `sendOtp`. Borra el OTP en éxito.

### Request

```js
await fetch("https://us-central1-styleapp-1e840.cloudfunctions.net/verifyOtp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "user@example.com",
    code: "123456",
  }),
});
```

### Response (éxito, 200)

```json
{
  "success": true,
  "message": "Email verified successfully."
}
```

### Errores

| HTTP code | Cuándo |
|---|---|
| 400 | Falta `email`/`code`, o code no es de 6 dígitos numéricos, o code incorrecto |
| 404 | No existe OTP para ese email (nunca se generó o ya se borró) |
| 405 | Método distinto a POST |
| 410 | OTP expirado |
| 429 | Demasiados intentos fallidos (5+) |

---

## searchTracks

Busca canciones en Spotify. El backend maneja el Bearer token de Spotify internamente — el cliente solo manda la query.

### Auth

Header obligatorio: `x-api-key: <SEARCH_TRACKS_API_KEY>`

### Request

**GET (querystring):**
```bash
curl "https://us-central1-styleapp-1e840.cloudfunctions.net/searchTracks?q=bad%20bunny&limit=20" \
  -H "x-api-key: <SEARCH_TRACKS_API_KEY>"
```

**POST (body JSON):**
```js
await fetch("https://us-central1-styleapp-1e840.cloudfunctions.net/searchTracks", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": SEARCH_TRACKS_API_KEY,
  },
  body: JSON.stringify({ q: "bad bunny", limit: 20 }),
});
```

| Param | Obligatorio | Default | Notas |
|---|---|---|---|
| `q` | ✅ | — | string no vacío |
| `limit` | ❌ | 50 | clamp [1, 50] |
| `offset` | ❌ | 0 | paginación |
| `market` | ❌ | — | ISO country (`DO`, `US`, etc.) |

### Response (éxito, 200)

```json
{
  "tracks": {
    "items": [
      {
        "id": "7ouMYW...",
        "name": "Tití Me Preguntó",
        "duration_ms": 244000,
        "explicit": true,
        "preview_url": "https://...",
        "uri": "spotify:track:...",
        "external_urls": { "spotify": "https://open.spotify.com/track/..." },
        "artists": [{ "id": "...", "name": "Bad Bunny", "uri": "..." }],
        "album": {
          "id": "...",
          "name": "Un Verano Sin Ti",
          "images": [{ "url": "...", "width": 640, "height": 640 }],
          "uri": "..."
        }
      }
    ],
    "total": 1234,
    "limit": 20,
    "offset": 0,
    "next": "https://api.spotify.com/v1/search?offset=20...",
    "previous": null
  }
}
```

### Errores

| HTTP code | Cuándo |
|---|---|
| 400 | Falta `q` o está vacío |
| 401 | Falta el header `x-api-key` |
| 403 | API key inválida |
| 405 | Método distinto a GET/POST |
| 502 | Spotify devolvió error o el token interno falló |

---

## bulkCreateUsers

Crea muchos usuarios de Firebase Auth + sus perfiles en Firestore en una sola llamada. Si no mandas `password`, el backend te genera uno random fuerte y te lo devuelve en la response.

### Auth

- El caller debe estar logueado con Firebase Auth
- El caller debe tener `role: "admin"` en su doc `users/{uid}`

### Request

```ts
const fn = httpsCallable(getFunctions(), "bulkCreateUsers");
const result = await fn({
  users: [
    { name: "Juan Pérez",  email: "j_001@tipapp.tech", role: "waiter" },
    { name: "María DJ",    email: "m_002@tipapp.tech", role: "dj", phone: "+18095551234" },
    { name: "Pedro Test",  email: "p_003@tipapp.tech", role: "bartender", password: "MiPropio1234" },
  ],
});
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `name` | ✅ | string no vacío |
| `email` | ✅ | formato válido, único por user |
| `role` | ✅ | `"dj"`, `"waiter"`, `"vallet"`, `"bartender"`, `"admin"`, `"other"` |
| `password` | ❌ | min 6 chars; si no lo mandas, el backend genera uno |
| `phone` | ❌ | formato E.164 (`+18095551234`) |

**Límite:** máx 100 entries por llamada. Si necesitas más, llama varias veces.

### Response (éxito, 200)

```json
{
  "total": 3,
  "created": 2,
  "failed": 1,
  "results": [
    {
      "email": "j_001@tipapp.tech",
      "uid": "abc123",
      "password": "Bt9-jH4pYn28",
      "generated": true,
      "status": "created"
    },
    {
      "email": "m_002@tipapp.tech",
      "uid": "def456",
      "password": "Pf7-mK3qXr92",
      "generated": true,
      "status": "created"
    },
    {
      "email": "p_003@tipapp.tech",
      "status": "failed",
      "error": "The email address is already in use by another account.",
      "code": "auth/email-already-exists"
    }
  ]
}
```

### ⚠️ Importante: guarda los passwords una sola vez

La response es la **única** vez que vas a ver los passwords en clear text. El backend NO los guarda en Firestore.

Sugerencia de flujo:
1. Llamas `bulkCreateUsers`
2. Exportas `results[].password` a CSV o lista impresa
3. Entregas las credenciales al staff
4. Borras el CSV una vez entregadas las credenciales

Si alguien pierde el password, usa **password reset** (no se puede recuperar el original):

```ts
// Desde el admin dashboard
const link = await admin.auth().generatePasswordResetLink(email);
// O resetear directo:
await admin.auth().updateUser(uid, { password: "NuevoTemp1234" });
```

### Errores por entry (`status: "failed"`)

| `code` | Causa | Cómo arreglar |
|---|---|---|
| `validation/invalid` | Entry mal formado | Revisa el campo que indica el `error` |
| `auth/email-already-exists` | Email ya registrado | Usa otro o borra el existente |
| `auth/invalid-phone-number` | Phone no es E.164 | Formato `+18095551234` |
| `auth/weak-password` | Password muy corto | Min 6 chars |
| `firestore/write-failed` | Auth user creado pero el doc Firestore falló | Estado parcial — revisar logs |

### Errores globales (HTTPS)

| HTTPS code | Cuándo |
|---|---|
| `unauthenticated` | No hay user logueado |
| `permission-denied` | El caller no tiene `role: "admin"` |
| `invalid-argument` | Payload no es `{ users: [...] }`, array vacío, o > 100 entries |

---

## Esquemas de datos relevantes

### `users/{uid}` (Firestore)

```ts
{
  uid: string,                          // mismo que el doc id
  name?: string,
  email?: string,
  phone?: string,
  role?: "dj" | "waiter" | "vallet" | "bartender" | "admin" | "other",
  planId: string,                       // ej. "plan_starter"
  emailVerified?: boolean,
  active?: boolean,
  createdAt: Timestamp
}
```

### `tips/{tipId}` (Firestore)

```ts
{
  userId: string,                       // staff que recibe la propina
  senderUid?: string,                   // user que pagó
  amount: number,                       // RD$ original (sin fee)
  commissionPct?: number,               // calculado por onTipCreated
  commissionAmt?: number,
  netAmount?: number,
  source?: "qr" | "manual",
  status: "pending" | "paid" | "error",
  payoutId?: string | null,
  createdAt: Timestamp
}
```

### `appConfig/payment` (Firestore — config de pagos)

```ts
{
  chargeInUsd: boolean,                 // default false
  feePct: number                        // default 0
}
```

---

## Errores: cómo manejarlos en el cliente

### onCall (Firebase SDK)

```ts
import { httpsCallable, FunctionsError } from "firebase/functions";

try {
  const result = await httpsCallable(getFunctions(), "createTip")({...});
} catch (err) {
  const e = err as FunctionsError;
  switch (e.code) {
    case "functions/unauthenticated":
      // redirigir a login
      break;
    case "functions/invalid-argument":
      // mostrar e.message al user
      break;
    case "functions/not-found":
      // ...
      break;
    default:
      // log + retry o fallback
  }
}
```

### onRequest (fetch directo)

```ts
const res = await fetch(url, {...});
if (!res.ok) {
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error ?? `HTTP ${res.status}`);
}
const data = await res.json();
```

---

## Endpoints **internos** (no llamables desde el frontend)

Estos son triggers/jobs que corren automáticamente:

| Función | Trigger | Qué hace |
|---|---|---|
| `onTipCreated` | Firestore: `tips/{tipId}` (create) | Calcula comisión, actualiza summaries, manda email al staff |
| `onPayoutCreated` | Firestore: `payouts/{payoutId}` (create) | Marca tips como pagados, actualiza counters, manda email |
| `onUserCreated` | Firebase Auth (signup) | Crea `users/{uid}`, `subscriptions/{uid}`, notifica al admin |
| `onDayRollover` | Pub/Sub (cron diario, 0 0 * * * America/Santo_Domingo) | Cierra el `daily_summary` del día anterior |

---

## Setup recomendado en el cliente (TypeScript)

```ts
// firebase-config.ts
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFunctions } from "firebase/functions";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "styleapp-1e840.firebaseapp.com",
  projectId: "styleapp-1e840",
  // ...
});

export const auth = getAuth(app);
export const functions = getFunctions(app, "us-central1");
```

```ts
// api/tips.ts
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase-config";

export const createTip = httpsCallable<
  { amount: number; targetUserId: string },
  { success: boolean; tipId: string; message: string }
>(functions, "createTip");

export const createPaymentIntent = httpsCallable<
  { amount: number; targetUserId: string },
  {
    clientSecret: string;
    paymentIntentId: string;
    amountPesos: number;
    feePct: number;
    feeAmount: number;
    totalChargedDop: number;
    displayAmount: number;
    displayCurrency: "USD" | "DOP";
    chargedCurrency: "usd" | "dop";
    amountUsd: number | null;
    dopRate: number | null;
    rateSource: string | null;
  }
>(functions, "createPaymentIntent");

export const bulkCreateUsers = httpsCallable<
  { users: Array<{ name: string; email: string; password?: string; phone?: string; role: string }> },
  {
    total: number;
    created: number;
    failed: number;
    results: Array<
      | { email: string; uid: string; password: string; generated: boolean; status: "created" }
      | { email: string; status: "failed"; error: string; code?: string }
    >;
  }
>(functions, "bulkCreateUsers");
```

---

## Referencias internas del repo

- Estructura del backend: `functions/src/`
- Manejo de secrets: [`SECRETS.md`](SECRETS.md)
- Configuración del proyecto: `firebase.json`, `.firebaserc`

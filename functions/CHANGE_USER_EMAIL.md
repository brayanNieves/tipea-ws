# `changeUserEmail` — Guía para el frontend

Endpoint admin para cambiar email y/o password de cualquier usuario sin necesidad de saber su password actual.

---

## URL

```
POST https://us-central1-styleapp-1e840.cloudfunctions.net/changeUserEmail
```

---

## Requisitos de auth

1. El usuario que llama tiene que estar **logueado** con Firebase Auth en el frontend
2. Ese usuario tiene que tener `role: "admin"` en su doc `users/{uid}` en Firestore
3. Tienes que mandar el ID token en el header `Authorization: Bearer <token>`

Si no cumples estas tres → 401 o 403.

---

## Headers

| Header | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <ID_TOKEN_DEL_ADMIN_LOGUEADO>` |

Cómo obtener el token:

```js
// SDK clásico (compat)
const idToken = await firebase.auth().currentUser.getIdToken();

// SDK modular (Firebase 9+)
import { getAuth } from "firebase/auth";
const idToken = await getAuth().currentUser.getIdToken();
```

---

## Body (JSON)

```ts
{
  email: string;          // OBLIGATORIO — email actual del user a modificar
  newEmail?: string;      // OPCIONAL — nuevo email
  newPassword?: string;   // OPCIONAL — nuevo password (mín 6 chars)
}
```

**Reglas:**
- `email` siempre obligatorio (sirve para encontrar al user)
- Tienes que mandar **al menos uno** de `newEmail` o `newPassword`
- Puedes mandar los dos juntos para cambiar ambos en una sola llamada
- `newEmail` no puede ser igual al `email`

### Ejemplos válidos del body

**Cambiar solo password:**
```json
{
  "email": "j_001@tipapp.tech",
  "newPassword": "PasswordNuevo123"
}
```

**Cambiar solo email:**
```json
{
  "email": "j_001@tipapp.tech",
  "newEmail": "juan@gmail.com"
}
```

**Cambiar los dos:**
```json
{
  "email": "j_001@tipapp.tech",
  "newEmail": "juan@gmail.com",
  "newPassword": "PasswordNuevo123"
}
```

---

## Response (éxito, 200)

```json
{
  "success": true,
  "uid": "abc123def456",
  "updated": {
    "email": true,
    "password": true
  }
}
```

`updated.email` y `updated.password` te dicen qué se actualizó. Si solo mandaste `newPassword`, viene `email: false`.

### Caso especial: warning

Si Auth se actualiza pero Firestore falla la sincronización del email:

```json
{
  "success": true,
  "uid": "abc123",
  "updated": { "email": true, "password": false },
  "warning": "Auth actualizado pero falló la sincronización del email en Firestore."
}
```

El response sigue siendo 200 (el cambio principal funcionó), pero conviene mostrarle el warning al admin para que sepa que tiene que sincronizar manualmente.

---

## Errores

| HTTP | `error` típico | Cuándo |
|---|---|---|
| 400 | `"Falta o es inválido 'email'."` | Email mal formado o ausente |
| 400 | `"'newEmail' inválido."` | Nuevo email mal formado |
| 400 | `"'newPassword' debe tener al menos 6 caracteres."` | Password muy corto |
| 400 | `"Debe enviar al menos uno de 'newEmail' o 'newPassword'."` | No mandaste ninguno |
| 400 | `"El nuevo email es igual al actual."` | newEmail == email |
| 401 | `"Falta header Authorization: Bearer <idToken>."` | Sin token |
| 401 | `"Token inválido o expirado."` | Token mal formado o vencido |
| 403 | `"Solo administradores pueden cambiar credenciales."` | Caller no es admin |
| 404 | `"No se encontró un usuario con ese email."` | El `email` no existe en Firebase Auth |
| 405 | `"Method not allowed"` | Método distinto a POST |
| 409 | `"El nuevo email ya está en uso por otra cuenta."` | newEmail ya pertenece a otro user |
| 500 | varios | Error inesperado del server |

Forma del body en error:
```json
{ "error": "<mensaje legible para el usuario>" }
```

---

## Código del frontend

### 1. Helper reutilizable (TypeScript) — recomendado

Guárdalo en `src/api/admin-users.ts`:

```ts
import { getAuth } from "firebase/auth";

const CHANGE_USER_EMAIL_URL =
  "https://us-central1-styleapp-1e840.cloudfunctions.net/changeUserEmail";

export interface ChangeUserCredentialsInput {
  email: string;
  newEmail?: string;
  newPassword?: string;
}

export interface ChangeUserCredentialsResult {
  success: true;
  uid: string;
  updated: { email: boolean; password: boolean };
  warning?: string;
}

/**
 * Cambia email y/o password de un usuario.
 * Solo funciona si el caller logueado es admin (role: "admin" en su doc).
 */
export async function changeUserEmail(
  input: ChangeUserCredentialsInput
): Promise<ChangeUserCredentialsResult> {
  const user = getAuth().currentUser;
  if (!user) throw new Error("Debes estar logueado.");
  const idToken = await user.getIdToken();

  const res = await fetch(CHANGE_USER_EMAIL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}
```

Uso:

```ts
import { changeUserEmail } from "./api/admin-users";

try {
  const result = await changeUserEmail({
    email: "j_001@tipapp.tech",
    newEmail: "juan@gmail.com",
    newPassword: "Nuevo1234",
  });

  console.log("UID:", result.uid);
  console.log("Email cambiado:", result.updated.email);
  console.log("Password cambiado:", result.updated.password);
  if (result.warning) {
    alert(result.warning);
  }
} catch (err) {
  alert((err as Error).message);
}
```

### 2. Plain JavaScript (sin TypeScript)

```js
async function changeUserEmail(input) {
  const idToken = await firebase.auth().currentUser.getIdToken();

  const res = await fetch(
    "https://us-central1-styleapp-1e840.cloudfunctions.net/changeUserEmail",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(input),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Uso
changeUserEmail({
  email: "j_001@tipapp.tech",
  newPassword: "Nuevo1234",
})
  .then((r) => console.log("OK:", r))
  .catch((e) => alert(e.message));
```

### 3. Componente React de ejemplo

```tsx
import { useState } from "react";
import { changeUserEmail } from "./api/admin-users";

export function ChangeUserCredentialsForm() {
  const [email, setEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const data = await changeUserEmail({
        email,
        newEmail: newEmail || undefined,
        newPassword: newPassword || undefined,
      });
      setResult(
        `✅ Actualizado: email=${data.updated.email}, password=${data.updated.password}`
      );
    } catch (err) {
      setResult(`❌ ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        placeholder="Email actual del user"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="email"
        placeholder="Nuevo email (opcional)"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Nuevo password (opcional, mín 6)"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
      />
      <button type="submit" disabled={loading}>
        {loading ? "Procesando..." : "Cambiar credenciales"}
      </button>
      {result && <p>{result}</p>}
    </form>
  );
}
```

### 4. cURL (para testing/Postman)

```bash
ID_TOKEN="<pegar aquí el ID token del admin>"

curl -X POST https://us-central1-styleapp-1e840.cloudfunctions.net/changeUserEmail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -d '{
    "email": "j_001@tipapp.tech",
    "newEmail": "juan@gmail.com",
    "newPassword": "Nuevo1234"
  }'
```

Para sacar el ID token desde tu app durante testing, en la consola del navegador:

```js
firebase.auth().currentUser.getIdToken().then(console.log)
```

Copias el resultado y lo pegas en `$ID_TOKEN`.

---

## Patrón de manejo de errores recomendado

```ts
try {
  const result = await changeUserEmail({ email, newEmail, newPassword });
  // éxito
} catch (err) {
  const msg = (err as Error).message;

  // 401 / 403 → admin no autorizado
  if (msg.includes("Authorization") || msg.includes("administradores")) {
    alert("No tienes permisos. Contacta al administrador.");
    return;
  }

  // 404 → el user no existe
  if (msg.includes("No se encontró")) {
    alert("Ese email no está registrado.");
    return;
  }

  // 409 → el nuevo email ya existe
  if (msg.includes("ya está en uso")) {
    alert("Ese nuevo email ya pertenece a otra cuenta.");
    return;
  }

  // genérico
  alert(`Error: ${msg}`);
}
```

---

## Cosas a tener en cuenta

1. **`emailVerified` se resetea**: cuando cambias el email, el flag `emailVerified` vuelve a `false` en Auth y en Firestore. Si tu app gating por email verificado, el user va a tener que re-verificar.

2. **El user afectado pierde su sesión activa**: cuando le cambias el password (o el email), Firebase invalida los tokens activos del user afectado. Si está logueado en otra parte, le va a pedir login de nuevo.

3. **No se le notifica al user**: el endpoint solo cambia las credenciales. Si quieres mandarle un email avisándole "tu password fue cambiado por un admin", eso lo tienes que hacer aparte.

4. **El admin que llama no se desloguea**: solo el user objetivo del cambio pierde su sesión. Tu sesión de admin sigue válida.

5. **No hay confirmación de password actual**: el endpoint no pide el password viejo del user a modificar. Esto es por diseño (los users masivos tienen passwords random que el admin no conoce).

6. **Validación previa de email**: antes de actualizar, el backend chequea si el `newEmail` ya está en Firebase Auth. Si lo está, rechaza con 409 sin tocar nada. Esto evita estados parciales.

---

## Referencias internas

- Implementación del endpoint: `src/modules/users/change-email.controller.ts`
- Helper de admin check: `src/shared/auth/is-admin.ts`
- Documentación general de la API: [`API.md`](API.md)
- Manejo de secrets: [`SECRETS.md`](SECRETS.md)

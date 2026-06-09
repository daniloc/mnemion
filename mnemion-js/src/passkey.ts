import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { PRODUCT_NAME } from "./constants";

// === Types ===

export interface StoredPasskey {
  credential_id: string;   // base64url
  public_key: string;      // base64url (raw SPKI bytes)
  counter: number;
  transports: string;      // JSON array of AuthenticatorTransportFuture
}

// === Server-side WebAuthn operations ===

function getRpID(request: Request): string {
  return new URL(request.url).hostname;
}

function getOrigin(request: Request): string {
  return new URL(request.url).origin;
}

export async function beginRegistration(request: Request) {
  const rpID = getRpID(request);

  const options = await generateRegistrationOptions({
    rpName: PRODUCT_NAME,
    rpID,
    userName: "owner",
    userDisplayName: `${PRODUCT_NAME} Owner`,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      // Require user verification (biometric/PIN). The passkey gates the entire
      // OAuth grant and browser session, so it must be a true second factor, not
      // mere possession of an unlocked device.
      userVerification: "required",
    },
  });

  return { options, challenge: options.challenge };
}

export async function completeRegistration(
  request: Request,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<StoredPasskey> {
  const rpID = getRpID(request);
  const origin = getOrigin(request);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const { credential } = verification.registrationInfo;
  // Encode publicKey bytes as base64url for storage
  const keyBytes = credential.publicKey;
  const b64Key = btoa(String.fromCharCode(...keyBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return {
    credential_id: credential.id,
    public_key: b64Key,
    counter: credential.counter,
    transports: JSON.stringify(response.response.transports ?? []),
  };
}

export async function beginAuthentication(
  request: Request,
  stored: StoredPasskey,
) {
  const rpID = getRpID(request);
  const transports: AuthenticatorTransportFuture[] = JSON.parse(stored.transports || "[]");

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [{
      id: stored.credential_id,
      transports,
    }],
    userVerification: "required",
  });

  return { options, challenge: options.challenge };
}

export async function completeAuthentication(
  request: Request,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  stored: StoredPasskey,
): Promise<{ verified: boolean; newCounter: number }> {
  const rpID = getRpID(request);
  const origin = getOrigin(request);

  // Decode stored public key from base64url back to Uint8Array
  const b64 = stored.public_key.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const keyBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) keyBytes[i] = binary.charCodeAt(i);

  const transports: AuthenticatorTransportFuture[] = JSON.parse(stored.transports || "[]");

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: stored.credential_id,
      publicKey: keyBytes,
      counter: stored.counter,
      transports,
    },
  });

  // A verified assertion that carries no authenticationInfo is anomalous —
  // treat it as a failure rather than silently preserving the old counter, which
  // would mask a missing/regressed signature counter (clone-detection signal).
  if (verification.verified && !verification.authenticationInfo) {
    return { verified: false, newCounter: stored.counter };
  }

  return {
    verified: verification.verified,
    newCounter: verification.authenticationInfo?.newCounter ?? stored.counter,
  };
}

// === HTML pages ===

/** Passkey registration page. Shown at /setup?token=SECRET */
export function setupPage(token: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME} — Setup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.4em; }
    p { color: #555; line-height: 1.5; }
    button { display: block; width: 100%; padding: 12px; margin: 8px 0; font-size: 1em;
      border: 1px solid #111; border-radius: 6px; cursor: pointer; background: #111; color: #fff; }
    button:hover { background: #333; }
    button:disabled { background: #999; border-color: #999; cursor: default; }
    #status { margin-top: 12px; }
    .ok { color: #080; }
    .err { color: #c00; }
  </style>
</head>
<body>
  <h1>${PRODUCT_NAME}</h1>
  <p>Register a passkey to sign in with biometrics instead of a password.</p>
  <button id="register">Register passkey</button>
  <div id="status"></div>
  <script type="module">
    import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@13';

    const status = document.getElementById('status');
    const btn = document.getElementById('register');
    const token = ${JSON.stringify(token)};

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.textContent = '';
      try {
        const beginRes = await fetch('/setup/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!beginRes.ok) {
          throw new Error((await beginRes.json()).error || 'Failed to start registration');
        }
        const { options, cid } = await beginRes.json();

        const credential = await startRegistration({ optionsJSON: options });

        const completeRes = await fetch('/setup/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, credential, cid }),
        });
        const result = await completeRes.json();
        if (result.ok) {
          status.innerHTML = '<span class="ok">Passkey registered. You can close this page.</span>';
        } else {
          throw new Error(result.error || 'Verification failed');
        }
      } catch (err) {
        // Use textContent, not innerHTML — err.message can originate from a
        // server-supplied error string and must not be rendered as markup.
        const span = document.createElement('span');
        span.className = 'err';
        span.textContent = err.message || 'Registration failed';
        status.replaceChildren(span);
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

/** Login page — passkey-first with secret fallback */
export function passkeyLoginPage(authStateId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.4em; }
    button { display: block; width: 100%; padding: 12px; margin: 8px 0; font-size: 1em;
      border: 1px solid #111; border-radius: 6px; cursor: pointer; background: #111; color: #fff; }
    button:hover { background: #333; }
    button:disabled { background: #999; border-color: #999; cursor: default; }
    input { display: block; width: 100%; padding: 10px; margin: 8px 0; font-size: 1em;
      border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
    .divider { text-align: center; color: #999; margin: 16px 0; font-size: 0.9em; }
    #secret-form { display: none; }
    #toggle { background: none; color: #555; border: none; text-decoration: underline;
      cursor: pointer; font-size: 0.9em; padding: 4px; width: auto; display: inline; }
    #error { color: #c00; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>${PRODUCT_NAME}</h1>
  <button id="passkey-btn">Sign in with passkey</button>
  <div class="divider">or</div>
  <button id="toggle">Use master secret instead</button>
  <form id="secret-form">
    <input type="password" id="secret" placeholder="Master secret or one-time code" />
    <button type="submit">Sign in</button>
  </form>
  <div id="error"></div>
  <script type="module">
    import { startAuthentication } from 'https://esm.sh/@simplewebauthn/browser@13';

    const authStateId = ${JSON.stringify(authStateId)};
    const errorEl = document.getElementById('error');
    const passkeyBtn = document.getElementById('passkey-btn');
    const toggle = document.getElementById('toggle');
    const secretForm = document.getElementById('secret-form');

    // Passkey auth
    passkeyBtn.addEventListener('click', async () => {
      passkeyBtn.disabled = true;
      errorEl.textContent = '';
      try {
        const beginRes = await fetch('/auth/passkey/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authStateId }),
        });
        if (!beginRes.ok) throw new Error('Failed to start authentication');
        const options = await beginRes.json();

        const assertion = await startAuthentication({ optionsJSON: options });

        const completeRes = await fetch('/auth/passkey/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authStateId, assertion }),
        });
        const result = await completeRes.json();
        if (result.redirectTo) {
          window.location.href = result.redirectTo;
        } else {
          throw new Error(result.error || 'Authentication failed');
        }
      } catch (err) {
        errorEl.textContent = err.message || 'Passkey authentication failed';
        passkeyBtn.disabled = false;
      }
    });

    // Toggle secret form
    toggle.addEventListener('click', () => {
      secretForm.style.display = secretForm.style.display === 'none' ? 'block' : 'none';
      toggle.style.display = 'none';
    });

    // Secret auth (fallback)
    secretForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const secret = document.getElementById('secret').value;
      const res = await fetch('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authStateId, secret }),
      });
      const result = await res.json();
      if (result.redirectTo) {
        window.location.href = result.redirectTo;
      } else {
        errorEl.textContent = result.error || 'Authentication failed';
      }
    });
  </script>
</body>
</html>`;
}

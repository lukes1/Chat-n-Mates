# ChatWave (WhatsApp-like Demo)

Fullstack Demo mit:
- Private 1:1 Chats in Echtzeit
- Status-Updates (laufen nach 24h ab)
- 1:1 Audio/Video-Anrufe via WebRTC (Signaling über Socket.IO)

## Lokal starten

```bash
npm install
npm start
```

Dann im Browser:

`http://localhost:3000`

## Online deployen (Render)

1. Code in ein GitHub-Repo pushen.
2. Auf https://render.com einloggen.
3. `New +` -> `Blueprint` wählen.
4. Dein Repository verbinden.
5. Render liest automatisch `render.yaml`.
6. Deploy starten.
7. Nach dem Deploy bekommst du eine URL wie:
   `https://chatwave-xxxx.onrender.com`

Diese URL kannst du deinen Freunden schicken. Alle, die gleichzeitig online sind, sehen sich in der Kontaktliste und koennen direkt chatten/anrufen.

## Wichtige Env-Variablen

- `PORT` wird vom Hoster gesetzt.
- `ENABLE_BOTS`:
  - `false` (empfohlen fuer echte Nutzung mit Freunden)
  - `true` (wenn du Test-Bots willst)

## Hinweise

- Daten liegen aktuell nur im RAM (keine DB).
- Keine Authentifizierung/Ende-zu-Ende-Verschluesselung.
- Fuer Produktion fehlen u.a. TURN-Server, Persistenz, Security-Hardening, mobile Push.

# Tommi Brain

Un archivio personale self-hosted per cartelle, note Markdown e allegati. I dati sono file reali sul disco: nessun database e nessun formato proprietario.

## Funzioni già disponibili

- Navigazione tra cartelle e sottocartelle, con creazione, rinomina, spostamento ed eliminazione.
- Creazione, lettura, modifica e anteprima di note Markdown, con tabelle, checklist, immagini, link interni e barra di formattazione; modifica anche di altri file di testo comuni.
- Ricerca nei nomi e nel contenuto dei file di testo.
- Caricamento di allegati fino a 25 MB, download e anteprima di immagini/PDF; inserimento degli allegati direttamente nelle note.
- Cestino con ripristino, cronologia delle ultime 50 versioni per file di testo e backup giornalieri automatici con conservazione configurabile.
- Collegamenti `[[tra note]]`, collegamenti in uscita e note che citano quella aperta.
- Proprietà `tags`, `stato` e `data` nel frontmatter YAML, più modelli predefiniti e modelli creati dalle proprie note.
- Accesso con password, cookie di sessione e token opzionale per client server-to-server.
- API HTTP separata dall’interfaccia e server MCP remoto integrato con OAuth per ChatGPT.

Per creare una sottocartella, apri la cartella padre e premi **Sottocartella**. Puoi ripetere l’operazione a qualsiasi livello; le sottocartelle appaiono anche nell’albero laterale.

## Avvio locale

Richiede Node.js 22 o superiore. Non ci sono dipendenze npm da installare.

```bash
cp .env.example .env
```

Apri `.env`, imposta una password lunga e una chiave casuale di almeno 32 caratteri. Per generarne una:

```bash
openssl rand -hex 32
```

Poi avvia:

```bash
npm start
```

Apri `http://127.0.0.1:3000`. La cartella predefinita dei dati è `./data` ed è esclusa da Git.

## Installazione su VPS IONOS

Per Ubuntu 24.04, l’utente sudo `deploy`, Nginx già presente e `brain.produceavalue.com`, segui la [guida passo passo](docs/deploy-ionos.md). I file [`deploy/tommi-brain.service`](deploy/tommi-brain.service) e [`deploy/brain.nginx.conf`](deploy/brain.nginx.conf) sono predisposti per questa VPS.

Per ripristinare un backup completo, ferma il servizio, conserva una copia della cartella dati corrente, copia il contenuto della cartella di backup scelta in `BRAIN_DATA_DIR`, controlla proprietà e permessi dei file, poi riavvia il servizio. Il pannello **Backup** mostra le copie disponibili e permette di crearne una subito.

L’app web è in esecuzione sulla VPS; dopo ogni aggiornamento esegui `git pull --ff-only`, installa le dipendenze con `npm ci --omit=dev` e riavvia il servizio.

## API e integrazione MCP

L’interfaccia usa gli endpoint descritti in [`docs/api.md`](docs/api.md). Il server MCP integrato espone strumenti di lettura e modifica su `/mcp`; usa l’API HTTP locale con un token interno temporaneo. Per l’autenticazione di ChatGPT pubblica un flusso OAuth 2.1 con PKCE, che richiede la password personale di Brain. La [guida MCP per ChatGPT](docs/mcp-chatgpt.md) descrive deploy, strumenti e connessione. La configurazione del plugin privato è in [`plugin/tommi-brain`](plugin/tommi-brain).

Una futura app desktop Tauri per macOS potrà riutilizzare l’interfaccia e comunicare con questa API. L’autenticazione e la conservazione sicura delle credenziali nel client desktop verranno progettate nella fase Tauri.

## Limiti attuali

- L’anteprima Markdown copre le funzioni più comuni, incluse tabelle e checklist. Diagrammi e plugin Obsidian non sono ancora supportati.
- I link a immagini incorporate funzionano per gli allegati locali; le immagini remote non vengono caricate.
- Il cestino non viene svuotato automaticamente. Le versioni sono limitate alle ultime 50 per percorso. I backup locali non sostituiscono una copia fuori dalla VPS.
- Un solo utente, una sola password. Non ci sono permessi o condivisione tra utenti.
- La ricerca legge i file di testo sul disco; per archivi molto grandi servirà un indice.

## Verifica

```bash
npm test
```

# MCP di Brain per ChatGPT e Claude

Brain espone un server MCP Streamable HTTP su `https://brain.produceavalue.com/mcp`. Usa lo stesso processo Node e la stessa logica dei file dell’app web. Nginx esistente inoltra già tutte le richieste, quindi non serve un altro servizio o una nuova porta.

## Deploy sulla VPS

Come utente `deploy`:

```bash
cd /opt/tommi-brain
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart tommi-brain
sudo systemctl status tommi-brain --no-pager
curl -sS https://brain.produceavalue.com/.well-known/oauth-protected-resource | python3 -m json.tool
curl -sS https://brain.produceavalue.com/.well-known/oauth-authorization-server | python3 -m json.tool
```

La prima risposta deve indicare `resource: https://brain.produceavalue.com/mcp`; la seconda deve pubblicare gli endpoint `/oauth/authorize` e `/oauth/token` e PKCE `S256`. Non è necessario aggiungere `BRAIN_API_TOKEN` al file d’ambiente: il processo genera un token interno temporaneo per le chiamate MCP → API. Se lo usi già per altri client, il valore resta valido.

## Disponibilità in ChatGPT

Il pacchetto privato in `plugin/tommi-brain/` dichiara il server remoto in `mcp.json`. ChatGPT lo contrassegna come **Desktop only**, anche se l’URL MCP è pubblico e usa HTTPS. Per collegare Brain direttamente all’account, usa invece **Plugins → Aggiungi server MCP personalizzato** e l’URL `https://brain.produceavalue.com/mcp`. Dopo averlo creato e installato, verifica la disponibilità sul tuo iPhone: questa procedura registra una connessione diversa dal pacchetto ZIP.

Riferimenti: [limitazione Desktop only dei pacchetti importati](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt) e [procedura per aggiungere direttamente un server MCP](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Per usare i file da iPhone senza ChatGPT, apri `https://brain.produceavalue.com` in Safari e accedi con la password Brain.

## Collegamento diretto a ChatGPT

Apri **ChatGPT → Plugins → Aggiungi server MCP personalizzato** e usa `https://brain.produceavalue.com/mcp`. Se il modulo chiede il tipo di autenticazione, seleziona **OAuth** con registrazione **CIMD**. ChatGPT aprirà una pagina su Brain: inserisci la password di Brain e autorizza l’accesso. La connessione usa i permessi `brain.read` e `brain.write`. La definizione del pacchetto desktop è in `plugin/tommi-brain/` e non contiene credenziali.

Puoi provare in una nuova chat: “Mostrami le cartelle del mio Brain”, “Cerca le note che parlano di …”, “Crea una nota …”. Per aggiornare una nota, ChatGPT deve prima leggerla e passare `modified_at`; se il file è cambiato nel frattempo, Brain rifiuta la sovrascrittura. Spostamenti nel cestino e ripristini di versioni sono annotati come operazioni distruttive.

## Strumenti

| Lettura | Scrittura |
| --- | --- |
| `get_profile`, `list_folders`, `list_items`, `search_files`, `read_file`, `get_links` | `create_folder`, `create_note`, `update_note`, `move_item` |
| `list_trash`, `list_versions`, `read_version` | `delete_item`, `restore_item`, `restore_version` |

`read_file` restituisce fino a 12.000 caratteri per chiamata per impostazione predefinita e può leggere sezioni successive con `start` e `max_chars`. Gli allegati binari restano gestiti dall’interfaccia web; via MCP si vedono nell’elenco dei file ma non si caricano o scaricano.

## Sicurezza e manutenzione

La password non è inviata a ChatGPT come strumento: viene inserita direttamente nella pagina HTTPS di Brain durante il collegamento. Il server accetta solo gli identificatori CIMD ufficiali configurati di ChatGPT e Claude e i rispettivi redirect registrati, richiede PKCE `S256` e verifica firma, durata, risorsa e permessi di ogni token. Gli access token durano un’ora; i refresh token durano 30 giorni e vengono sostituiti a ogni rinnovo. Il registro dei token già consumati è conservato in `.brain/oauth-refresh-used.json`, così il riutilizzo resta bloccato anche dopo un riavvio. Ruotare `BRAIN_SESSION_SECRET` invalida tutti i token OAuth e le sessioni web, quindi richiede un nuovo collegamento.

L’endpoint di autorizzazione accetta solo i client ChatGPT e Claude configurati. Claude Code, che usa un’identità e un callback locale diversi, non è incluso in questa configurazione. Per altri client MCP servono un client OAuth separato o un’estensione del server. Il server MCP usa solo HTTPS in produzione; non pubblicare direttamente la porta Node `32147`.

## Collegamento a Claude

Dopo il deploy, apri **Customize → Connectors → + Add → Add custom connector** in Claude (per un’organizzazione, l’Owner usa **Organization settings → Connectors → Add → Custom → Web**).

1. Nome: **Tommi Brain**.
2. URL del server: `https://brain.produceavalue.com/mcp`, quindi **Continue**.
3. Autenticazione: **Sign in now**.
4. OAuth client: **Use Claude’s published identity (Recommended)**. Non scegliere Register automatically: Brain usa CIMD e non espone DCR.
5. Lascia vuoti client secret e request headers. Se viene chiesto il trasporto, usa **Streamable HTTP**.
6. Aggiungi e connetti. La pagina Brain deve indicare **Collega Claude a Brain** e `claude.ai` come destinazione: inserisci la password Brain e autorizza.
7. In una chat Claude, abilita Brain da **+ → Connectors**. Prova a elencare le cartelle, creare una nota e rileggerla.

L’identità accettata è `https://claude.ai/oauth/mcp-oauth-client-metadata`, con callback esatto `https://claude.ai/api/mcp/auth_callback`. Il server pubblica i metadati CIMD e risponde HTTP 401 alle richieste MCP senza un access token valido, includendo `WWW-Authenticate` per la scoperta OAuth. Non occorrono nuove porte o modifiche a Nginx. ChatGPT mantiene la propria identità e i suoi token; codici e refresh token non sono intercambiabili tra i due client.

Riferimenti ufficiali: [guida ai connettori personalizzati](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [requisiti di autenticazione](https://claude.com/docs/connectors/building/authentication), [identità pubblicata di Claude](https://claude.ai/oauth/mcp-oauth-client-metadata).

La verifica automatica copre login, callback, creazione/lettura, PKCE, isolamento tra client e rinnovo token dopo riavvio. La connessione effettiva nell’account Claude va verificata dopo il deploy.

# MCP di Brain per ChatGPT

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

## Collegamento a ChatGPT

Apri **ChatGPT → Plugins → Aggiungi server MCP personalizzato** e usa `https://brain.produceavalue.com/mcp`. Se il modulo chiede il tipo di autenticazione, seleziona **OAuth** con registrazione **CIMD**. ChatGPT aprirà una pagina su Brain: inserisci la password di Brain e autorizza l’accesso. Il plugin privato usa i permessi `brain.read` e `brain.write`. La definizione portabile è in `plugin/tommi-brain/` e non contiene credenziali.

Puoi provare in una nuova chat: “Mostrami le cartelle del mio Brain”, “Cerca le note che parlano di …”, “Crea una nota …”. Per aggiornare una nota, ChatGPT deve prima leggerla e passare `modified_at`; se il file è cambiato nel frattempo, Brain rifiuta la sovrascrittura. Spostamenti nel cestino e ripristini di versioni sono annotati come operazioni distruttive.

## Strumenti

| Lettura | Scrittura |
| --- | --- |
| `get_profile`, `list_folders`, `list_items`, `search_files`, `read_file`, `get_links` | `create_folder`, `create_note`, `update_note`, `move_item` |
| `list_trash`, `list_versions`, `read_version` | `delete_item`, `restore_item`, `restore_version` |

`read_file` restituisce fino a 12.000 caratteri per chiamata per impostazione predefinita e può leggere sezioni successive con `start` e `max_chars`. Gli allegati binari restano gestiti dall’interfaccia web; via MCP si vedono nell’elenco dei file ma non si caricano o scaricano.

## Sicurezza e manutenzione

La password non è inviata a ChatGPT come strumento: viene inserita direttamente nella pagina HTTPS di Brain durante il collegamento. Il server accetta solo l’identificatore CIMD ufficiale di ChatGPT e il suo redirect registrato, richiede PKCE `S256` e verifica firma, durata, risorsa e permessi di ogni token. Gli access token durano un’ora; i refresh token durano 30 giorni. Ruotare `BRAIN_SESSION_SECRET` invalida tutti i token OAuth e le sessioni web, quindi richiede un nuovo collegamento.

L’endpoint di autorizzazione accetta solo il client ChatGPT configurato. Per altri client MCP servono un client OAuth separato o un’estensione del server. Il server MCP usa solo HTTPS in produzione; non pubblicare direttamente la porta Node `32147`.

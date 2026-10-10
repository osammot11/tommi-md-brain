# API HTTP v1

Tutti i percorsi dei file sono relativi alla cartella dati e usano `/` come separatore. I percorsi nascosti, `..` e i link simbolici vengono rifiutati. Le risposte JSON di errore hanno forma `{ "error": "..." }`.

Autenticazione browser: `POST /api/login` con `{ "password": "..." }` crea un cookie HttpOnly. `POST /api/logout` lo cancella. `GET /api/session` restituisce `{ "authenticated": true|false }`.

Autenticazione per futuri client MCP: imposta `BRAIN_API_TOKEN` (almeno 32 caratteri) e invia `Authorization: Bearer <token>`. Usa HTTPS. Non inserire il token nel codice del frontend o negli URL.

| Metodo | Endpoint | Scopo |
| --- | --- | --- |
| GET | `/api/tree` | Albero delle cartelle |
| GET | `/api/trash` | Elementi nel cestino |
| POST | `/api/trash/restore` | Ripristina: `{ "id": "..." }` |
| GET | `/api/versions?path=Nota.md` | Versioni precedenti |
| GET | `/api/version?id=...` | Contenuto di una versione |
| POST | `/api/versions/restore` | Ripristina una versione: `{ "id": "..." }` |
| GET/POST | `/api/backups` | Elenca o crea un backup completo |
| GET/POST/DELETE | `/api/templates` | Elenca, crea o elimina modelli personali |
| GET | `/api/resolve?from=Nota.md&target=Altra` | Risolvi un collegamento interno |
| GET | `/api/links?path=Nota.md` | Collegamenti in uscita e note che citano la nota |
| GET | `/api/items?path=Cartella` | Contenuto di una cartella |
| GET | `/api/search?q=testo` | Ricerca per nome e contenuto |
| GET | `/api/file?path=Nota.md` | Contenuto e metadati di un file di testo |
| GET | `/api/file?path=Nota.md&download=1` | Download di qualsiasi file |
| GET | `/api/raw?path=Immagine.png` | Anteprima inline per immagini e PDF |
| POST | `/api/folders` | Crea cartella: `{ "path": "Cartella" }` |
| POST | `/api/files` | Crea file di testo: `{ "path": "Nota.md", "content": "..." }` |
| PUT | `/api/file` | Salva: `{ "path": "Nota.md", "content": "...", "modifiedAt": "..." }` |
| POST | `/api/upload?path=File.pdf` | Carica file binario nel corpo della richiesta |
| POST | `/api/move` | Sposta o rinomina: `{ "from": "...", "to": "..." }` |
| DELETE | `/api/items` | Sposta nel cestino file/cartella: `{ "path": "..." }` |

`PUT /api/file` restituisce HTTP 409 se `modifiedAt` non corrisponde alla versione sul disco. Creazione, caricamento e spostamento restituiscono 409 se la destinazione esiste già. L’upload è limitato a 25 MB, l’editor a 2 MB per file.

Per un MCP, le prime operazioni naturali sono `list_folders`, `list_items`, `read_file`, `search_files`, `create_note`, `update_note`, `move_item` e `delete_item`. Le operazioni distruttive dovrebbero chiedere conferma nell’esperienza del plugin.

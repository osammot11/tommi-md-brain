# Deploy su IONOS: Ubuntu 24.04

Questa guida usa l’utente `deploy`, systemd, Node.js 24 LTS e Caddy per `brain.produceavalue.com`. Esegui i comandi sulla VPS via SSH come `deploy`, salvo dove è indicato il pannello IONOS. Non copiare la cartella locale `data` né il file `.env` nel repository.

## 1. Controlli iniziali

```bash
whoami
sudo -v
cat /etc/os-release
node --version 2>/dev/null || true
sudo ss -ltnp | grep -E ':(80|443|3000)\b' || true
sudo ufw status
```

`whoami` deve stampare `deploy`. Se le porte 80 o 443 sono già occupate da Nginx, Apache o un altro proxy, integra questo sito nel proxy esistente: non sostituire il servizio né la sua configurazione.

## 2. DNS

Nel pannello IONOS, sotto **Domini e SSL → produceavalue.com → DNS**, aggiungi o modifica un record **A** con host `brain` e indirizzo IPv4 pubblico della VPS. Elimina eventuali record A/AAAA per `brain` che puntano altrove. Crea un record AAAA solo se hai IPv6 configurato sulla VPS. Dal server verifica:

```bash
getent ahostsv4 brain.produceavalue.com
```

Deve apparire l’IPv4 pubblico della VPS. La propagazione DNS può richiedere tempo.

## 3. Node.js e Git

Se `node --version` mostra già la versione 22 o 24 e `command -v node` restituisce `/usr/bin/node`, puoi saltare l’installazione di Node. Altrimenti installa Node.js 24 LTS dal repository NodeSource. Scarica lo script separatamente prima di eseguirlo:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup_24.sh
sudo bash /tmp/nodesource_setup_24.sh
sudo apt install -y nodejs
node --version
command -v node
```

Il servizio incluso si aspetta `/usr/bin/node`. Se il percorso è diverso, modifica `ExecStart` nel file service prima di installarlo. Non serve `npm install`: il progetto non ha dipendenze npm.

## 4. Codice, dati e credenziali

```bash
sudo install -d -o deploy -g deploy -m 755 /opt/tommi-brain
git clone https://github.com/osammot11/tommi-md-brain.git /opt/tommi-brain
sudo install -d -o deploy -g deploy -m 700 /var/lib/tommi-brain /var/lib/tommi-brain-backups
sudo install -m 600 -o root -g root /dev/null /etc/tommi-brain.env
sudo nano /etc/tommi-brain.env
```

Inserisci nel file le righe seguenti. Sostituisci la password con una password lunga e unica; genera la chiave di sessione con `openssl rand -hex 32`. Non inviare questi valori in chat e non usare gli esempi letteralmente.

```ini
BRAIN_PASSWORD=LA_TUA_PASSWORD_LUNGA_E_UNICA
BRAIN_SESSION_SECRET=LA_CHIAVE_CASUALE_GENERATA
BRAIN_DATA_DIR=/var/lib/tommi-brain
BRAIN_BACKUP_DIR=/var/lib/tommi-brain-backups
BRAIN_BACKUP_RETENTION=7
PORT=3000
BRAIN_SECURE_COOKIE=1
```

L’app non accetta la password di esempio né una chiave di sessione inferiore a 32 caratteri. Usa una password senza spazi, virgolette o caratteri speciali interpretati dal formato `EnvironmentFile`; in alternativa chiedi aiuto per verificare l’escaping.

## 5. Servizio systemd

```bash
sudo cp /opt/tommi-brain/deploy/tommi-brain.service /etc/systemd/system/tommi-brain.service
sudo systemctl daemon-reload
sudo systemctl enable --now tommi-brain
sudo systemctl status tommi-brain --no-pager
curl -I http://127.0.0.1:3000/
```

Il test locale deve dare `HTTP/1.1 200 OK`. Se il servizio fallisce, leggi `sudo journalctl -u tommi-brain -n 80 --no-pager`. La porta 3000 deve restare chiusa verso Internet; Node ascolta solo su `127.0.0.1`.

## 6. Caddy e HTTPS

Se Caddy non è già installato e le porte 80/443 sono libere, installalo tramite il repository ufficiale:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Se l’attuale `/etc/caddy/Caddyfile` serve altri siti, aggiungi il blocco contenuto in `/opt/tommi-brain/deploy/Caddyfile` al file esistente. Se è la configurazione predefinita e non hai altri siti, puoi sostituirla conservando una copia:

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-brain
sudo cp /opt/tommi-brain/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Apri le porte TCP 80 e 443 nel firewall della VPS nel pannello IONOS. Se UFW è attivo, esegui anche:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Mantieni aperta la porta SSH in uso. Caddy ottiene e rinnova automaticamente il certificato HTTPS quando DNS e porte 80/443 sono corretti.

## 7. Verifica e aggiornamenti

```bash
curl -I https://brain.produceavalue.com/
sudo systemctl status tommi-brain caddy --no-pager
```

Apri `https://brain.produceavalue.com` nel browser e accedi con la password impostata. Per aggiornare il codice:

```bash
cd /opt/tommi-brain
git pull --ff-only
sudo systemctl restart tommi-brain
```

I dati e i backup restano in `/var/lib`, separati dal codice. Il backup locale automatico non protegge da perdita della VPS: prepara anche una copia periodica fuori dal server.
